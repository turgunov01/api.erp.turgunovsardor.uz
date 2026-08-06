// Auto-postings (Stage 8.4): translate domain events from sales, purchase and
// production into balanced journal entries. Handlers run inside the triggering
// transaction (see lib/events.ts) so the fact and its accounting entry are atomic.
// Postings only happen for tenants that have the finance module enabled.
import { Prisma } from '@prisma/client';
import { onEvent, type EventContext } from '../../lib/events.js';
import { postEntry, type PostLine } from '../../lib/ledger.js';
import { getVatSettings, vatOnNet, VAT_ACCOUNTS } from '../../lib/vat.js';

type Tx = Prisma.TransactionClient;

// Accounts used by auto-postings.
const ACC = {
  cash: '1010', bank: '1020', ar: '1030', inventory: '1040', wip: '1050',
  ap: '5010', tax: '5020', payroll: '5040', equity: '3010', revenue: '6010', otherIncome: '6020',
  cogs: '7010', salary: '7020', rent: '7030', other: '7040',
};

async function isFinanceOn(tx: Tx, tenantId: string): Promise<boolean> {
  const row = await tx.tenantModule.findUnique({ where: { tenantId_moduleKey: { tenantId, moduleKey: 'finance' } } });
  return !!row?.enabled;
}

// Post only if at least one non-zero line exists (avoids empty/zero entries when a
// cost basis is missing, e.g. items received before costing was tracked).
async function maybePost(ctx: EventContext, input: { date: Date; memo: string; source: string; refType?: string; refId?: string; lines: PostLine[] }) {
  const nonZero = input.lines.filter((l) => (l.debitMinor ?? 0n) !== 0n || (l.creditMinor ?? 0n) !== 0n);
  if (nonZero.length < 2) return;
  await postEntry(ctx.tx, {
    tenantId: ctx.tenantId, date: input.date, memo: input.memo, source: input.source,
    refType: input.refType ?? null, refId: input.refId ?? null, lines: nonZero, userId: ctx.userId ?? null,
  });
}

export function registerFinancePostings(): void {
  // Goods receipt: Dr Inventory (net) [+ Dr Input VAT] / Cr Accounts Payable (gross).
  onEvent('purchase.received', async (p: { refId: string; number: string; totalCostMinor: bigint; supplierName?: string | null }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    const vat = await getVatSettings(ctx.tx, ctx.tenantId);
    const vatMinor = vat.enabled ? vatOnNet(p.totalCostMinor, vat.ratePct) : 0n;
    const lines: PostLine[] = [
      { accountCode: ACC.inventory, debitMinor: p.totalCostMinor, description: 'Оприходование запасов' },
    ];
    if (vatMinor > 0n) lines.push({ accountCode: VAT_ACCOUNTS.input, debitMinor: vatMinor, description: 'НДС к зачёту' });
    lines.push({ accountCode: ACC.ap, creditMinor: p.totalCostMinor + vatMinor, description: 'Задолженность поставщику' });
    await maybePost(ctx, {
      date: new Date(), memo: `Приход по накладной ${p.number}${p.supplierName ? ' — ' + p.supplierName : ''}`,
      source: 'purchase', refType: 'GoodsReceipt', refId: p.refId, lines,
    });
  });

  // Sales shipment: revenue (Dr AR / Cr Revenue [+ Cr Output VAT]) and COGS (Dr COGS / Cr Inventory).
  onEvent('sales.shipped', async (p: { refId: string; number: string; saleValueMinor: bigint; cogsMinor: bigint; customerName?: string | null }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    const vat = await getVatSettings(ctx.tx, ctx.tenantId);
    const vatMinor = vat.enabled ? vatOnNet(p.saleValueMinor, vat.ratePct) : 0n;
    const lines: PostLine[] = [
      { accountCode: ACC.ar, debitMinor: p.saleValueMinor + vatMinor, description: 'Задолженность покупателя' },
      { accountCode: ACC.revenue, creditMinor: p.saleValueMinor, description: 'Выручка от продаж' },
    ];
    if (vatMinor > 0n) lines.push({ accountCode: VAT_ACCOUNTS.output, creditMinor: vatMinor, description: 'НДС с продаж' });
    lines.push(
      { accountCode: ACC.cogs, debitMinor: p.cogsMinor, description: 'Себестоимость продаж' },
      { accountCode: ACC.inventory, creditMinor: p.cogsMinor, description: 'Списание запасов' },
    );
    await maybePost(ctx, {
      date: new Date(), memo: `Отгрузка ${p.number}${p.customerName ? ' — ' + p.customerName : ''}`,
      source: 'sales', refType: 'Shipment', refId: p.refId, lines,
    });
  });

  // Sales return: reverse revenue [+ output VAT] and COGS.
  onEvent('sales.returned', async (p: { refId: string; number: string; saleValueMinor: bigint; cogsMinor: bigint; customerName?: string | null }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    const vat = await getVatSettings(ctx.tx, ctx.tenantId);
    const vatMinor = vat.enabled ? vatOnNet(p.saleValueMinor, vat.ratePct) : 0n;
    const lines: PostLine[] = [
      { accountCode: ACC.revenue, debitMinor: p.saleValueMinor, description: 'Сторно выручки' },
    ];
    if (vatMinor > 0n) lines.push({ accountCode: VAT_ACCOUNTS.output, debitMinor: vatMinor, description: 'Сторно НДС с продаж' });
    lines.push(
      { accountCode: ACC.ar, creditMinor: p.saleValueMinor + vatMinor, description: 'Уменьшение задолженности покупателя' },
      { accountCode: ACC.inventory, debitMinor: p.cogsMinor, description: 'Возврат запасов' },
      { accountCode: ACC.cogs, creditMinor: p.cogsMinor, description: 'Сторно себестоимости' },
    );
    await maybePost(ctx, {
      date: new Date(), memo: `Возврат ${p.number}${p.customerName ? ' — ' + p.customerName : ''}`,
      source: 'sales', refType: 'SalesReturn', refId: p.refId, lines,
    });
  });

  // Production issue: Dr WIP / Cr Inventory (materials moved into work-in-progress).
  onEvent('production.issued', async (p: { refId: string; number: string; costMinor: bigint }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    await maybePost(ctx, {
      date: new Date(), memo: `Списание материалов в производство ${p.number}`,
      source: 'production', refType: 'ProductionOrder', refId: p.refId,
      lines: [
        { accountCode: ACC.wip, debitMinor: p.costMinor, description: 'Незавершённое производство' },
        { accountCode: ACC.inventory, creditMinor: p.costMinor, description: 'Списание материалов' },
      ],
    });
  });

  // Production completion: Dr Inventory (finished goods) / Cr WIP.
  onEvent('production.completed', async (p: { refId: string; number: string; costMinor: bigint }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    await maybePost(ctx, {
      date: new Date(), memo: `Приход готовой продукции ${p.number}`,
      source: 'production', refType: 'ProductionOrder', refId: p.refId,
      lines: [
        { accountCode: ACC.inventory, debitMinor: p.costMinor, description: 'Оприходование готовой продукции' },
        { accountCode: ACC.wip, creditMinor: p.costMinor, description: 'Закрытие НЗП' },
      ],
    });
  });

  // Payroll accrual (Stage 14, HR): Dr Wages expense (gross) / Cr Payroll payable (net) +
  // Cr tax payable (withheld income tax) [+ Cr other payable (other deductions)]. The
  // credits sum to gross so the entry balances; net + tax are settled separately.
  onEvent('payroll.accrued', async (p: { refId: string; periodCode: string; grossMinor: bigint; taxMinor: bigint; netMinor: bigint }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    const deductionsMinor = p.grossMinor - p.taxMinor - p.netMinor;
    const lines: PostLine[] = [
      { accountCode: ACC.salary, debitMinor: p.grossMinor, description: 'Заработная плата' },
      { accountCode: ACC.payroll, creditMinor: p.netMinor, description: 'Задолженность перед персоналом' },
      { accountCode: ACC.tax, creditMinor: p.taxMinor, description: 'НДФЛ к уплате' },
    ];
    if (deductionsMinor > 0n) lines.push({ accountCode: ACC.ap, creditMinor: deductionsMinor, description: 'Прочие удержания' });
    await maybePost(ctx, {
      date: new Date(), memo: `Начисление зарплаты за ${p.periodCode}`,
      source: 'payroll', refType: 'PayrollRun', refId: p.refId, lines,
    });
  });

  // POS sale (Stage 15): cash retail sale — Dr Cash/Bank (payment split) / Cr Revenue (net)
  // [+ Cr Output VAT], and COGS: Dr COGS / Cr Inventory. Revenue hits the till directly (no
  // receivable). saleValueMinor is net; VAT is computed on top like a shipment.
  onEvent('pos.sale', async (p: { refId: string; number: string; saleValueMinor: bigint; cogsMinor: bigint; cashMinor: bigint; cardMinor: bigint }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    const vat = await getVatSettings(ctx.tx, ctx.tenantId);
    const vatMinor = vat.enabled ? vatOnNet(p.saleValueMinor, vat.ratePct) : 0n;
    const lines: PostLine[] = [];
    if (p.cashMinor > 0n) lines.push({ accountCode: ACC.cash, debitMinor: p.cashMinor, description: 'Наличная выручка' });
    if (p.cardMinor > 0n) lines.push({ accountCode: ACC.bank, debitMinor: p.cardMinor, description: 'Выручка по карте' });
    lines.push({ accountCode: ACC.revenue, creditMinor: p.saleValueMinor, description: 'Розничная выручка' });
    if (vatMinor > 0n) lines.push({ accountCode: VAT_ACCOUNTS.output, creditMinor: vatMinor, description: 'НДС с продаж' });
    lines.push(
      { accountCode: ACC.cogs, debitMinor: p.cogsMinor, description: 'Себестоимость продаж' },
      { accountCode: ACC.inventory, creditMinor: p.cogsMinor, description: 'Списание запасов' },
    );
    await maybePost(ctx, {
      date: new Date(), memo: `Чек ${p.number}`, source: 'pos', refType: 'PosReceipt', refId: p.refId, lines,
    });
  });

  // POS refund (Stage 15): reverse the retail sale — Cr Cash/Bank / Dr Revenue [+ Dr VAT],
  // and return goods: Dr Inventory / Cr COGS.
  onEvent('pos.refund', async (p: { refId: string; number: string; saleValueMinor: bigint; cogsMinor: bigint; cashMinor: bigint; cardMinor: bigint }, ctx) => {
    if (!(await isFinanceOn(ctx.tx, ctx.tenantId))) return;
    const vat = await getVatSettings(ctx.tx, ctx.tenantId);
    const vatMinor = vat.enabled ? vatOnNet(p.saleValueMinor, vat.ratePct) : 0n;
    const lines: PostLine[] = [
      { accountCode: ACC.revenue, debitMinor: p.saleValueMinor, description: 'Сторно розничной выручки' },
    ];
    if (vatMinor > 0n) lines.push({ accountCode: VAT_ACCOUNTS.output, debitMinor: vatMinor, description: 'Сторно НДС с продаж' });
    if (p.cashMinor > 0n) lines.push({ accountCode: ACC.cash, creditMinor: p.cashMinor, description: 'Возврат наличными' });
    if (p.cardMinor > 0n) lines.push({ accountCode: ACC.bank, creditMinor: p.cardMinor, description: 'Возврат на карту' });
    lines.push(
      { accountCode: ACC.inventory, debitMinor: p.cogsMinor, description: 'Возврат запасов' },
      { accountCode: ACC.cogs, creditMinor: p.cogsMinor, description: 'Сторно себестоимости' },
    );
    await maybePost(ctx, {
      date: new Date(), memo: `Возврат по чеку ${p.number}`, source: 'pos', refType: 'PosReceipt', refId: p.refId, lines,
    });
  });
}
