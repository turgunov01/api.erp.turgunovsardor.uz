// Subscription state helpers. Trial expiry is computed lazily (no background jobs yet).
import type { Tenant } from '@prisma/client';

export type EffectiveStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';

export function effectiveStatus(t: Pick<Tenant, 'subscriptionStatus' | 'trialEndsAt' | 'currentPeriodEnd' | 'status'>): EffectiveStatus {
  if (t.status === 'suspended' || t.status === 'cancelled') return 'cancelled';
  const now = Date.now();
  if (t.subscriptionStatus === 'trialing') {
    if (t.trialEndsAt && t.trialEndsAt.getTime() < now) return 'past_due';
    return 'trialing';
  }
  if (t.subscriptionStatus === 'active') {
    if (t.currentPeriodEnd && t.currentPeriodEnd.getTime() < now) return 'past_due';
    return 'active';
  }
  return t.subscriptionStatus as EffectiveStatus;
}

// Whether the tenant may perform mutations right now.
export function canWrite(status: EffectiveStatus): boolean {
  return status === 'trialing' || status === 'active';
}

export function daysLeft(date: Date | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}
