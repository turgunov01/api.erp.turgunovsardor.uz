// Business-module catalog + industry (niche) presets.
// The platform is "WordPress-like": a tenant enables the modules it needs.
// `available` modules are fully implemented; `soon` modules are on the roadmap
// and shown in the configurator so a company sees what's coming for its niche.

export type ModuleStatus = 'available' | 'soon';

export interface ModuleDef {
  key: string;
  name: string;
  description: string;
  status: ModuleStatus;
  icon: string;
}

// Core modules are always on and not shown as toggleable.
export const CORE_MODULES = ['org', 'team'] as const;

export const MODULE_CATALOG: ModuleDef[] = [
  { key: 'catalog', name: 'Товары и цены', description: 'Номенклатура, категории, единицы, прайс-листы', status: 'available', icon: '▣' },
  { key: 'warehouse', name: 'Склад и запасы', description: 'Склады, остатки, приход/расход, перемещения', status: 'available', icon: '▤' },
  { key: 'sales', name: 'Продажи', description: 'Клиенты, коммерческие предложения, заказы, резерв, отгрузки, возвраты, прайс-листы', status: 'available', icon: '↗' },
  { key: 'crm', name: 'CRM', description: 'Клиенты, сделки, воронка продаж (канбан)', status: 'available', icon: '☺' },
  { key: 'procurement', name: 'Закупки', description: 'Поставщики, заявки, заказы, приход по накладной, 3-way match', status: 'available', icon: '↘' },
  { key: 'manufacturing', name: 'Производство', description: 'Спецификации (BOM), производственные заказы, списание материалов и приход готовой продукции', status: 'available', icon: '⚙' },
  { key: 'pos', name: 'Касса / POS', description: 'Розничные продажи, смены кассиров, чеки, возвраты, X/Z-отчёты', status: 'available', icon: '🛒' },
  { key: 'projects', name: 'Проекты', description: 'Проекты, этапы, задачи (канбан), тайм-шиты и трудозатраты', status: 'available', icon: '❏' },
  { key: 'finance', name: 'Финансы и учёт', description: 'Кассы и банк, платежи, план счетов, проводки, себестоимость запасов, отчёты', status: 'available', icon: '₴' },
  { key: 'hr', name: 'Кадры и зарплата', description: 'Сотрудники, оргструктура, отпуска, табель, расчёт зарплаты', status: 'available', icon: '🧑' },
  { key: 'logistics', name: 'Логистика', description: 'Автопарк, рейсы, маршруты с точками, диспетчеризация', status: 'available', icon: '🚚' },
  { key: 'documents', name: 'Документооборот', description: 'Шаблоны, документы, версии, согласование и подпись', status: 'available', icon: '🗎' },
];

export const AVAILABLE_MODULE_KEYS = MODULE_CATALOG.filter((m) => m.status === 'available').map((m) => m.key);
export const ALL_MODULE_KEYS = MODULE_CATALOG.map((m) => m.key);

export interface NicheDef {
  key: string;
  label: string;
  modules: string[]; // suggested modules for this industry
}

export const NICHES: NicheDef[] = [
  { key: 'manufacturing', label: 'Производство', modules: ['catalog', 'warehouse', 'procurement', 'manufacturing', 'sales', 'crm', 'finance', 'hr'] },
  { key: 'retail', label: 'Ритейл / Магазин', modules: ['catalog', 'warehouse', 'sales', 'pos', 'finance'] },
  { key: 'ecommerce', label: 'Интернет-магазин', modules: ['catalog', 'warehouse', 'sales', 'crm', 'finance'] },
  { key: 'wholesale', label: 'Оптовая торговля', modules: ['catalog', 'warehouse', 'procurement', 'sales', 'finance'] },
  { key: 'construction', label: 'Строительство', modules: ['projects', 'procurement', 'warehouse', 'finance'] },
  { key: 'services', label: 'Услуги', modules: ['crm', 'projects', 'finance'] },
  { key: 'logistics', label: 'Логистика', modules: ['warehouse', 'logistics', 'sales', 'finance'] },
  { key: 'other', label: 'Другое', modules: ['catalog', 'warehouse', 'sales'] },
];

export function nicheModules(industry: string | null | undefined): string[] {
  const n = NICHES.find((x) => x.key === industry);
  return n ? n.modules : ['catalog', 'warehouse'];
}
