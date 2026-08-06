// Provision a brand-new tenant on self-registration: tenant + roles + owner user
// + default company/warehouse/units + enabled modules for the chosen niche.
import { prisma } from '../db.js';
import { hashPassword } from './password.js';
import { PERMISSIONS, DEFAULT_ROLES } from './permissions.js';
import { ALL_MODULE_KEYS, AVAILABLE_MODULE_KEYS, nicheModules } from './modules.js';
import { TRIAL_DAYS, getPlan, SELECTABLE_PLAN_KEYS } from './plans.js';
import { BadRequest } from './errors.js';

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'company';
}

async function uniqueSlug(desired: string): Promise<string> {
  let slug = desired;
  let n = 1;
  // Try suffixes until free.
  while (await prisma.tenant.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${desired}-${n}`;
  }
  return slug;
}

export interface BillingRequisites {
  billLegalName?: string;
  billInn?: string;
  billAddress?: string;
  billBank?: string;
  billAccount?: string;
  billMfo?: string;
  billDirector?: string;
  billPhone?: string;
}

export interface ProvisionInput {
  companyName: string;
  industry?: string;
  fullName: string;
  email: string;
  password: string;
  plan?: string;          // selected during onboarding (starter | business | enterprise)
  modules?: string[];     // explicit module selection from the wizard (overrides niche preset)
  bill?: BillingRequisites; // optional company legal/billing details captured at signup
}

// Decide which business modules a new tenant gets: an explicit wizard selection wins,
// otherwise fall back to the niche preset. Always narrowed to currently-available modules.
function resolveSelectedModules(input: ProvisionInput): string[] {
  const source = input.modules && input.modules.length ? input.modules : nicheModules(input.industry);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of source) {
    if (AVAILABLE_MODULE_KEYS.includes(key) && !seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}

export async function provisionTenant(input: ProvisionInput) {
  // Ensure the global permission catalog exists (safe on a fresh install).
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      create: { code: p.code, module: p.module, description: p.description },
      update: { module: p.module, description: p.description },
    });
  }
  const permByCode = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));

  const slug = await uniqueSlug(slugify(input.companyName));

  // Resolve the chosen plan (defaults to trial) and enforce its module quota.
  const planKey = input.plan && SELECTABLE_PLAN_KEYS.includes(input.plan) ? input.plan : 'trial';
  const plan = getPlan(planKey);
  const selectedModules = resolveSelectedModules(input);
  if (plan.maxModules != null && selectedModules.length > plan.maxModules) {
    throw BadRequest(
      `Тариф «${plan.name}» позволяет включить не более ${plan.maxModules} ${plan.maxModules === 1 ? 'модуля' : 'модулей'}`,
      'PLAN_MODULE_LIMIT',
    );
  }

  const b = input.bill ?? {};
  const tenant = await prisma.tenant.create({
    data: {
      slug,
      name: input.companyName,
      industry: input.industry ?? null,
      plan: planKey,
      status: 'active',
      subscriptionStatus: 'trialing',
      trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
      billLegalName: b.billLegalName || null,
      billInn: b.billInn || null,
      billAddress: b.billAddress || null,
      billBank: b.billBank || null,
      billAccount: b.billAccount || null,
      billMfo: b.billMfo || null,
      billDirector: b.billDirector || null,
      billPhone: b.billPhone || null,
    },
  });

  // Roles + permissions
  const roleByCode = new Map<string, string>();
  for (const r of DEFAULT_ROLES) {
    const role = await prisma.role.create({
      data: { tenantId: tenant.id, code: r.code, name: r.name, description: r.description, isSystem: true },
    });
    roleByCode.set(r.code, role.id);
    await prisma.rolePermission.createMany({
      data: r.permissions.map((code) => ({ roleId: role.id, permissionId: permByCode.get(code)! })),
    });
  }

  // Owner user
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: input.email,
      fullName: input.fullName,
      passwordHash: await hashPassword(input.password),
      roles: { create: [{ roleId: roleByCode.get('owner')! }] },
    },
  });

  // Default company + warehouse + base units
  const company = await prisma.company.create({
    data: { tenantId: tenant.id, code: 'MAIN', name: input.companyName, currency: 'UZS' },
  });
  await prisma.warehouse.create({
    data: { tenantId: tenant.id, companyId: company.id, code: 'WH-MAIN', name: 'Основной склад' },
  });
  await prisma.unit.createMany({
    data: [
      { tenantId: tenant.id, code: 'pcs', name: 'Штука', precision: 0 },
      { tenantId: tenant.id, code: 'kg', name: 'Килограмм', precision: 3 },
      { tenantId: tenant.id, code: 'm', name: 'Метр', precision: 2 },
      { tenantId: tenant.id, code: 'l', name: 'Литр', precision: 2 },
    ],
  });

  // Enable exactly the modules the company picked in the wizard (already narrowed to
  // available + capped by the plan quota above). A row is stored for every module so
  // "coming soon" ones surface in settings and can be toggled later.
  const chosen = new Set(selectedModules);
  await prisma.tenantModule.createMany({
    data: ALL_MODULE_KEYS.map((key) => ({
      tenantId: tenant.id,
      moduleKey: key,
      enabled: chosen.has(key),
    })),
  });

  return { tenant, user };
}
