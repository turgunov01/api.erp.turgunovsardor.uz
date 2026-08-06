// One-off: wipe all demo/business data + all users, then re-provision ONE clean tenant
// for a real client, preserving the admin login. See conversation 2026-08-01.
import 'dotenv/config';
import { prisma } from '../src/db.js';
import { provisionTenant } from '../src/lib/provision.js';
import { AVAILABLE_MODULE_KEYS } from '../src/lib/modules.js';

const ADMIN_EMAIL = 'admin@demo-factory.com';
const ADMIN_PASSWORD = 'Admin123!';
const ADMIN_NAME = 'Администратор';
const COMPANY_NAME = 'Demo Factory'; // slug -> demo-factory (keeps admin login identical); rename in Settings later

async function main() {
  console.log('=== BEFORE ===');
  const tenantsBefore = await prisma.tenant.findMany({ select: { slug: true, name: true } });
  console.log('tenants:', tenantsBefore.map((t) => t.slug).join(', ') || '(none)');
  console.log('users:', await prisma.user.count(), '| customerUsers:', await prisma.customerUser.count(), '| products:', await prisma.product.count());

  // 1) Delete every tenant → cascades ALL tenant-scoped data (products, orders, stock,
  //    finance, HR, POS, projects, logistics, docs) AND all Users + CustomerUsers.
  const del = await prisma.tenant.deleteMany({});
  console.log(`\nDeleted ${del.count} tenant(s) (cascaded all business data + all users).`);

  // 2) NumberSequence has no tenant FK (composite PK), so it does NOT cascade — clear it.
  const seq = await prisma.numberSequence.deleteMany({});
  console.log(`Cleared ${seq.count} number sequence row(s).`);

  // 3) Re-provision one clean tenant with the admin as owner + all available modules on.
  const { tenant, user } = await provisionTenant({
    companyName: COMPANY_NAME,
    industry: null ?? undefined,
    fullName: ADMIN_NAME,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    plan: 'enterprise', // no module cap
    modules: [...AVAILABLE_MODULE_KEYS], // enable every available module for the client
  });

  // 4) Preserve full super-admin access + put the tenant on an active (non-trial) footing.
  await prisma.user.update({ where: { id: user.id }, data: { platformAdmin: true } });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      subscriptionStatus: 'active',
      trialEndsAt: null,
      currentPeriodEnd: new Date('2035-01-01T00:00:00.000Z'),
    },
  });

  console.log('\n=== AFTER ===');
  const enabled = await prisma.tenantModule.count({ where: { tenantId: tenant.id, enabled: true } });
  console.log('tenant:', tenant.slug, '| plan:', 'enterprise/active');
  console.log('admin:', user.email, '(platformAdmin) | password unchanged');
  console.log('users:', await prisma.user.count(), '| products:', await prisma.product.count(), '| enabled modules:', enabled);
  console.log('\n✅ Clean system ready for the client.');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('RESET FAILED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
