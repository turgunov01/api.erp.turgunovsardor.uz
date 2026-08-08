// Billing: plans, subscription, requisites, official invoice (bank transfer) + card (sandbox).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { PLANS, getPlan, PAID_PLAN_KEYS, PERIOD_DAYS, ANNUAL_MONTHS, PERIOD_DAYS_ANNUAL } from '../../lib/plans.js';
import { effectiveStatus, daysLeft } from '../../lib/subscription.js';
import { charge, type CardProvider } from '../../lib/payments.js';
import { getSellerRequisites, vatBreakdown } from '../../lib/requisites.js';
import { renderInvoiceDoc } from '../../lib/invoiceDoc.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';

async function nextInvoiceNumber(): Promise<string> {
  const count = await prisma.invoice.count();
  const year = new Date().getFullYear();
  return `TTR-${year}-${String(count + 1).padStart(4, '0')}`;
}

export default async function billingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/plans', async () => ({ plans: PLANS }));

  // Seller requisites (shown to buyers for bank-transfer payment)
  app.get('/requisites', async () => ({ requisites: await getSellerRequisites() }));

  // Buyer billing/legal requisites (needed for an official invoice)
  app.get('/details', async (req) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.auth.tid } });
    if (!t) throw NotFound('Tenant not found');
    return { details: {
      legalName: t.billLegalName, inn: t.billInn, address: t.billAddress, bank: t.billBank,
      account: t.billAccount, mfo: t.billMfo, director: t.billDirector, phone: t.billPhone,
    }};
  });

  const detailsSchema = z.object({
    legalName: z.string().max(200).optional().nullable(),
    inn: z.string().max(20).optional().nullable(),
    address: z.string().max(300).optional().nullable(),
    bank: z.string().max(200).optional().nullable(),
    account: z.string().max(40).optional().nullable(),
    mfo: z.string().max(20).optional().nullable(),
    director: z.string().max(200).optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
  });
  app.patch('/details', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const b = detailsSchema.parse(req.body);
    await prisma.tenant.update({ where: { id: req.auth.tid }, data: {
      billLegalName: b.legalName ?? null, billInn: b.inn ?? null, billAddress: b.address ?? null,
      billBank: b.bank ?? null, billAccount: b.account ?? null, billMfo: b.mfo ?? null,
      billDirector: b.director ?? null, billPhone: b.phone ?? null,
    }});
    return reply.send({ ok: true });
  });

  app.get('/subscription', async (req) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.auth.tid } });
    if (!t) throw NotFound('Tenant not found');
    const plan = getPlan(t.plan);
    const [users, warehouses, products] = await Promise.all([
      prisma.user.count({ where: { tenantId: t.id } }),
      prisma.warehouse.count({ where: { tenantId: t.id } }),
      prisma.product.count({ where: { tenantId: t.id } }),
    ]);
    return {
      plan: plan.key, planName: plan.name, status: effectiveStatus(t),
      trialEndsAt: t.trialEndsAt, trialDaysLeft: daysLeft(t.trialEndsAt), currentPeriodEnd: t.currentPeriodEnd,
      billingCycle: t.billingCycle, extraSeats: t.extraSeats, perUserMinor: plan.perUserMinor ?? 0,
      limits: { maxUsers: plan.maxUsers === null ? null : plan.maxUsers + (t.extraSeats ?? 0), maxWarehouses: plan.maxWarehouses, maxProducts: plan.maxProducts },
      usage: { users, warehouses, products },
    };
  });

  // Create an open invoice for a paid plan. method: bank_transfer (official) | card (online).
  const subscribeSchema = z.object({
    plan: z.enum(['starter', 'business', 'production']),
    method: z.enum(['bank_transfer', 'card']).default('bank_transfer'),
    cycle: z.enum(['monthly', 'annual']).default('monthly'),
    seats: z.number().int().min(0).max(500).default(0), // extra paid users above the plan's included
  });
  app.post('/subscribe', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { plan: planKey, method, cycle, seats } = subscribeSchema.parse(req.body);
    if (!PAID_PLAN_KEYS.includes(planKey)) throw BadRequest('Этот тариф нельзя оформить онлайн');
    const plan = getPlan(planKey);
    const seller = await getSellerRequisites();
    const months = cycle === 'annual' ? ANNUAL_MONTHS : 1; // annual = 10 months (2 free)
    const monthlyBase = (plan.priceMinor ?? 0) + seats * (plan.perUserMinor ?? 0);
    const total = monthlyBase * months;
    const { vatMinor } = vatBreakdown(total, seller.vatPercent);
    const now = new Date();
    const days = cycle === 'annual' ? PERIOD_DAYS_ANNUAL : PERIOD_DAYS;
    const periodEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const invoice = await prisma.invoice.create({
      data: { tenantId: req.auth.tid, number: await nextInvoiceNumber(), plan: planKey, method, cycle, seats, amountMinor: BigInt(total), vatMinor: BigInt(vatMinor), currency: plan.currency, status: 'open', periodStart: now, periodEnd },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'billing.invoice.create', entity: 'Invoice', entityId: invoice.id, meta: { plan: planKey, method, cycle, seats, amountMinor: total } });
    return reply.code(201).send({ invoice });
  });

  // Printable official invoice document (счёт на оплату) for bank transfer.
  app.get('/invoices/:id/document', async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await prisma.invoice.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!invoice) throw NotFound('Invoice not found');
    const [tenant, seller] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: req.auth.tid } }),
      getSellerRequisites(),
    ]);
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(renderInvoiceDoc(invoice, tenant!, seller));
  });

  // Pay an invoice by card (sandbox). On success -> activate.
  const paySchema = z.object({ invoiceId: z.string().min(1), method: z.enum(['card', 'mock', 'payme', 'click', 'stripe']).default('card') });
  app.post('/pay', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { invoiceId, method } = paySchema.parse(req.body);
    const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId: req.auth.tid } });
    if (!invoice) throw NotFound('Invoice not found');
    if (invoice.status === 'paid') throw BadRequest('Счёт уже оплачён');

    const result = await charge({ amountMinor: Number(invoice.amountMinor), currency: invoice.currency, method: method as CardProvider, description: `TTR ONE ${invoice.plan}` });
    await prisma.$transaction([
      prisma.payment.create({ data: { tenantId: req.auth.tid, invoiceId: invoice.id, amountMinor: invoice.amountMinor, currency: invoice.currency, method, status: result.status, providerRef: result.providerRef } }),
      prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'paid', paidAt: new Date() } }),
      prisma.tenant.update({ where: { id: req.auth.tid }, data: { plan: invoice.plan, subscriptionStatus: 'active', currentPeriodEnd: invoice.periodEnd, extraSeats: invoice.seats, billingCycle: invoice.cycle } }),
    ]);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'billing.payment', entity: 'Payment', entityId: invoice.id, meta: { method, plan: invoice.plan } });
    return reply.send({ ok: true, plan: invoice.plan, status: 'active', currentPeriodEnd: invoice.periodEnd });
  });

  app.get('/invoices', async (req) => {
    const invoices = await prisma.invoice.findMany({ where: { tenantId: req.auth.tid }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { invoices };
  });
}
