// Platform (seller) requisites — the details that appear on official invoices.
// Stored as a single PlatformConfig row, seeded from env, editable by super-admin.
import { prisma } from '../db.js';

export interface SellerRequisites {
  sellerName: string;
  sellerInn: string;
  address: string;
  bank: string;
  account: string;
  mfo: string;
  director: string;
  phone: string;
  email: string;
  vatPercent: number;
}

const envDefaults = (): SellerRequisites => ({
  sellerName: process.env.SELLER_NAME || 'TTR Inc.',
  sellerInn: process.env.SELLER_INN || '',
  address: process.env.SELLER_ADDRESS || '',
  bank: process.env.SELLER_BANK || '',
  account: process.env.SELLER_ACCOUNT || '',
  mfo: process.env.SELLER_MFO || '',
  director: process.env.SELLER_DIRECTOR || '',
  phone: process.env.SELLER_PHONE || '',
  email: process.env.SELLER_EMAIL || '',
  vatPercent: Number(process.env.SELLER_VAT_PERCENT ?? 0),
});

export async function getSellerRequisites(): Promise<SellerRequisites> {
  const row = await prisma.platformConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...envDefaults() },
    update: {},
  });
  const { id, updatedAt, ...rest } = row;
  void id; void updatedAt;
  return rest;
}

export async function setSellerRequisites(patch: Partial<SellerRequisites>): Promise<SellerRequisites> {
  const row = await prisma.platformConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...envDefaults(), ...patch },
    update: patch,
  });
  const { id, updatedAt, ...rest } = row;
  void id; void updatedAt;
  return rest;
}

// VAT (QQS) breakdown from a VAT-inclusive total.
export function vatBreakdown(totalMinor: number, vatPercent: number) {
  if (!vatPercent) return { netMinor: totalMinor, vatMinor: 0 };
  const netMinor = Math.round((totalMinor * 100) / (100 + vatPercent));
  return { netMinor, vatMinor: totalMinor - netMinor };
}
