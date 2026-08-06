// Tenant settings + module configuration (the "WordPress plugins" surface).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { MODULE_CATALOG, CORE_MODULES, AVAILABLE_MODULE_KEYS } from '../../lib/modules.js';
import { effectiveStatus } from '../../lib/subscription.js';
import { getPlan } from '../../lib/plans.js';

export default async function tenantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // Any authenticated tenant user can read settings (nav needs enabled modules).
  app.get('/settings', async (req) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.auth.tid } });
    if (!tenant) throw NotFound('Tenant not found');
    const rows = await prisma.tenantModule.findMany({ where: { tenantId: tenant.id } });
    const enabledByKey = new Map(rows.map((r) => [r.moduleKey, r.enabled]));

    const modules = MODULE_CATALOG.map((m) => ({
      key: m.key,
      name: m.name,
      description: m.description,
      status: m.status,
      icon: m.icon,
      enabled: enabledByKey.get(m.key) ?? false,
    }));

    return {
      tenant: {
        id: tenant.id, slug: tenant.slug, name: tenant.name, industry: tenant.industry,
        plan: tenant.plan, status: tenant.status, subscriptionStatus: effectiveStatus(tenant),
        brandName: tenant.brandName, brandColor: tenant.brandColor,
      },
      core: CORE_MODULES,
      modules,
    };
  });

  // White-label branding (owner / tenant.manage).
  const brandingSchema = z.object({
    brandName: z.string().max(60).optional().nullable(),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB').optional().nullable(),
  });
  app.patch('/branding', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const body = brandingSchema.parse(req.body);
    const tenant = await prisma.tenant.update({
      where: { id: req.auth.tid },
      data: { brandName: body.brandName ?? null, brandColor: body.brandColor ?? null },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'tenant.branding.update', entity: 'Tenant', entityId: tenant.id, meta: body });
    return reply.send({ ok: true, brandName: tenant.brandName, brandColor: tenant.brandColor });
  });

  // Toggle a module (owner / tenant.manage). Only "available" modules can be enabled.
  const patchSchema = z.object({ enabled: z.boolean() });
  app.patch('/modules/:key', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const { enabled } = patchSchema.parse(req.body);
    const def = MODULE_CATALOG.find((m) => m.key === key);
    if (!def) throw NotFound('Unknown module');
    if (enabled && def.status !== 'available') throw BadRequest('Модуль скоро будет доступен', 'MODULE_NOT_AVAILABLE');

    // Enforce the plan's module quota when turning a module ON.
    if (enabled) {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.auth.tid } });
      const plan = getPlan(tenant?.plan);
      if (plan.maxModules != null) {
        const rows = await prisma.tenantModule.findMany({ where: { tenantId: req.auth.tid, enabled: true } });
        const enabledAvailable = new Set(
          rows.map((r) => r.moduleKey).filter((k) => AVAILABLE_MODULE_KEYS.includes(k)),
        );
        enabledAvailable.add(key); // the one we're about to enable
        if (enabledAvailable.size > plan.maxModules) {
          throw BadRequest(
            `Тариф «${plan.name}» позволяет включить не более ${plan.maxModules} ${plan.maxModules === 1 ? 'модуля' : 'модулей'}. Обновите тариф, чтобы добавить больше.`,
            'PLAN_MODULE_LIMIT',
          );
        }
      }
    }

    await prisma.tenantModule.upsert({
      where: { tenantId_moduleKey: { tenantId: req.auth.tid, moduleKey: key } },
      create: { tenantId: req.auth.tid, moduleKey: key, enabled },
      update: { enabled },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'tenant.module.toggle', entity: 'TenantModule', entityId: key, meta: { enabled }, ip: req.ip });
    return reply.send({ ok: true, key, enabled });
  });
}
