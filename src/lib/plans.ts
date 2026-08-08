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
  { key: 'trial', name: 'Бесплатный', priceMinor: 0, currency: 'UZS', maxUsers: 3, maxWarehouses: 2, maxProducts: 150, maxModules: null, tagline: 'Все модули · 14 дней бесплатно' },
  { key: 'starter', name: 'Старт', priceMinor: 69_000_000, currency: 'UZS', maxUsers: 5, maxWarehouses: 3, maxProducts: 2_000, maxModules: 3, tagline: 'Для розницы и старта — до 3 модулей' },
  { key: 'business', name: 'Бизнес', priceMinor: 199_000_000, currency: 'UZS', maxUsers: 25, maxWarehouses: 15, maxProducts: 50_000, maxModules: 8, highlight: true, tagline: 'Для растущей компании — до 8 модулей' },
  { key: 'production', name: 'Производство', priceMinor: 449_000_000, currency: 'UZS', maxUsers: 75, maxWarehouses: 50, maxProducts: 200_000, maxModules: null, tagline: 'Производство, MRP, партии и ОТК — все модули' },
  { key: 'enterprise', name: 'Enterprise', priceMinor: null, currency: 'UZS', maxUsers: null, maxWarehouses: null, maxProducts: null, maxModules: null, tagline: 'Холдинги: white-label, интеграции, SLA' },
];

export const PAID_PLAN_KEYS = ['starter', 'business', 'production'];
// Plans a company can pick during self-registration. 'trial' is the free 14-day tier
// (all modules); the paid tiers cap how many business modules can stay enabled.
export const SELECTABLE_PLAN_KEYS = ['trial', 'starter', 'business', 'production', 'enterprise'];

export function getPlan(key: string | null | undefined): PlanDef {
  return PLANS.find((p) => p.key === key) ?? PLANS[0];
}

export const TRIAL_DAYS = 14;
export const PERIOD_DAYS = 30;
