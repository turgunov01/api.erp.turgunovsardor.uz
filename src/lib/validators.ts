// Shared value validators. Money is always integer minor units (never float);
// quantities are decimals bounded to 6 fractional digits.
import { z } from 'zod';

// Money in minor units (e.g. tiyin/cents). Integer, non-negative, within safe range.
export const moneyMinor = z
  .number({ message: 'Money must be a number in integer minor units' })
  .int('Money must be in integer minor units (no fractional units)')
  .min(0, 'Money cannot be negative')
  .max(Number.MAX_SAFE_INTEGER);

// Quantity guards: finite, bounded scale (<= 6 decimals) to avoid float drift.
const MAX_QTY = 1_000_000_000_000; // 1e12 — generous upper bound
const scaleOk = (v: number) => Number.isFinite(v) && Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-3;

export const quantityPositive = z
  .number()
  .finite('Quantity must be a finite number')
  .positive('Quantity must be greater than zero')
  .max(MAX_QTY, 'Quantity is too large')
  .refine(scaleOk, 'Quantity supports at most 6 decimal places');

export const quantityNonNegative = z
  .number()
  .finite('Quantity must be a finite number')
  .min(0, 'Quantity cannot be negative')
  .max(MAX_QTY, 'Quantity is too large')
  .refine(scaleOk, 'Quantity supports at most 6 decimal places');
