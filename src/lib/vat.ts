// VAT (НДС) helpers — Stage 8.5. VAT is modelled as added on top of net amounts:
// revenue and inventory cost stay net (so costing stays intact), and the tax is a
// separate ledger line. Output VAT (on sales) is a liability (5030); input VAT (on
// purchases) is a reclaimable asset (1060).
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export const VAT_ACCOUNTS = { output: '5030', input: '1060' } as const;

export interface VatSettings { enabled: boolean; ratePct: number }

// Read a tenant's VAT settings inside a transaction (used by auto-postings).
export async function getVatSettings(tx: Tx, tenantId: string): Promise<VatSettings> {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { vatEnabled: true, vatRatePct: true } });
  return { enabled: !!t?.vatEnabled, ratePct: t?.vatRatePct ?? 12 };
}

// VAT amount charged on top of a net amount, rounded to whole minor units.
export function vatOnNet(netMinor: bigint, ratePct: number): bigint {
  if (netMinor <= 0n || ratePct <= 0) return 0n;
  // round((net * rate) / 100) with half-up on integers
  return (netMinor * BigInt(ratePct) * 2n + 100n) / 200n;
}
