// Finance & accounting (Stage 8). Groups four capabilities behind /api/v1/finance:
//   8.1 cash/bank accounts + cash transactions (receipts/payments/expenses)
//   8.2 inventory costing settings + valuation report (see lib/costing.ts)
//   8.3 chart of accounts + accounting periods + immutable journal (see lib/ledger.ts)
//   8.4 auto-postings are wired via events (see modules/finance/postings.ts)
// Money is integer minor units (BigInt for accounting totals).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { ensureChart, postEntry, reverseEntry, nextDocNumber, DEFAULT_CHART } from '../../lib/ledger.js';
import { VAT_ACCOUNTS } from '../../lib/vat.js';
import { recordCashTx, counterCode, ledgerCodeForKind } from '../../lib/cash.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);
const VAT_OUTPUT = VAT_ACCOUNTS.output;
const VAT_INPUT = VAT_ACCOUNTS.input;

export default async function financeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ==================== 8.2 / 8.5 SETTINGS (costing method + VAT) ====================
  app.get('/settings', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.auth.tid }, select: { costingMethod: true, vatEnabled: true, vatRatePct: true } });
    return { costingMethod: t?.costingMethod ?? 'avg', vatEnabled: !!t?.vatEnabled, vatRatePct: t?.vatRatePct ?? 12 };
  });

  app.patch('/settings', { preHandler: [requirePermission('finance.accounting')] }, async (req) => {
    const body = z.object({
      costingMethod: z.enum(['avg', 'fifo']).optional(),
      vatEnabled: z.boolean().optional(),
      vatRatePct: z.number().int().min(0).max(100).optional(),
    }).parse(req.body);
    const data: Record<string, unknown> = {};
    if (body.costingMethod !== undefined) data.costingMethod = body.costingMethod;
    if (body.vatEnabled !== undefined) data.vatEnabled = body.vatEnabled;
    if (body.vatRatePct !== undefined) data.vatRatePct = body.vatRatePct;
    const t = await prisma.tenant.update({ where: { id: req.auth.tid }, data });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.settings.update', entity: 'Tenant', entityId: req.auth.tid, meta: body, ip: req.ip });
    return { costingMethod: t.costingMethod, vatEnabled: t.vatEnabled, vatRatePct: t.vatRatePct };
  });

  // ==================== 8.1 CASH / BANK ACCOUNTS ====================
  app.get('/accounts', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const accounts = await prisma.finAccount.findMany({ where: { tenantId: req.auth.tid }, orderBy: { createdAt: 'asc' } });
    const totalMinor = accounts.filter((a) => a.status === 'active').reduce((s, a) => s + a.balanceMinor, 0n);
    return { accounts, totalMinor };
  });

  app.get('/accounts/:id', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const account = await prisma.finAccount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!account) throw NotFound('Счёт не найден');
    const transactions = await prisma.cashTransaction.findMany({ where: { tenantId: req.auth.tid, accountId: id }, orderBy: { date: 'desc' }, take: 50 });
    return { account, transactions };
  });

  app.post('/accounts', { preHandler: [requirePermission('finance.write')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1),
      kind: z.enum(['cash', 'bank', 'card']).default('cash'),
      currency: z.string().default('UZS'),
      accountNo: z.string().optional(),
      openingMinor: z.number().int().min(0).default(0),
    }).parse(req.body);

    const ledgerCode = ledgerCodeForKind(body.kind);
    const opening = BigInt(body.openingMinor);
    const account = await prisma.$transaction(async (tx) => {
      const acc = await tx.finAccount.create({
        data: {
          tenantId: req.auth.tid, name: body.name, kind: body.kind, currency: body.currency,
          accountNo: body.accountNo ?? null, ledgerCode, openingMinor: opening, balanceMinor: opening,
        },
      });
      // Opening balance -> a cash transaction + Dr cash / Cr capital posting.
      if (opening > 0n) {
        await ensureChart(tx, req.auth.tid);
        const posted = await postEntry(tx, {
          tenantId: req.auth.tid, date: new Date(), memo: `Начальный остаток: ${body.name}`, source: 'cash',
          refType: 'FinAccount', refId: acc.id, userId: req.auth.sub,
          lines: [
            { accountCode: ledgerCode, debitMinor: opening, description: 'Начальный остаток' },
            { accountCode: '3010', creditMinor: opening, description: 'Капитал' },
          ],
        });
        const number = await nextDocNumber(tx, req.auth.tid, 'cash_tx', 'CT');
        await tx.cashTransaction.create({
          data: {
            tenantId: req.auth.tid, accountId: acc.id, number, direction: 'in', category: 'opening',
            amountMinor: opening, currency: body.currency, counterparty: null, note: 'Начальный остаток',
            journalEntryId: posted.id, balanceAfter: opening, createdBy: req.auth.sub,
          },
        });
      }
      return acc;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.account.create', entity: 'FinAccount', entityId: account.id, meta: { name: body.name, kind: body.kind }, ip: req.ip });
    return reply.code(201).send({ account });
  });

  app.patch('/accounts/:id', { preHandler: [requirePermission('finance.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), accountNo: z.string().optional(), status: z.enum(['active', 'archived']).optional() }).parse(req.body);
    const acc = await prisma.finAccount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!acc) throw NotFound('Счёт не найден');
    const updated = await prisma.finAccount.update({ where: { id }, data: body });
    return { account: updated };
  });

  // ==================== 8.1 CASH TRANSACTIONS ====================
  app.get('/transactions', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { accountId, direction } = req.query as { accountId?: string; direction?: string };
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, ...(accountId ? { accountId } : {}), ...(direction ? { direction } : {}) };
    const [transactions, total] = await prisma.$transaction([
      prisma.cashTransaction.findMany({ where, orderBy: { date: 'desc' }, include: { account: { select: { name: true } } }, ...skipTake(q) }),
      prisma.cashTransaction.count({ where }),
    ]);
    return { transactions, meta: pageMeta(q, total) };
  });

  // Record a receipt (in) / payment or expense (out). Updates the account balance
  // and posts a balanced journal entry (Dr/Cr cash vs the mapped counter account).
  app.post('/transactions', { preHandler: [requirePermission('finance.write')] }, async (req, reply) => {
    const body = z.object({
      accountId: z.string(),
      direction: z.enum(['in', 'out']),
      category: z.enum(['sale', 'purchase', 'salary', 'vat', 'tax', 'rent', 'utility', 'other', 'refund']).default('other'),
      amountMinor: z.number().int().positive(),
      date: z.string().optional(),
      counterparty: z.string().optional(),
      note: z.string().optional(),
      refType: z.string().optional(),
      refId: z.string().optional(),
    }).parse(req.body);

    const acc = await prisma.finAccount.findFirst({ where: { id: body.accountId, tenantId: req.auth.tid } });
    if (!acc) throw NotFound('Счёт не найден');
    if (acc.status !== 'active') throw BadRequest('Счёт архивирован', 'ACCOUNT_ARCHIVED');
    const amount = BigInt(body.amountMinor);
    if (body.direction === 'out' && acc.balanceMinor < amount) throw BadRequest('Недостаточно средств на счёте', 'INSUFFICIENT_FUNDS');
    const when = body.date ? new Date(body.date) : new Date();

    const result = await prisma.$transaction(async (tx) => {
      await ensureChart(tx, req.auth.tid);
      const cash = acc.ledgerCode;
      const counter = counterCode(body.direction, body.category);
      const lines = body.direction === 'in'
        ? [{ accountCode: cash, debitMinor: amount, description: body.note ?? undefined }, { accountCode: counter, creditMinor: amount }]
        : [{ accountCode: counter, debitMinor: amount, description: body.note ?? undefined }, { accountCode: cash, creditMinor: amount }];
      const posted = await postEntry(tx, {
        tenantId: req.auth.tid, date: when, source: 'cash', refType: 'CashTransaction', userId: req.auth.sub,
        memo: `${body.direction === 'in' ? 'Поступление' : 'Расход'}: ${body.counterparty ?? body.category}`,
        lines,
      });
      const newBalance = body.direction === 'in' ? acc.balanceMinor + amount : acc.balanceMinor - amount;
      const number = await nextDocNumber(tx, req.auth.tid, 'cash_tx', 'CT');
      const trx = await tx.cashTransaction.create({
        data: {
          tenantId: req.auth.tid, accountId: acc.id, number, direction: body.direction, category: body.category,
          amountMinor: amount, currency: acc.currency, date: when, counterparty: body.counterparty ?? null,
          refType: body.refType ?? null, refId: body.refId ?? null, note: body.note ?? null,
          journalEntryId: posted.id, balanceAfter: newBalance, createdBy: req.auth.sub,
        },
      });
      await tx.finAccount.update({ where: { id: acc.id }, data: { balanceMinor: newBalance } });
      // Link the posting back to this transaction now that we have its id.
      await tx.journalEntry.update({ where: { id: posted.id }, data: { refId: trx.id } });
      return trx;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.transaction.create', entity: 'CashTransaction', entityId: result.id, meta: { direction: body.direction, category: body.category, amountMinor: body.amountMinor }, ip: req.ip });
    return reply.code(201).send({ transaction: result });
  });

  // ==================== 8.3 CHART OF ACCOUNTS ====================
  app.get('/chart', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    let accounts = await prisma.ledgerAccount.findMany({ where: { tenantId: req.auth.tid }, orderBy: { code: 'asc' } });
    if (accounts.length === 0) {
      await prisma.$transaction((tx) => ensureChart(tx, req.auth.tid));
      accounts = await prisma.ledgerAccount.findMany({ where: { tenantId: req.auth.tid }, orderBy: { code: 'asc' } });
    }
    return { accounts };
  });

  app.post('/chart', { preHandler: [requirePermission('finance.accounting')] }, async (req, reply) => {
    const body = z.object({ code: z.string().min(1), name: z.string().min(1), type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']) }).parse(req.body);
    const account = await prisma.ledgerAccount.create({ data: { tenantId: req.auth.tid, code: body.code, name: body.name, type: body.type, isSystem: false } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.chart.create', entity: 'LedgerAccount', entityId: account.id, meta: { code: body.code }, ip: req.ip });
    return reply.code(201).send({ account });
  });

  app.patch('/chart/:id', { preHandler: [requirePermission('finance.accounting')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), status: z.enum(['active', 'archived']).optional() }).parse(req.body);
    const acc = await prisma.ledgerAccount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!acc) throw NotFound('Счёт плана не найден');
    if (acc.isSystem && body.status === 'archived') throw BadRequest('Системный счёт нельзя архивировать', 'SYSTEM_ACCOUNT');
    const updated = await prisma.ledgerAccount.update({ where: { id }, data: body });
    return { account: updated };
  });

  // ==================== 8.3 ACCOUNTING PERIODS ====================
  app.get('/periods', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const periods = await prisma.accountingPeriod.findMany({ where: { tenantId: req.auth.tid }, orderBy: { code: 'desc' } });
    return { periods };
  });

  app.post('/periods/:id/close', { preHandler: [requirePermission('finance.accounting')] }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.accountingPeriod.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!p) throw NotFound('Период не найден');
    if (p.status === 'closed') throw BadRequest('Период уже закрыт', 'ALREADY_CLOSED');
    const updated = await prisma.accountingPeriod.update({ where: { id }, data: { status: 'closed', closedAt: new Date(), closedBy: req.auth.sub } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.period.close', entity: 'AccountingPeriod', entityId: id, meta: { code: p.code }, ip: req.ip });
    return { period: updated };
  });

  app.post('/periods/:id/reopen', { preHandler: [requirePermission('finance.accounting')] }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.accountingPeriod.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!p) throw NotFound('Период не найден');
    if (p.status === 'open') throw BadRequest('Период уже открыт', 'ALREADY_OPEN');
    const updated = await prisma.accountingPeriod.update({ where: { id }, data: { status: 'open', closedAt: null, closedBy: null } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.period.reopen', entity: 'AccountingPeriod', entityId: id, meta: { code: p.code }, ip: req.ip });
    return { period: updated };
  });

  // ==================== 8.3 JOURNAL (immutable entries) ====================
  app.get('/journal', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { source, from, to } = req.query as { source?: string; from?: string; to?: string };
    const q = pageQuery.parse(req.query);
    const where: Prisma.JournalEntryWhereInput = {
      tenantId: req.auth.tid,
      ...(source ? { source } : {}),
      ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    };
    const [entries, total] = await prisma.$transaction([
      prisma.journalEntry.findMany({ where, orderBy: { date: 'desc' }, include: { _count: { select: { lines: true } } }, ...skipTake(q) }),
      prisma.journalEntry.count({ where }),
    ]);
    return { entries, meta: pageMeta(q, total) };
  });

  app.get('/journal/:id', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const entry = await prisma.journalEntry.findFirst({ where: { id, tenantId: req.auth.tid }, include: { lines: true, period: { select: { code: true, status: true } } } });
    if (!entry) throw NotFound('Проводка не найдена');
    return { entry };
  });

  // Manual journal entry (8.3). Balanced debit/credit lines; immutable once posted.
  app.post('/journal', { preHandler: [requirePermission('finance.accounting')] }, async (req, reply) => {
    const body = z.object({
      date: z.string().optional(),
      memo: z.string().optional(),
      lines: z.array(z.object({
        accountCode: z.string().min(1),
        debitMinor: z.number().int().min(0).default(0),
        creditMinor: z.number().int().min(0).default(0),
        description: z.string().optional(),
      })).min(2),
    }).parse(req.body);
    const when = body.date ? new Date(body.date) : new Date();
    const posted = await prisma.$transaction(async (tx) => {
      await ensureChart(tx, req.auth.tid);
      return postEntry(tx, {
        tenantId: req.auth.tid, date: when, memo: body.memo ?? null, source: 'manual', userId: req.auth.sub,
        lines: body.lines.map((l) => ({ accountCode: l.accountCode, debitMinor: BigInt(l.debitMinor), creditMinor: BigInt(l.creditMinor), description: l.description })),
      });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.journal.post', entity: 'JournalEntry', entityId: posted.id, meta: { number: posted.number }, ip: req.ip });
    return reply.code(201).send({ entry: posted });
  });

  app.post('/journal/:id/reverse', { preHandler: [requirePermission('finance.accounting')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const reversal = await prisma.$transaction((tx) => reverseEntry(tx, req.auth.tid, id, req.auth.sub));
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.journal.reverse', entity: 'JournalEntry', entityId: id, meta: { reversal: reversal.number }, ip: req.ip });
    return reply.code(201).send({ reversal });
  });

  // ==================== 8.3 REPORTS ====================
  // Trial balance: net debit/credit per account as of a date.
  app.get('/reports/trial-balance', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { asOf } = req.query as { asOf?: string };
    const accounts = await prisma.ledgerAccount.findMany({ where: { tenantId: req.auth.tid }, orderBy: { code: 'asc' } });
    const typeByCode = new Map(accounts.map((a) => [a.code, a.type]));
    const nameByCode = new Map(accounts.map((a) => [a.code, a.name]));
    const lines = await prisma.journalLine.findMany({
      where: { entry: { tenantId: req.auth.tid, status: 'posted', ...(asOf ? { date: { lte: new Date(asOf) } } : {}) } },
      select: { accountCode: true, debitMinor: true, creditMinor: true },
    });
    const agg = new Map<string, { debit: bigint; credit: bigint }>();
    for (const l of lines) {
      const cur = agg.get(l.accountCode) ?? { debit: 0n, credit: 0n };
      cur.debit += l.debitMinor; cur.credit += l.creditMinor;
      agg.set(l.accountCode, cur);
    }
    const rows = [...agg.entries()].map(([code, v]) => {
      const type = typeByCode.get(code) ?? 'asset';
      const net = v.debit - v.credit; // positive = net debit, negative = net credit
      return { code, name: nameByCode.get(code) ?? code, type, debitMinor: net > 0n ? net : 0n, creditMinor: net < 0n ? -net : 0n };
    }).sort((a, b) => a.code.localeCompare(b.code));
    const totalDebit = rows.reduce((s, r) => s + r.debitMinor, 0n);
    const totalCredit = rows.reduce((s, r) => s + r.creditMinor, 0n);
    return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  });

  // Profit & loss for a date range: income (credit-debit) − expenses (debit-credit).
  app.get('/reports/pnl', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { from, to } = req.query as { from?: string; to?: string };
    const accounts = await prisma.ledgerAccount.findMany({ where: { tenantId: req.auth.tid, type: { in: ['income', 'expense'] } } });
    const typeByCode = new Map(accounts.map((a) => [a.code, a.type]));
    const nameByCode = new Map(accounts.map((a) => [a.code, a.name]));
    const lines = await prisma.journalLine.findMany({
      where: { accountCode: { in: accounts.map((a) => a.code) }, entry: { tenantId: req.auth.tid, status: 'posted', ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) } },
      select: { accountCode: true, debitMinor: true, creditMinor: true },
    });
    const agg = new Map<string, bigint>();
    for (const l of lines) {
      const type = typeByCode.get(l.accountCode);
      const amt = type === 'income' ? l.creditMinor - l.debitMinor : l.debitMinor - l.creditMinor;
      agg.set(l.accountCode, (agg.get(l.accountCode) ?? 0n) + amt);
    }
    const income = [...agg.entries()].filter(([c]) => typeByCode.get(c) === 'income').map(([code, amount]) => ({ code, name: nameByCode.get(code) ?? code, amountMinor: amount }));
    const expense = [...agg.entries()].filter(([c]) => typeByCode.get(c) === 'expense').map(([code, amount]) => ({ code, name: nameByCode.get(code) ?? code, amountMinor: amount }));
    const totalIncome = income.reduce((s, r) => s + r.amountMinor, 0n);
    const totalExpense = expense.reduce((s, r) => s + r.amountMinor, 0n);
    return { income, expense, totalIncome, totalExpense, netProfitMinor: totalIncome - totalExpense };
  });

  // Inventory valuation (8.2): on-hand value by weighted-average and by FIFO layers.
  app.get('/reports/inventory-valuation', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { warehouseId } = req.query as { warehouseId?: string };
    const items = await prisma.stockItem.findMany({
      where: { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : {}), quantity: { gt: 0 } },
      include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const layers = await prisma.costLayer.findMany({ where: { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : {}), remainingQty: { gt: 0 } } });
    const fifoByKey = new Map<string, bigint>();
    for (const l of layers) {
      const key = `${l.warehouseId}:${l.productId}`;
      const val = BigInt(D(l.remainingQty).mul(l.unitCostMinor.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
      fifoByKey.set(key, (fifoByKey.get(key) ?? 0n) + val);
    }
    const rows = items.map((it) => {
      const avgValue = BigInt(D(it.quantity).mul(it.avgCostMinor.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
      return {
        productId: it.productId, productName: it.product?.name ?? it.productId, productSku: it.product?.sku ?? null,
        warehouseId: it.warehouseId, warehouseName: it.warehouse?.name ?? '',
        quantity: it.quantity, avgCostMinor: it.avgCostMinor, avgValueMinor: avgValue,
        fifoValueMinor: fifoByKey.get(`${it.warehouseId}:${it.productId}`) ?? 0n,
      };
    });
    return {
      rows,
      totalAvgMinor: rows.reduce((s, r) => s + r.avgValueMinor, 0n),
      totalFifoMinor: rows.reduce((s, r) => s + r.fifoValueMinor, 0n),
    };
  });

  // Account ledger: posted lines for one account with a running balance.
  app.get('/reports/account-ledger', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { code, from, to } = req.query as { code?: string; from?: string; to?: string };
    if (!code) throw BadRequest('Укажите счёт (code)', 'CODE_REQUIRED');
    const acc = await prisma.ledgerAccount.findUnique({ where: { tenantId_code: { tenantId: req.auth.tid, code } } });
    const lines = await prisma.journalLine.findMany({
      where: { accountCode: code, entry: { tenantId: req.auth.tid, status: 'posted', ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) } },
      include: { entry: { select: { number: true, date: true, memo: true } } },
      orderBy: { entry: { date: 'asc' } },
    });
    const debitNormal = acc ? ['asset', 'expense'].includes(acc.type) : true;
    let running = 0n;
    const rows = lines.map((l) => {
      running += debitNormal ? l.debitMinor - l.creditMinor : l.creditMinor - l.debitMinor;
      return { entryNumber: l.entry.number, date: l.entry.date, memo: l.entry.memo, debitMinor: l.debitMinor, creditMinor: l.creditMinor, balanceMinor: running };
    });
    return { account: acc, rows, closingMinor: running };
  });

  // ==================== 8.5 VAT (НДС) ====================
  // VAT return for a date range: output VAT (5030 net credit) vs input VAT (1060 net
  // debit) → net payable. Postings put VAT on top of net amounts (see lib/vat.ts).
  app.get('/reports/vat', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { from, to } = req.query as { from?: string; to?: string };
    const dateWhere = from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {};
    const lines = await prisma.journalLine.findMany({
      where: { accountCode: { in: [VAT_OUTPUT, VAT_INPUT] }, entry: { tenantId: req.auth.tid, status: 'posted', ...dateWhere } },
      select: { accountCode: true, debitMinor: true, creditMinor: true },
    });
    let output = 0n; let input = 0n;
    for (const l of lines) {
      if (l.accountCode === VAT_OUTPUT) output += l.creditMinor - l.debitMinor; // liability: credit-normal
      else input += l.debitMinor - l.creditMinor; // asset: debit-normal
    }
    const t = await prisma.tenant.findUnique({ where: { id: req.auth.tid }, select: { vatEnabled: true, vatRatePct: true } });
    return { vatEnabled: !!t?.vatEnabled, ratePct: t?.vatRatePct ?? 12, outputVatMinor: output, inputVatMinor: input, netPayableMinor: output - input };
  });

  // Offset input VAT against output VAT for a period (зачёт НДС): posts Dr 5030 / Cr 1060
  // for the smaller of the two, leaving the net in the payable (or reclaim) account.
  app.post('/vat/settle', { preHandler: [requirePermission('finance.accounting')] }, async (req, reply) => {
    const body = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.body ?? {});
    const dateWhere = body.from || body.to ? { date: { ...(body.from ? { gte: new Date(body.from) } : {}), ...(body.to ? { lte: new Date(body.to) } : {}) } } : {};
    const lines = await prisma.journalLine.findMany({
      where: { accountCode: { in: [VAT_OUTPUT, VAT_INPUT] }, entry: { tenantId: req.auth.tid, status: 'posted', ...dateWhere } },
      select: { accountCode: true, debitMinor: true, creditMinor: true },
    });
    let output = 0n; let input = 0n;
    for (const l of lines) {
      if (l.accountCode === VAT_OUTPUT) output += l.creditMinor - l.debitMinor;
      else input += l.debitMinor - l.creditMinor;
    }
    const offset = output < input ? output : input;
    if (offset <= 0n) throw BadRequest('Нечего зачитывать — нет встречного НДС за период', 'NOTHING_TO_OFFSET');
    const posted = await prisma.$transaction(async (tx) => {
      await ensureChart(tx, req.auth.tid);
      return postEntry(tx, {
        tenantId: req.auth.tid, date: body.to ? new Date(body.to) : new Date(), source: 'adjust', memo: 'Зачёт НДС', userId: req.auth.sub,
        lines: [
          { accountCode: VAT_OUTPUT, debitMinor: offset, description: 'Зачёт НДС к уплате' },
          { accountCode: VAT_INPUT, creditMinor: offset, description: 'Зачёт НДС к зачёту' },
        ],
      });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.vat.settle', entity: 'JournalEntry', entityId: posted.id, meta: { offset: offset.toString() }, ip: req.ip });
    return reply.code(201).send({ entry: posted, offsetMinor: offset, outputVatMinor: output, inputVatMinor: input, netPayableMinor: output - input });
  });

  // ==================== 8.5 BANK RECONCILIATION ====================
  app.get('/accounts/:id/reconciliation', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const acc = await prisma.finAccount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!acc) throw NotFound('Счёт не найден');
    const txns = await prisma.cashTransaction.findMany({ where: { tenantId: req.auth.tid, accountId: id }, orderBy: { date: 'desc' }, take: 200 });
    const signed = (t: { direction: string; amountMinor: bigint }) => (t.direction === 'in' ? t.amountMinor : -t.amountMinor);
    const reconciledMinor = acc.openingMinor + txns.filter((t) => t.reconciled).reduce((s, t) => s + signed(t), 0n);
    const unreconciled = txns.filter((t) => !t.reconciled);
    return { account: acc, reconciledBalanceMinor: reconciledMinor, bookBalanceMinor: acc.balanceMinor, unreconciled, unreconciledCount: unreconciled.length };
  });

  app.post('/accounts/:id/reconcile', { preHandler: [requirePermission('finance.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ txIds: z.array(z.string()).min(1), reconciled: z.boolean().default(true), statementBalanceMinor: z.number().int().optional() }).parse(req.body);
    const acc = await prisma.finAccount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!acc) throw NotFound('Счёт не найден');
    await prisma.cashTransaction.updateMany({
      where: { id: { in: body.txIds }, tenantId: req.auth.tid, accountId: id },
      data: { reconciled: body.reconciled, reconciledAt: body.reconciled ? new Date() : null },
    });
    const txns = await prisma.cashTransaction.findMany({ where: { tenantId: req.auth.tid, accountId: id } });
    const signed = (t: { direction: string; amountMinor: bigint }) => (t.direction === 'in' ? t.amountMinor : -t.amountMinor);
    const reconciledMinor = acc.openingMinor + txns.filter((t) => t.reconciled).reduce((s, t) => s + signed(t), 0n);
    const statement = body.statementBalanceMinor != null ? BigInt(body.statementBalanceMinor) : null;
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.account.reconcile', entity: 'FinAccount', entityId: id, meta: { count: body.txIds.length, reconciled: body.reconciled }, ip: req.ip });
    return { reconciledBalanceMinor: reconciledMinor, statementBalanceMinor: statement, differenceMinor: statement != null ? statement - reconciledMinor : null };
  });

  // ==================== 8.6 BUDGETS ====================
  app.get('/budgets', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { periodCode } = req.query as { periodCode?: string };
    const budgets = await prisma.budget.findMany({ where: { tenantId: req.auth.tid, ...(periodCode ? { periodCode } : {}) }, orderBy: [{ periodCode: 'desc' }, { accountCode: 'asc' }] });
    return { budgets };
  });

  app.post('/budgets', { preHandler: [requirePermission('finance.accounting')] }, async (req, reply) => {
    const body = z.object({
      periodCode: z.string().regex(/^\d{4}-\d{2}$/, 'Период в формате YYYY-MM'),
      accountCode: z.string().min(1),
      plannedMinor: z.number().int().min(0),
      note: z.string().optional(),
    }).parse(req.body);
    const budget = await prisma.budget.upsert({
      where: { tenantId_periodCode_accountCode: { tenantId: req.auth.tid, periodCode: body.periodCode, accountCode: body.accountCode } },
      create: { tenantId: req.auth.tid, periodCode: body.periodCode, accountCode: body.accountCode, plannedMinor: BigInt(body.plannedMinor), note: body.note ?? null, createdBy: req.auth.sub },
      update: { plannedMinor: BigInt(body.plannedMinor), note: body.note ?? null },
    });
    return reply.code(201).send({ budget });
  });

  app.delete('/budgets/:id', { preHandler: [requirePermission('finance.accounting')] }, async (req) => {
    const { id } = req.params as { id: string };
    const b = await prisma.budget.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!b) throw NotFound('Бюджет не найден');
    await prisma.budget.delete({ where: { id } });
    return { ok: true };
  });

  // Budget plan-vs-fact for a month: actual = the account's posted movement in its
  // normal-balance direction over that period.
  app.get('/reports/budget', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { periodCode } = req.query as { periodCode?: string };
    if (!periodCode || !/^\d{4}-\d{2}$/.test(periodCode)) throw BadRequest('Укажите период (YYYY-MM)', 'PERIOD_REQUIRED');
    const [y, m] = periodCode.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59));
    const budgets = await prisma.budget.findMany({ where: { tenantId: req.auth.tid, periodCode } });
    const accounts = await prisma.ledgerAccount.findMany({ where: { tenantId: req.auth.tid } });
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const codes = budgets.map((b) => b.accountCode);
    const lines = codes.length ? await prisma.journalLine.findMany({
      where: { accountCode: { in: codes }, entry: { tenantId: req.auth.tid, status: 'posted', date: { gte: start, lte: end } } },
      select: { accountCode: true, debitMinor: true, creditMinor: true },
    }) : [];
    const actualByCode = new Map<string, bigint>();
    for (const l of lines) {
      const acc = byCode.get(l.accountCode);
      const debitNormal = acc ? ['asset', 'expense'].includes(acc.type) : true;
      const amt = debitNormal ? l.debitMinor - l.creditMinor : l.creditMinor - l.debitMinor;
      actualByCode.set(l.accountCode, (actualByCode.get(l.accountCode) ?? 0n) + amt);
    }
    const rows = budgets.map((b) => {
      const actual = actualByCode.get(b.accountCode) ?? 0n;
      return { accountCode: b.accountCode, accountName: byCode.get(b.accountCode)?.name ?? b.accountCode, plannedMinor: b.plannedMinor, actualMinor: actual, varianceMinor: b.plannedMinor - actual };
    }).sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return {
      periodCode, rows,
      totalPlannedMinor: rows.reduce((s, r) => s + r.plannedMinor, 0n),
      totalActualMinor: rows.reduce((s, r) => s + r.actualMinor, 0n),
    };
  });

  // ==================== 8.6 TREASURY / PAYMENT CALENDAR ====================
  app.get('/payment-schedule', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const { status, from, to } = req.query as { status?: string; from?: string; to?: string };
    const where: Prisma.PaymentScheduleWhereInput = {
      tenantId: req.auth.tid,
      ...(status ? { status } : {}),
      ...(from || to ? { dueDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    };
    const items = await prisma.paymentSchedule.findMany({ where, orderBy: { dueDate: 'asc' } });
    const plannedIn = items.filter((i) => i.status === 'planned' && i.direction === 'in').reduce((s, i) => s + i.amountMinor, 0n);
    const plannedOut = items.filter((i) => i.status === 'planned' && i.direction === 'out').reduce((s, i) => s + i.amountMinor, 0n);
    return { items, plannedInMinor: plannedIn, plannedOutMinor: plannedOut };
  });

  app.post('/payment-schedule', { preHandler: [requirePermission('finance.write')] }, async (req, reply) => {
    const body = z.object({
      direction: z.enum(['in', 'out']),
      title: z.string().min(1),
      counterparty: z.string().optional(),
      category: z.enum(['sale', 'purchase', 'salary', 'vat', 'tax', 'rent', 'utility', 'other', 'refund']).default('other'),
      amountMinor: z.number().int().positive(),
      dueDate: z.string(),
      accountId: z.string().optional(),
      note: z.string().optional(),
    }).parse(req.body);
    const item = await prisma.paymentSchedule.create({
      data: {
        tenantId: req.auth.tid, direction: body.direction, title: body.title, counterparty: body.counterparty ?? null,
        category: body.category, amountMinor: BigInt(body.amountMinor), dueDate: new Date(body.dueDate),
        accountId: body.accountId ?? null, note: body.note ?? null, createdBy: req.auth.sub,
      },
    });
    return reply.code(201).send({ item });
  });

  app.patch('/payment-schedule/:id', { preHandler: [requirePermission('finance.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      title: z.string().min(1).optional(), counterparty: z.string().optional(), amountMinor: z.number().int().positive().optional(),
      dueDate: z.string().optional(), accountId: z.string().optional(), note: z.string().optional(),
      status: z.enum(['planned', 'cancelled']).optional(),
    }).parse(req.body);
    const item = await prisma.paymentSchedule.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!item) throw NotFound('Платёж не найден');
    if (item.status === 'paid') throw BadRequest('Оплаченный платёж нельзя изменить', 'ALREADY_PAID');
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.counterparty !== undefined) data.counterparty = body.counterparty;
    if (body.amountMinor !== undefined) data.amountMinor = BigInt(body.amountMinor);
    if (body.dueDate !== undefined) data.dueDate = new Date(body.dueDate);
    if (body.accountId !== undefined) data.accountId = body.accountId;
    if (body.note !== undefined) data.note = body.note;
    if (body.status !== undefined) data.status = body.status;
    const updated = await prisma.paymentSchedule.update({ where: { id }, data });
    return { item: updated };
  });

  app.delete('/payment-schedule/:id', { preHandler: [requirePermission('finance.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const item = await prisma.paymentSchedule.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!item) throw NotFound('Платёж не найден');
    if (item.status === 'paid') throw BadRequest('Оплаченный платёж нельзя удалить', 'ALREADY_PAID');
    await prisma.paymentSchedule.delete({ where: { id } });
    return { ok: true };
  });

  // Settle a scheduled payment: creates the cash transaction (which posts to the ledger)
  // and links it back. Guards funds for outgoing payments.
  app.post('/payment-schedule/:id/pay', { preHandler: [requirePermission('finance.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ accountId: z.string().optional(), date: z.string().optional() }).parse(req.body ?? {});
    const item = await prisma.paymentSchedule.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!item) throw NotFound('Платёж не найден');
    if (item.status !== 'planned') throw BadRequest('Платёж уже обработан', 'NOT_PLANNED');
    const accountId = body.accountId ?? item.accountId;
    if (!accountId) throw BadRequest('Укажите счёт для оплаты', 'ACCOUNT_REQUIRED');
    const acc = await prisma.finAccount.findFirst({ where: { id: accountId, tenantId: req.auth.tid } });
    if (!acc) throw NotFound('Счёт не найден');
    if (acc.status !== 'active') throw BadRequest('Счёт архивирован', 'ACCOUNT_ARCHIVED');
    if (item.direction === 'out' && acc.balanceMinor < item.amountMinor) throw BadRequest('Недостаточно средств на счёте', 'INSUFFICIENT_FUNDS');
    const when = body.date ? new Date(body.date) : new Date();

    const trx = await prisma.$transaction(async (tx) => {
      const created = await recordCashTx(tx, req.auth.tid, req.auth.sub, acc, {
        direction: item.direction as 'in' | 'out', category: item.category, amountMinor: item.amountMinor, date: when,
        counterparty: item.counterparty ?? undefined, note: item.title, refType: 'PaymentSchedule', refId: item.id,
      });
      await tx.paymentSchedule.update({ where: { id: item.id }, data: { status: 'paid', paidTxId: created.id, paidAt: when } });
      return created;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'finance.payment.pay', entity: 'PaymentSchedule', entityId: id, meta: { txNumber: trx.number }, ip: req.ip });
    return reply.code(201).send({ transaction: trx });
  });

  // Cash-flow forecast (payment calendar): projected running balance over the horizon,
  // combining current cash with upcoming planned payments/receipts.
  app.get('/reports/cash-forecast', { preHandler: [requirePermission('finance.read')] }, async (req) => {
    const days = Math.min(365, Math.max(1, Number((req.query as { days?: string }).days) || 60));
    const accounts = await prisma.finAccount.findMany({ where: { tenantId: req.auth.tid, status: 'active' } });
    const opening = accounts.reduce((s, a) => s + a.balanceMinor, 0n);
    const horizon = new Date(Date.now() + days * 86400000);
    const items = await prisma.paymentSchedule.findMany({ where: { tenantId: req.auth.tid, status: 'planned', dueDate: { lte: horizon } }, orderBy: { dueDate: 'asc' } });
    // Group by calendar day.
    const byDay = new Map<string, { inMinor: bigint; outMinor: bigint }>();
    for (const it of items) {
      const key = it.dueDate.toISOString().slice(0, 10);
      const cur = byDay.get(key) ?? { inMinor: 0n, outMinor: 0n };
      if (it.direction === 'in') cur.inMinor += it.amountMinor; else cur.outMinor += it.amountMinor;
      byDay.set(key, cur);
    }
    let running = opening;
    const rows = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => {
      running += v.inMinor - v.outMinor;
      return { date, inMinor: v.inMinor, outMinor: v.outMinor, netMinor: v.inMinor - v.outMinor, runningMinor: running };
    });
    const overdue = items.filter((it) => it.dueDate < new Date());
    return {
      openingMinor: opening, horizonDays: days, rows,
      projectedMinor: running,
      overdueCount: overdue.length,
      overdueMinor: overdue.reduce((s, it) => s + (it.direction === 'out' ? it.amountMinor : 0n), 0n),
    };
  });

  // Full default chart reference (for the UI account picker) — code/name/type.
  app.get('/chart/defaults', { preHandler: [requirePermission('finance.read')] }, async () => {
    return { accounts: DEFAULT_CHART };
  });
}
