// Global permission catalog + default role -> permission mapping.
// Enforced by the RBAC guard and seeded into the DB.

export interface PermissionDef {
  code: string;
  module: string;
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // Organization
  { code: 'org.read', module: 'org', description: 'View organization structure' },
  { code: 'org.manage', module: 'org', description: 'Create/edit companies, branches, departments' },
  // Catalog
  { code: 'catalog.read', module: 'catalog', description: 'View products, categories, units' },
  { code: 'catalog.write', module: 'catalog', description: 'Create/edit products, categories, units' },
  { code: 'catalog.price', module: 'catalog', description: 'See product prices (field-level)' },
  // Warehouse
  { code: 'warehouse.read', module: 'warehouse', description: 'View warehouses and stock' },
  { code: 'warehouse.manage', module: 'warehouse', description: 'Create/edit warehouses' },
  { code: 'warehouse.move', module: 'warehouse', description: 'Perform stock movements (receive/issue/adjust/transfer)' },
  { code: 'warehouse.count', module: 'warehouse', description: 'Run inventory counts and post variances' },
  { code: 'warehouse.locations', module: 'warehouse', description: 'Manage bin locations, batches/serials and reorder rules' },
  // Procurement
  { code: 'procurement.read', module: 'procurement', description: 'View suppliers, requests, orders, invoices' },
  { code: 'procurement.write', module: 'procurement', description: 'Create/edit suppliers, requests, purchase orders' },
  { code: 'procurement.approve', module: 'procurement', description: 'Approve/reject purchase requests' },
  { code: 'procurement.receive', module: 'procurement', description: 'Receive goods (goods receipt -> stock)' },
  // Sales
  { code: 'sales.read', module: 'sales', description: 'View customers, quotations, sales orders, shipments' },
  { code: 'sales.write', module: 'sales', description: 'Create/edit customers, quotations, sales orders, price lists' },
  { code: 'sales.confirm', module: 'sales', description: 'Confirm sales orders and reserve stock' },
  { code: 'sales.ship', module: 'sales', description: 'Ship goods (stock OUT) and process returns' },
  // CRM
  { code: 'crm.read', module: 'crm', description: 'View deals and the sales funnel' },
  { code: 'crm.write', module: 'crm', description: 'Create/edit deals and move funnel stages' },
  // Production / Manufacturing
  { code: 'production.read', module: 'manufacturing', description: 'View BOMs and production orders' },
  { code: 'production.write', module: 'manufacturing', description: 'Create/edit BOMs and production orders' },
  { code: 'production.confirm', module: 'manufacturing', description: 'Confirm production orders' },
  { code: 'production.execute', module: 'manufacturing', description: 'Issue materials (stock OUT) and receive finished goods (stock IN)' },
  // Finance / accounting
  { code: 'finance.read', module: 'finance', description: 'View cash accounts, journal, reports and valuation' },
  { code: 'finance.write', module: 'finance', description: 'Manage cash/bank accounts and record payments/receipts/expenses' },
  { code: 'finance.accounting', module: 'finance', description: 'Manage chart of accounts, periods and post/reverse journal entries' },
  // Analytics & AI (Stage 10)
  { code: 'analytics.read', module: 'analytics', description: 'View dashboards, KPIs, reports and forecasts' },
  { code: 'ai.use', module: 'analytics', description: 'Use the AI assistant and OCR' },
  // Studio / Marketplace / Integrations (Stage 12)
  { code: 'studio.manage', module: 'studio', description: 'Build custom forms, manage integrations and the module marketplace' },
  { code: 'forms.use', module: 'studio', description: 'Fill and view custom-form records' },
  // Логистика (Stage 17)
  { code: 'logistics.read', module: 'logistics', description: 'View fleet, deliveries and routes' },
  { code: 'logistics.write', module: 'logistics', description: 'Manage vehicles, deliveries, stops and dispatch' },
  // Проекты (Stage 16)
  { code: 'projects.read', module: 'projects', description: 'View projects, stages, tasks and timesheets' },
  { code: 'projects.write', module: 'projects', description: 'Create/edit projects, stages, tasks and log time' },
  { code: 'projects.manage', module: 'projects', description: 'Delete projects and close them' },
  // POS / Касса (Stage 15)
  { code: 'pos.use', module: 'pos', description: 'Operate the till: open/close shifts, sell, refund' },
  { code: 'pos.manage', module: 'pos', description: 'Manage registers and view POS reports' },
  // HR / Кадры (Stage 14)
  { code: 'hr.read', module: 'hr', description: 'View employees, departments, positions, leave, timesheets and payroll' },
  { code: 'hr.write', module: 'hr', description: 'Create/edit employees, org structure, timesheets and leave requests' },
  { code: 'hr.approve', module: 'hr', description: 'Approve or reject leave requests' },
  { code: 'hr.payroll', module: 'hr', description: 'Run, approve and pay payroll' },
  // Documents (Stage 9.5 — document flow)
  { code: 'documents.read', module: 'documents', description: 'View documents and templates' },
  { code: 'documents.write', module: 'documents', description: 'Create/edit documents, versions and templates' },
  { code: 'documents.approve', module: 'documents', description: 'Approve or reject documents (sign)' },
  // Admin
  { code: 'admin.users', module: 'admin', description: 'Manage users and role assignments' },
  { code: 'admin.roles', module: 'admin', description: 'Manage roles and permissions' },
  { code: 'audit.read', module: 'admin', description: 'View audit log' },
  // Tenant settings / modules
  { code: 'tenant.manage', module: 'admin', description: 'Manage tenant settings and enabled modules' },
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

// Default system roles. "owner" gets everything.
export const DEFAULT_ROLES: { code: string; name: string; description: string; permissions: string[] }[] = [
  {
    code: 'owner',
    name: 'Owner',
    description: 'Full access to everything in the tenant',
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: 'warehouse_manager',
    name: 'Warehouse Manager',
    description: 'Manages inventory and stock movements',
    permissions: ['org.read', 'catalog.read', 'catalog.price', 'warehouse.read', 'warehouse.manage', 'warehouse.move', 'warehouse.count', 'warehouse.locations', 'procurement.read', 'procurement.receive', 'sales.read', 'sales.ship'],
  },
  {
    code: 'sales_manager',
    name: 'Sales Manager',
    description: 'Manages customers, quotations, sales orders, shipments and the CRM funnel',
    permissions: ['org.read', 'catalog.read', 'catalog.price', 'warehouse.read', 'sales.read', 'sales.write', 'sales.confirm', 'sales.ship', 'crm.read', 'crm.write', 'analytics.read', 'ai.use'],
  },
  {
    code: 'production_manager',
    name: 'Production Manager',
    description: 'Manages BOMs, production orders, material issue and finished-goods receipt',
    permissions: ['org.read', 'catalog.read', 'warehouse.read', 'warehouse.move', 'production.read', 'production.write', 'production.confirm', 'production.execute'],
  },
  {
    code: 'accountant',
    name: 'Accountant',
    description: 'Manages cash, chart of accounts, journal, periods and financial reports',
    permissions: ['org.read', 'catalog.read', 'warehouse.read', 'finance.read', 'finance.write', 'finance.accounting', 'analytics.read', 'ai.use'],
  },
  {
    code: 'dispatcher',
    name: 'Dispatcher',
    description: 'Manages the vehicle fleet, deliveries and routes',
    permissions: ['org.read', 'logistics.read', 'logistics.write', 'hr.read', 'sales.read'],
  },
  {
    code: 'project_manager',
    name: 'Project Manager',
    description: 'Manages projects, stages, tasks and timesheets',
    permissions: ['org.read', 'projects.read', 'projects.write', 'projects.manage', 'hr.read', 'analytics.read'],
  },
  {
    code: 'cashier',
    name: 'Cashier',
    description: 'Operates the point-of-sale till: shifts, sales and refunds',
    permissions: ['catalog.read', 'catalog.price', 'warehouse.read', 'pos.use'],
  },
  {
    code: 'hr_manager',
    name: 'HR Manager',
    description: 'Manages employees, org structure, leave, timesheets and payroll',
    permissions: ['org.read', 'hr.read', 'hr.write', 'hr.approve', 'hr.payroll', 'analytics.read'],
  },
  {
    code: 'operator',
    name: 'Operator',
    description: 'Shop-floor operator: view catalog, receive/issue stock (no prices)',
    permissions: ['catalog.read', 'warehouse.read', 'warehouse.move'],
  },
  {
    code: 'viewer',
    name: 'Viewer',
    description: 'Read-only access',
    permissions: ['org.read', 'catalog.read', 'warehouse.read'],
  },
];
