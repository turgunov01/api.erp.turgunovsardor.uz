// Authentication routes: login, refresh, logout, me.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { buildClaims } from '../../lib/access.js';
import { issueRefreshToken, consumeRefreshToken, revokeAllForUser } from '../../lib/tokens.js';
import { createResetToken, consumeResetToken } from '../../lib/reset.js';
import { provisionTenant } from '../../lib/provision.js';
import { findValidInvite, markInviteAccepted } from '../../lib/invites.js';
import { generateSecret, verifyTotp, otpauthURL } from '../../lib/totp.js';
import { assertWithinLimit } from '../../lib/limits.js';
import { NICHES, MODULE_CATALOG } from '../../lib/modules.js';
import { PLANS, SELECTABLE_PLAN_KEYS } from '../../lib/plans.js';
import { AppError, BadRequest, Unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // optional: tenant slug for disambiguation when the same email exists in multiple tenants
  tenant: z.string().optional(),
  mfaCode: z.string().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const strongPassword = z.string().min(8, 'Password must be at least 8 characters');
const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: strongPassword });
const forgotSchema = z.object({ email: z.string().email(), tenant: z.string().optional() });
const resetSchema = z.object({ token: z.string().min(1), newPassword: strongPassword });

const nicheKeys = NICHES.map((n) => n.key) as [string, ...string[]];
const planKeys = SELECTABLE_PLAN_KEYS as [string, ...string[]];
const billSchema = z.object({
  billLegalName: z.string().max(200).optional(),
  billInn: z.string().max(20).optional(),
  billAddress: z.string().max(300).optional(),
  billBank: z.string().max(200).optional(),
  billAccount: z.string().max(40).optional(),
  billMfo: z.string().max(20).optional(),
  billDirector: z.string().max(200).optional(),
  billPhone: z.string().max(40).optional(),
});
const registerSchema = z.object({
  companyName: z.string().min(2, 'Название компании слишком короткое').max(120),
  industry: z.enum(nicheKeys).optional(),
  fullName: z.string().min(2, 'Укажите имя').max(120),
  email: z.string().email(),
  password: strongPassword,
  plan: z.enum(planKeys).optional(),
  modules: z.array(z.string()).max(20).optional(),
  bill: billSchema.optional(),
});

// Stricter limit for credential endpoints (brute-force protection).
const authLimit = { config: { rateLimit: { max: config.AUTH_RATE_MAX, timeWindow: config.AUTH_RATE_WINDOW } } };

export default async function authRoutes(app: FastifyInstance) {
  // ---- Public onboarding metadata: drives the self-registration wizard ----
  app.get('/onboarding-meta', async () => ({
    niches: NICHES.map((n) => ({ key: n.key, label: n.label, modules: n.modules })),
    modules: MODULE_CATALOG,
    plans: PLANS.filter((p) => SELECTABLE_PLAN_KEYS.includes(p.key)),
  }));

  // ---- Self-registration: creates a new tenant + owner and logs them in ----
  app.post('/register', authLimit, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const { tenant, user } = await provisionTenant(body);

    const claims = await buildClaims(user.id);
    if (!claims) throw Unauthorized('Registration failed');
    const accessToken = app.jwt.sign(claims);
    const refreshToken = await issueRefreshToken(user.id, req.headers['user-agent'], req.ip);

    await audit({ tenantId: tenant.id, userId: user.id, action: 'auth.register', entity: 'Tenant', entityId: tenant.id, meta: { slug: tenant.slug, industry: tenant.industry }, ip: req.ip });
    return reply.code(201).send({
      accessToken,
      refreshToken,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: { id: user.id, email: user.email, fullName: user.fullName, tenantId: user.tenantId, roles: claims.roles, permissions: claims.perms, platformAdmin: claims.admin },
    });
  });

  app.post('/login', authLimit, async (req, reply) => {
    const body = loginSchema.parse(req.body);

    // Resolve user (optionally scoped by tenant slug)
    let user;
    if (body.tenant) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: body.tenant } });
      if (!tenant) throw Unauthorized('Invalid credentials');
      user = await prisma.user.findUnique({
        where: { tenantId_email: { tenantId: tenant.id, email: body.email } },
      });
    } else {
      const matches = await prisma.user.findMany({ where: { email: body.email }, take: 2 });
      if (matches.length > 1) throw BadRequest('Multiple tenants for this email; specify "tenant"', 'TENANT_REQUIRED');
      user = matches[0] ?? null;
    }

    if (!user || user.status !== 'active') throw Unauthorized('Invalid credentials');
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) throw Unauthorized('Invalid credentials');

    // Second factor
    if (user.mfaEnabled && user.mfaSecret) {
      if (!body.mfaCode) throw new AppError(401, 'MFA_REQUIRED', 'Требуется код двухфакторной аутентификации');
      if (!verifyTotp(user.mfaSecret, body.mfaCode)) throw Unauthorized('Неверный код 2FA', 'MFA_INVALID');
    }

    const claims = await buildClaims(user.id);
    if (!claims) throw Unauthorized('Invalid credentials');

    const accessToken = app.jwt.sign(claims);
    const refreshToken = await issueRefreshToken(user.id, req.headers['user-agent'], req.ip);

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', entity: 'User', entityId: user.id, ip: req.ip });

    return reply.send({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, fullName: user.fullName, tenantId: user.tenantId, roles: claims.roles, permissions: claims.perms, platformAdmin: claims.admin },
    });
  });

  app.post('/refresh', authLimit, async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    const userId = await consumeRefreshToken(body.refreshToken);
    if (!userId) throw Unauthorized('Invalid or expired refresh token');

    const claims = await buildClaims(userId);
    if (!claims) throw Unauthorized('User no longer active');

    const accessToken = app.jwt.sign(claims);
    const refreshToken = await issueRefreshToken(userId, req.headers['user-agent'], req.ip);
    return reply.send({ accessToken, refreshToken });
  });

  app.post('/logout', { preHandler: [app.authenticate] }, async (req, reply) => {
    await revokeAllForUser(req.auth.sub);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'auth.logout', entity: 'User', entityId: req.auth.sub, ip: req.ip });
    return reply.send({ ok: true });
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    return reply.send({
      user: { id: req.auth.sub, email: req.auth.email, fullName: req.auth.name, tenantId: req.auth.tid, roles: req.auth.roles, permissions: req.auth.perms, platformAdmin: req.auth.admin },
    });
  });

  // ---- Change password (authenticated) ----
  app.post('/change-password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = changeSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth.sub } });
    if (!user) throw Unauthorized('Invalid session');
    const ok = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!ok) throw BadRequest('Current password is incorrect', 'WRONG_PASSWORD');

    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
    await revokeAllForUser(user.id); // force re-login on all devices
    await audit({ tenantId: user.tenantId, userId: user.id, action: 'auth.password.change', entity: 'User', entityId: user.id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ---- Forgot password: issue a reset token (email delivery: dev logs the link) ----
  app.post('/forgot-password', authLimit, async (req, reply) => {
    const body = forgotSchema.parse(req.body);
    let user = null;
    if (body.tenant) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: body.tenant } });
      if (tenant) user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: body.email } } });
    } else {
      const matches = await prisma.user.findMany({ where: { email: body.email }, take: 2 });
      if (matches.length === 1) user = matches[0];
    }

    let devToken: string | undefined;
    if (user && user.status === 'active') {
      const raw = await createResetToken(user.id);
      const link = `${config.APP_URL}/reset?token=${raw}`;
      // TODO(Stage 9): send via email/notification service. For now, log for dev.
      req.log.info({ resetLink: link }, 'Password reset link generated');
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'auth.password.forgot', entity: 'User', entityId: user.id, ip: req.ip });
      // Dev convenience only: surface the token so the flow is usable before SMTP is wired.
      if (config.NODE_ENV !== 'production') devToken = raw;
    }
    // Always the same base response — do not reveal whether the email exists.
    return reply.send({ ok: true, message: 'If the account exists, a reset link has been sent.', devResetToken: devToken });
  });

  // ---- Reset password using a token ----
  app.post('/reset-password', authLimit, async (req, reply) => {
    const body = resetSchema.parse(req.body);
    const userId = await consumeResetToken(body.token);
    if (!userId) throw BadRequest('Invalid or expired reset token', 'INVALID_RESET_TOKEN');

    const user = await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(body.newPassword) } });
    await revokeAllForUser(userId);
    await audit({ tenantId: user.tenantId, userId, action: 'auth.password.reset', entity: 'User', entityId: userId, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ---- Accept an invitation: create the user in the tenant and log in ----
  const acceptSchema = z.object({ token: z.string().min(1), fullName: z.string().min(2), password: strongPassword });
  app.post('/accept-invite', authLimit, async (req, reply) => {
    const body = acceptSchema.parse(req.body);
    const invite = await findValidInvite(body.token);
    if (!invite) throw BadRequest('Приглашение недействительно или истекло', 'INVALID_INVITE');

    const existing = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: invite.tenantId, email: invite.email } } });
    if (existing) throw BadRequest('Пользователь с этим email уже существует', 'EMAIL_EXISTS');
    await assertWithinLimit(invite.tenantId, 'users');

    const codes = invite.roleCodes.split(',').filter(Boolean);
    const roles = await prisma.role.findMany({ where: { tenantId: invite.tenantId, code: { in: codes } } });
    const user = await prisma.user.create({
      data: {
        tenantId: invite.tenantId, email: invite.email, fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
    });
    await markInviteAccepted(invite.id);

    const claims = await buildClaims(user.id);
    if (!claims) throw Unauthorized('Accept failed');
    const accessToken = app.jwt.sign(claims);
    const refreshToken = await issueRefreshToken(user.id, req.headers['user-agent'], req.ip);
    await audit({ tenantId: invite.tenantId, userId: user.id, action: 'auth.invite.accept', entity: 'User', entityId: user.id, ip: req.ip });
    return reply.code(201).send({
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, fullName: user.fullName, tenantId: user.tenantId, roles: claims.roles, permissions: claims.perms, platformAdmin: claims.admin },
    });
  });

  // Look up an invitation by token (for the accept screen to show the email/tenant).
  app.get('/invite', async (req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw BadRequest('token required');
    const invite = await findValidInvite(token);
    if (!invite) return { valid: false };
    const tenant = await prisma.tenant.findUnique({ where: { id: invite.tenantId } });
    return { valid: true, email: invite.email, tenant: tenant?.name, roles: invite.roleCodes.split(',') };
  });

  // ---- MFA (TOTP) ----
  app.post('/mfa/setup', { preHandler: [app.authenticate] }, async (req, reply) => {
    const secret = generateSecret();
    // Store the pending secret but keep MFA disabled until confirmed.
    await prisma.user.update({ where: { id: req.auth.sub }, data: { mfaSecret: secret, mfaEnabled: false } });
    return reply.send({ secret, otpauth: otpauthURL(secret, req.auth.email) });
  });
  app.post('/mfa/enable', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth.sub } });
    if (!user?.mfaSecret) throw BadRequest('Сначала выполните настройку MFA', 'MFA_NOT_SETUP');
    if (!verifyTotp(user.mfaSecret, code)) throw BadRequest('Неверный код', 'MFA_INVALID');
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await audit({ tenantId: user.tenantId, userId: user.id, action: 'auth.mfa.enable', entity: 'User', entityId: user.id, ip: req.ip });
    return reply.send({ ok: true, mfaEnabled: true });
  });
  app.post('/mfa/disable', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth.sub } });
    if (user?.mfaEnabled && user.mfaSecret && !verifyTotp(user.mfaSecret, code)) throw BadRequest('Неверный код', 'MFA_INVALID');
    await prisma.user.update({ where: { id: req.auth.sub }, data: { mfaEnabled: false, mfaSecret: null } });
    return reply.send({ ok: true, mfaEnabled: false });
  });

  // ---- Mobile PIN ----
  app.post('/pin/set', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { pin } = z.object({ pin: z.string().regex(/^\d{4,8}$/, 'PIN — 4–8 цифр') }).parse(req.body);
    await prisma.user.update({ where: { id: req.auth.sub }, data: { pinHash: await hashPassword(pin) } });
    return reply.send({ ok: true });
  });
  app.post('/pin/clear', { preHandler: [app.authenticate] }, async (req, reply) => {
    await prisma.user.update({ where: { id: req.auth.sub }, data: { pinHash: null } });
    return reply.send({ ok: true });
  });
  // Verify a PIN to unlock the app (session already authenticated).
  app.post('/pin/verify', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { pin } = z.object({ pin: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth.sub }, select: { pinHash: true } });
    if (!user?.pinHash) return reply.send({ ok: false, noPin: true });
    const ok = await verifyPassword(pin, user.pinHash);
    return reply.send({ ok });
  });

  // ---- Sessions / devices ----
  app.get('/sessions', { preHandler: [app.authenticate] }, async (req) => {
    const now = new Date();
    const sessions = await prisma.refreshToken.findMany({
      where: { userId: req.auth.sub, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ip: true, createdAt: true },
    });
    return { sessions };
  });
  app.post('/sessions/:id/revoke', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.refreshToken.updateMany({ where: { id, userId: req.auth.sub, revokedAt: null }, data: { revokedAt: new Date() } });
    return reply.send({ ok: true });
  });
  app.post('/sessions/revoke-all', { preHandler: [app.authenticate] }, async (req, reply) => {
    await revokeAllForUser(req.auth.sub);
    return reply.send({ ok: true });
  });

  // Expose MFA/PIN status for the UI.
  app.get('/security', { preHandler: [app.authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.auth.sub }, select: { mfaEnabled: true, pinHash: true } });
    return { mfaEnabled: user?.mfaEnabled ?? false, pinSet: Boolean(user?.pinHash) };
  });
}
