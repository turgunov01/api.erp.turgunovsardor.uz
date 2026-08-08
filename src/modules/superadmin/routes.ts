// SaaS-level super-admin: cross-tenant management. Platform-admin only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePlatformAdmin } from '../../plugins/rbac.js';
import { effectiveStatus } from '../../lib/subscription.js';
import { PLANS } from '../../lib/plans.js';
import { getSellerRequisites, setSellerRequisites } from '../../lib/requisites.js';
import { createEsf, isDidoxConfigured } from '../../lib/didox.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';

export default async function superadminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', requirePlatformAdmin);

  app.get('/tenants', async () => {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, warehouses: true, products: true } } },
    });
    return {
      tenants: tenants.map((t) => ({
        id: t.id, slug: t.slug, name: t.name, industry: t.industry,
        plan: t.plan, status: t.status, subscriptionStatus: effectiveStatus(t),
        trialEndsAt: t.trialEndsAt, currentPeriodEnd: t.currentPeriodEnd,
        users: t._count.users, warehouses: t._count.warehouses, products: t._count.products,
        createdAt: t.createdAt,
      })),
    };
  });

  const patchSchema = z.object({
    status: z.enum(['active', 'suspended', 'cancelled']).optional(),
    plan: z.enum(PLANS.map((p) => p.key) as [string, ...string[]]).optional(),
    extendTrialDays: z.number().int().min(1).max(365).optional(),
  });

  app.patch('/tenants/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw NotFound('Tenant not found');

    const data: Record<string, unknown> = {};
    if (body.status) data.status = body.status;
    if (body.plan) data.plan = body.plan;
    if (body.extendTrialDays) {
      const base = tenant.trialEndsAt && tenant.trialEndsAt > new Date() ? tenant.trialEndsAt : new Date();
      data.trialEndsAt = new Date(base.getTime() + body.extendTrialDays * 24 * 60 * 60 * 1000);
      data.subscriptionStatus = 'trialing';
    }
    const updated = await prisma.tenant.update({ where: { id }, data });
    await audit({ tenantId: tenant.id, userId: req.auth.sub, action: 'superadmin.tenant.update', entity: 'Tenant', entityId: id, meta: body });
    return reply.send({ tenant: { id: updated.id, slug: updated.slug, status: updated.status, plan: updated.plan, subscriptionStatus: effectiveStatus(updated) } });
  });

  // ---- Seller (platform) requisites ----
  app.get('/requisites', async () => ({ requisites: await getSellerRequisites(), didoxConfigured: isDidoxConfigured() }));

  const reqSchema = z.object({
    sellerName: z.string().max(200).optional(), sellerInn: z.string().max(20).optional(),
    address: z.string().max(300).optional(), bank: z.string().max(200).optional(),
    account: z.string().max(40).optional(), mfo: z.string().max(20).optional(),
    director: z.string().max(200).optional(), phone: z.string().max(40).optional(),
    email: z.string().max(120).optional(), vatPercent: z.number().int().min(0).max(100).optional(),
  });
  app.patch('/requisites', async (req, reply) => {
    const patch = reqSchema.parse(req.body);
    const requisites = await setSellerRequisites(patch);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'superadmin.requisites.update', entity: 'PlatformConfig', meta: patch });
    return reply.send({ requisites });
  });

  // ---- Invoices awaiting confirmation (bank transfer) ----
  app.get('/invoices', async (req) => {
    const { status } = req.query as { status?: string };
    const invoices = await prisma.invoice.findMany({
      where: { ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { tenant: { select: { name: true, slug: true } } },
    });
    return { invoices: invoices.map((i) => ({
      id: i.id, number: i.number, tenant: i.tenant.name, slug: i.tenant.slug,
      plan: i.plan, method: i.method, amountMinor: i.amountMinor, currency: i.currency,
      status: i.status, didoxId: i.didoxId, createdAt: i.createdAt,
    }))};
  });

  // Confirm bank-transfer payment received -> activate the tenant subscription.
  app.post('/invoices/:id/mark-paid', async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) throw NotFound('Invoice not found');
    if (invoice.status === 'paid') throw BadRequest('Счёт уже оплачён');

    await prisma.$transaction([
      prisma.payment.create({ data: { tenantId: invoice.tenantId, invoiceId: invoice.id, amountMinor: invoice.amountMinor, currency: invoice.currency, method: 'bank_transfer', status: 'succeeded', providerRef: 'manual_confirm' } }),
      prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'paid', paidAt: new Date(), paidBy: req.auth.sub } }),
      prisma.tenant.update({ where: { id: invoice.tenantId }, data: { plan: invoice.plan, subscriptionStatus: 'active', currentPeriodEnd: invoice.periodEnd } }),
    ]);
    await audit({ tenantId: invoice.tenantId, userId: req.auth.sub, action: 'billing.confirm', entity: 'Invoice', entityId: invoice.id, meta: { number: invoice.number } });
    return reply.send({ ok: true, status: 'active' });
  });

  // Create an official ЭСФ in Didox (stub until credentials are configured).
  app.post('/invoices/:id/didox', async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: { tenant: true } });
    if (!invoice) throw NotFound('Invoice not found');
    const res = await createEsf({
      invoiceNumber: invoice.number, amountMinor: Number(invoice.amountMinor), vatMinor: Number(invoice.vatMinor),
      buyerInn: invoice.tenant.billInn ?? '', buyerName: invoice.tenant.billLegalName ?? invoice.tenant.name,
    });
    await prisma.invoice.update({ where: { id }, data: { didoxId: res.didoxId, didoxStatus: res.status } });
    return reply.send({ ok: true, didoxId: res.didoxId });
  });
}
