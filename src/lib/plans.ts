// Subscription plan catalog. Prices in integer minor units (UZS tiyin). Limits: null = unlimited.
export interface PlanDef {
  key: string;
  name: string;
  priceMinor: number | null; // null = custom / contact sales
  currency: string;
  maxUsers: number | null;
  maxWarehouses: number | null;
  maxProducts: number | null;
  maxModules: number | null; // how many business modules can be enabled; null = unlimited
  highlight?: boolean;
  tagline?: string; // short marketing line shown in the onboarding wizard
}

export const PLANS: PlanDef[] = [
  { key: 'trial', name: 'Бесплатный', priceMinor: 0, currency: 'UZS', maxUsers: 5, maxWarehouses: 3, maxProducts: 200, maxModules: null, highlight: true, tagline: 'Все модули · 14 дней бесплатно' },
  { key: 'starter', name: 'Starter', priceMinor: 29_900_000, currency: 'UZS', maxUsers: 10, maxWarehouses: 5, maxProducts: 2_000, maxModules: 3, tagline: 'Для старта — до 3 модулей' },
  { key: 'business', name: 'Business', priceMinor: 99_900_000, currency: 'UZS', maxUsers: 100, maxWarehouses: 50, maxProducts: 100_000, maxModules: 6, tagline: 'Для растущей компании — до 6 модулей' },
  { key: 'enterprise', name: 'Enterprise', priceMinor: null, currency: 'UZS', maxUsers: null, maxWarehouses: null, maxProducts: null, maxModules: null, tagline: 'Все модули без ограничений' },
];

export const PAID_PLAN_KEYS = ['starter', 'business'];
// Plans a company can pick during self-registration. 'trial' is the free 14-day tier
// (all modules); the paid tiers cap how many business modules can stay enabled.
export const SELECTABLE_PLAN_KEYS = ['trial', 'starter', 'business', 'enterprise'];

export function getPlan(key: string | null | undefined): PlanDef {
  return PLANS.find((p) => p.key === key) ?? PLANS[0];
}

export const TRIAL_DAYS = 14;
export const PERIOD_DAYS = 30;
