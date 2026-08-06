// Shared cash-movement primitive (Stage 8.1, extracted in Stage 14). Recording a cash
// transaction posts a balanced journal entry, creates the CashTransaction, updates the
// running account balance and links them — all inside the caller's DB transaction.
// Used by the finance module (manual transactions + scheduled-payment settlement) and
// by HR payroll payment, so the logic lives here rather than in a routes file.
import { Prisma } from '@prisma/client';
import { ensureChart, postEntry, nextDocNumber } from './ledger.js';

type Tx = Prisma.TransactionClient;

// Ledger account a cash/bank account maps to (cash box vs. current account).
export function ledgerCodeForKind(kind: string): string {
  return kind === 'cash' ? '1010' : '1020';
}

// Counter (offset) account for a cash transaction, by direction + category.
export function counterCode(direction: string, category: string): string {
  if (direction === 'in') {
    if (category === 'sale') return '1030'; // settle receivable
    if (category === 'opening') return '3010'; // capital
    if (category === 'refund') return '1030';
    return '6020'; // other income
  }
  // out
  switch (category) {
    case 'purchase': return '5010'; // pay supplier
    case 'payroll': return '5040'; // settle payroll payable (accrued in HR)
    case 'salary': return '7020'; // direct salary expense (no prior accrual)
    case 'vat': return '5030'; // settle VAT payable
    case 'tax': return '5020';
    case 'rent': return '7030';
    case 'utility': return '7040';
    case 'refund': return '6010'; // sales refund reduces revenue
    default: return '7040';
  }
}

export interface CashAccountRef {
  id: string;
  ledgerCode: string;
  currency: string;
  balanceMinor: bigint;
}

export interface CashTxInput {
  direction: 'in' | 'out';
  category: string;
  amountMinor: bigint;
  date: Date;
  counterparty?: string;
  note?: string;
  refType?: string;
  refId?: string;
}

// Record a cash movement inside a transaction. Returns the created CashTransaction.
export async function recordCashTx(
  tx: Tx, tenantId: string, userId: string | null,
  acc: CashAccountRef, input: CashTxInput,
) {
  await ensureChart(tx, tenantId);
  const cash = acc.ledgerCode;
  const counter = counterCode(input.direction, input.category);
  const lines = input.direction === 'in'
    ? [{ accountCode: cash, debitMinor: input.amountMinor, description: input.note }, { accountCode: counter, creditMinor: input.amountMinor }]
    : [{ accountCode: counter, debitMinor: input.amountMinor, description: input.note }, { accountCode: cash, creditMinor: input.amountMinor }];
  const posted = await postEntry(tx, {
    tenantId, date: input.date, source: 'cash', refType: 'CashTransaction', userId,
    memo: `${input.direction === 'in' ? 'Поступление' : 'Расход'}: ${input.counterparty ?? input.category}`, lines,
  });
  const newBalance = input.direction === 'in' ? acc.balanceMinor + input.amountMinor : acc.balanceMinor - input.amountMinor;
  const number = await nextDocNumber(tx, tenantId, 'cash_tx', 'CT');
  const trx = await tx.cashTransaction.create({
    data: {
      tenantId, accountId: acc.id, number, direction: input.direction, category: input.category,
      amountMinor: input.amountMinor, currency: acc.currency, date: input.date, counterparty: input.counterparty ?? null,
      refType: input.refType ?? null, refId: input.refId ?? null, note: input.note ?? null,
      journalEntryId: posted.id, balanceAfter: newBalance, createdBy: userId,
    },
  });
  await tx.finAccount.update({ where: { id: acc.id }, data: { balanceMinor: newBalance } });
  await tx.journalEntry.update({ where: { id: posted.id }, data: { refId: trx.id } });
  return trx;
}
