// Double-entry ledger core (Stage 8.3) — chart of accounts, accounting periods and
// immutable balanced journal entries. Auto-postings (8.4) and manual entries both
// go through postEntry(), which enforces debits == credits and refuses to post into
// a closed period. Money is integer minor units (BigInt).
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface AccountDef { code: string; name: string; type: AccountType }

// Default chart of accounts — a simplified, generic set suitable for a factory/SME.
export const DEFAULT_CHART: AccountDef[] = [
  // Assets (1xxx)
  { code: '1010', name: 'Касса', type: 'asset' },
  { code: '1020', name: 'Расчётный счёт', type: 'asset' },
  { code: '1030', name: 'Дебиторская задолженность', type: 'asset' },
  { code: '1040', name: 'Запасы (товары и материалы)', type: 'asset' },
  { code: '1050', name: 'Незавершённое производство', type: 'asset' },
  { code: '1060', name: 'НДС к зачёту (по закупкам)', type: 'asset' },
  // Liabilities (5xxx)
  { code: '5010', name: 'Кредиторская задолженность', type: 'liability' },
  { code: '5020', name: 'Налоги к уплате', type: 'liability' },
  { code: '5030', name: 'НДС к уплате (с продаж)', type: 'liability' },
  { code: '5040', name: 'Расчёты с персоналом по оплате труда', type: 'liability' },
  // Equity (3xxx)
  { code: '3010', name: 'Капитал', type: 'equity' },
  { code: '3020', name: 'Нераспределённая прибыль', type: 'equity' },
  // Income (6xxx)
  { code: '6010', name: 'Выручка от продаж', type: 'income' },
  { code: '6020', name: 'Прочие доходы', type: 'income' },
  // Expenses (7xxx)
  { code: '7010', name: 'Себестоимость продаж', type: 'expense' },
  { code: '7020', name: 'Заработная плата', type: 'expense' },
  { code: '7030', name: 'Аренда', type: 'expense' },
  { code: '7040', name: 'Прочие расходы', type: 'expense' },
];

const CHART_BY_CODE = new Map(DEFAULT_CHART.map((a) => [a.code, a]));

export function accountType(code: string): AccountType {
  return CHART_BY_CODE.get(code)?.type ?? 'asset';
}

// Ensure the default chart exists for a tenant (idempotent). Used at seed time and
// lazily so a tenant that enables finance later still gets a working chart.
export async function ensureChart(tx: Tx, tenantId: string): Promise<void> {
  for (const a of DEFAULT_CHART) {
    await tx.ledgerAccount.upsert({
      where: { tenantId_code: { tenantId, code: a.code } },
      create: { tenantId, code: a.code, name: a.name, type: a.type, isSystem: true },
      update: {},
    });
  }
}

// Resolve (or self-heal) an account by code — auto-creates from the default chart so
// auto-postings never fail on a missing account.
async function resolveAccount(tx: Tx, tenantId: string, code: string): Promise<{ code: string; name: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { tenantId_code: { tenantId, code } } });
  if (existing) return { code: existing.code, name: existing.name };
  const def = CHART_BY_CODE.get(code);
  const created = await tx.ledgerAccount.create({
    data: { tenantId, code, name: def?.name ?? code, type: def?.type ?? 'asset', isSystem: true },
  });
  return { code: created.code, name: created.name };
}

function periodCode(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Find the period for a date, creating an open monthly period if none exists.
// Robust under concurrency: a losing racer's create hits the unique constraint,
// after which we simply re-read the winner's row. Throws if the period is closed.
export async function ensurePeriodForDate(tx: Tx, tenantId: string, date: Date): Promise<{ id: string; status: string }> {
  const code = periodCode(date);
  let period = await tx.accountingPeriod.findUnique({ where: { tenantId_code: { tenantId, code } } });
  if (!period) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
    try {
      period = await tx.accountingPeriod.create({ data: { tenantId, code, startDate: start, endDate: end, status: 'open' } });
    } catch {
      period = await tx.accountingPeriod.findUnique({ where: { tenantId_code: { tenantId, code } } });
    }
  }
  if (!period) throw new LedgerError('Не удалось определить учётный период', 'PERIOD_RESOLVE');
  return { id: period.id, status: period.status };
}

// Allocate the next per-tenant number atomically. The ON CONFLICT upsert takes a
// row lock held until commit, so concurrent postings get distinct, gapless numbers.
async function nextSeq(tx: Tx, tenantId: string, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "NumberSequence" ("tenantId", "key", "value") VALUES (${tenantId}, ${key}, 1)
    ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = "NumberSequence"."value" + 1
    RETURNING "value"`;
  return rows[0].value;
}

async function nextEntryNumber(tx: Tx, tenantId: string): Promise<string> {
  const n = await nextSeq(tx, tenantId, 'journal');
  return `JE-${new Date().getUTCFullYear()}-${String(n).padStart(5, '0')}`;
}

// Public helper for other finance documents (e.g. cash transactions) to share the
// same race-safe per-tenant numbering.
export async function nextDocNumber(tx: Tx, tenantId: string, key: string, prefix: string): Promise<string> {
  const n = await nextSeq(tx, tenantId, key);
  return `${prefix}-${new Date().getUTCFullYear()}-${String(n).padStart(5, '0')}`;
}

export interface PostLine { accountCode: string; debitMinor?: bigint; creditMinor?: bigint; description?: string }

export interface PostEntryInput {
  tenantId: string;
  date: Date;
  memo?: string | null;
  source?: string;
  refType?: string | null;
  refId?: string | null;
  lines: PostLine[];
  userId?: string | null;
}

class LedgerError extends Error { code: string; statusCode = 400; constructor(msg: string, code: string) { super(msg); this.code = code; } }

// Post a balanced journal entry. Enforces sum(debit) == sum(credit) and an open
// period. Returns the created entry id + number.
export async function postEntry(tx: Tx, input: PostEntryInput): Promise<{ id: string; number: string; totalMinor: bigint }> {
  const lines = input.lines.filter((l) => (l.debitMinor ?? 0n) !== 0n || (l.creditMinor ?? 0n) !== 0n);
  if (lines.length < 2) throw new LedgerError('Проводка должна содержать минимум две строки', 'ENTRY_TOO_SHORT');
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const l of lines) {
    const d = l.debitMinor ?? 0n;
    const c = l.creditMinor ?? 0n;
    if (d < 0n || c < 0n) throw new LedgerError('Суммы проводки не могут быть отрицательными', 'NEGATIVE_AMOUNT');
    if (d > 0n && c > 0n) throw new LedgerError('Строка не может быть одновременно дебетом и кредитом', 'DEBIT_AND_CREDIT');
    totalDebit += d;
    totalCredit += c;
  }
  if (totalDebit !== totalCredit) throw new LedgerError(`Проводка не сбалансирована: дебет ${totalDebit} ≠ кредит ${totalCredit}`, 'UNBALANCED');
  if (totalDebit === 0n) throw new LedgerError('Нулевая проводка', 'ZERO_ENTRY');

  const period = await ensurePeriodForDate(tx, input.tenantId, input.date);
  if (period.status === 'closed') throw new LedgerError('Период закрыт — проводка невозможна', 'PERIOD_CLOSED');

  const number = await nextEntryNumber(tx, input.tenantId);
  const resolved = await Promise.all(lines.map(async (l) => ({ acc: await resolveAccount(tx, input.tenantId, l.accountCode), line: l })));

  const entry = await tx.journalEntry.create({
    data: {
      tenantId: input.tenantId, number, date: input.date, periodId: period.id,
      memo: input.memo ?? null, source: input.source ?? 'manual',
      refType: input.refType ?? null, refId: input.refId ?? null,
      status: 'posted', totalMinor: totalDebit, createdBy: input.userId ?? null,
      lines: {
        create: resolved.map(({ acc, line }) => ({
          accountCode: acc.code, accountName: acc.name,
          debitMinor: line.debitMinor ?? 0n, creditMinor: line.creditMinor ?? 0n,
          description: line.description ?? null,
        })),
      },
    },
  });
  return { id: entry.id, number: entry.number, totalMinor: totalDebit };
}

// Reverse a posted entry by creating a mirror entry (debits/credits swapped) and
// linking both. Enforces single reversal and an open period on the reversal date.
export async function reverseEntry(tx: Tx, tenantId: string, entryId: string, userId?: string | null, date?: Date): Promise<{ id: string; number: string }> {
  const original = await tx.journalEntry.findFirst({ where: { id: entryId, tenantId }, include: { lines: true } });
  if (!original) throw new LedgerError('Проводка не найдена', 'NOT_FOUND');
  if (original.status === 'void') throw new LedgerError('Проводка уже сторнирована', 'ALREADY_VOID');
  if (original.reversedById) throw new LedgerError('Проводка уже сторнирована', 'ALREADY_REVERSED');

  const when = date ?? new Date();
  const period = await ensurePeriodForDate(tx, tenantId, when);
  if (period.status === 'closed') throw new LedgerError('Период закрыт — сторнирование невозможно', 'PERIOD_CLOSED');

  const number = await nextEntryNumber(tx, tenantId);
  const reversal = await tx.journalEntry.create({
    data: {
      tenantId, number, date: when, periodId: period.id,
      memo: `Сторно ${original.number}${original.memo ? ' — ' + original.memo : ''}`,
      source: 'adjust', refType: original.refType, refId: original.refId,
      status: 'posted', totalMinor: original.totalMinor, reversalOfId: original.id, createdBy: userId ?? null,
      lines: {
        create: original.lines.map((l) => ({
          accountCode: l.accountCode, accountName: l.accountName,
          debitMinor: l.creditMinor, creditMinor: l.debitMinor, description: l.description,
        })),
      },
    },
  });
  await tx.journalEntry.update({ where: { id: original.id }, data: { reversedById: reversal.id } });
  return { id: reversal.id, number: reversal.number };
}
