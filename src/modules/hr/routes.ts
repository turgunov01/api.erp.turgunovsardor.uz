// HR / Кадры (Stage 14). Groups the people domain behind /api/v1/hr:
//   - employees registry (personal data, department/position, salary base)
//   - org structure (departments + positions)
//   - leave / time-off requests with an approval workflow
//   - monthly attendance / timesheet (worked vs. norm days)
//   - payroll runs: compute -> approve (accrue to the ledger) -> pay (cash out)
// Salary/money is integer minor units (BigInt); the global BigInt.toJSON serialises it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/ledger.js';
import { emitEvent } from '../../lib/events.js';
import { recordCashTx, ledgerCodeForKind } from '../../lib/cash.js';

type Tx = Prisma.TransactionClient;

// Uzbekistan flat personal income tax (НДФЛ). Kept as a constant; a future stage could
// make this per-tenant. Applied to gross accrued wages when computing net pay.
const INCOME_TAX_PCT = 12n;

// Compute a single payroll line. Base salary is prorated by worked/norm days, bonuses
// (accruals) are added, income tax withheld, other deductions subtracted. Net is clamped
// at zero so a mis-entered deduction can never produce negative pay.
function computePay(base: bigint, worked: number, norm: number, accruals: bigint, deductions: bigint) {
  const prorated = norm > 0 ? (base * BigInt(worked)) / BigInt(norm) : base;
  const gross = prorated + accruals;
  const tax = (gross * INCOME_TAX_PCT) / 100n;
  let net = gross - tax - deductions;
  if (net < 0n) net = 0n;
  return { grossMinor: gross, taxMinor: tax, netMinor: net };
}

function periodCodeSchema() {
  return z.string().regex(/^\d{4}-\d{2}$/, 'Формат периода: ГГГГ-ММ');
}

// Whole calendar days between two dates, inclusive.
function daysBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

async function isFinanceOn(tenantId: string): Promise<boolean> {
  const row = await prisma.tenantModule.findUnique({ where: { tenantId_moduleKey: { tenantId, moduleKey: 'finance' } } });
  return !!row?.enabled;
}

// Roll a run's stored totals up from its items.
async function refreshRunTotals(tx: Tx, runId: string) {
  const items = await tx.payrollItem.findMany({ where: { runId } });
  const totals = items.reduce(
    (a, i) => ({ g: a.g + i.grossMinor, t: a.t + i.taxMinor, n: a.n + i.netMinor }),
    { g: 0n, t: 0n, n: 0n },
  );
  await tx.payrollRun.update({ where: { id: runId }, data: { totalGrossMinor: totals.g, totalTaxMinor: totals.t, totalNetMinor: totals.n } });
}

export default async function hrRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // Dropdowns / lookups for the UI (companies, departments, positions).
  app.get('/meta', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const [companies, departments, positions] = await Promise.all([
      prisma.company.findMany({ where: { tenantId: req.auth.tid }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
      prisma.department.findMany({ where: { tenantId: req.auth.tid }, orderBy: { name: 'asc' } }),
      prisma.position.findMany({ where: { tenantId: req.auth.tid }, orderBy: { name: 'asc' } }),
    ]);
    return { companies, departments, positions };
  });

  // ==================== EMPLOYEES ====================
  app.get('/employees', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const q = z.object({ status: z.string().optional(), departmentId: z.string().optional(), q: z.string().trim().optional() }).parse(req.query);
    const where: Prisma.EmployeeWhereInput = { tenantId: req.auth.tid };
    if (q.status) where.status = q.status;
    if (q.departmentId) where.departmentId = q.departmentId;
    if (q.q) where.fullName = { contains: q.q, mode: 'insensitive' };
    const employees = await prisma.employee.findMany({
      where, include: { department: { select: { name: true } }, position: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 500,
    });
    return { employees };
  });

  const employeeBody = z.object({
    fullName: z.string().min(1).max(160),
    companyId: z.string().optional(),
    departmentId: z.string().nullish(),
    positionId: z.string().nullish(),
    hireDate: z.coerce.date().optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contract']).default('full_time'),
    baseSalaryMinor: z.number().int().min(0).default(0),
    phone: z.string().max(40).nullish(),
    email: z.string().email().max(160).nullish().or(z.literal('')),
    birthDate: z.coerce.date().nullish(),
    address: z.string().max(300).nullish(),
    note: z.string().max(500).nullish(),
  });

  app.post('/employees', { preHandler: [requirePermission('hr.write')] }, async (req, reply) => {
    const body = employeeBody.parse(req.body);
    let companyId = body.companyId;
    if (!companyId) {
      const company = await prisma.company.findFirst({ where: { tenantId: req.auth.tid }, orderBy: { createdAt: 'asc' } });
      if (!company) throw BadRequest('Сначала создайте компанию', 'NO_COMPANY');
      companyId = company.id;
    }
    const employee = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.auth.tid, 'employee', 'EMP');
      return tx.employee.create({
        data: {
          tenantId: req.auth.tid, companyId, number, fullName: body.fullName,
          departmentId: body.departmentId || null, positionId: body.positionId || null,
          hireDate: body.hireDate ?? new Date(), employmentType: body.employmentType,
          baseSalaryMinor: BigInt(body.baseSalaryMinor), phone: body.phone || null,
          email: body.email || null, birthDate: body.birthDate ?? null,
          address: body.address || null, note: body.note || null,
        },
      });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'employee.create', entity: 'Employee', entityId: employee.id, meta: { number: employee.number }, ip: req.ip });
    return reply.code(201).send({ employee });
  });

  app.get('/employees/:id', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const employee = await prisma.employee.findFirst({
      where: { id, tenantId: req.auth.tid },
      include: { department: true, position: true, company: { select: { name: true } } },
    });
    if (!employee) throw NotFound('Сотрудник не найден');
    const [leaves, attendances, payrollItems] = await Promise.all([
      prisma.leaveRequest.findMany({ where: { tenantId: req.auth.tid, employeeId: id }, orderBy: { startDate: 'desc' }, take: 50 }),
      prisma.attendance.findMany({ where: { tenantId: req.auth.tid, employeeId: id }, orderBy: { periodCode: 'desc' }, take: 24 }),
      prisma.payrollItem.findMany({ where: { tenantId: req.auth.tid, employeeId: id }, include: { run: { select: { periodCode: true, status: true } } }, orderBy: { id: 'desc' }, take: 24 }),
    ]);
    return { employee, leaves, attendances, payrollItems };
  });

  app.patch('/employees/:id', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = employeeBody.partial().parse(req.body);
    const existing = await prisma.employee.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Сотрудник не найден');
    const data: Prisma.EmployeeUpdateInput = {};
    if (body.fullName !== undefined) data.fullName = body.fullName;
    if (body.departmentId !== undefined) data.department = body.departmentId ? { connect: { id: body.departmentId } } : { disconnect: true };
    if (body.positionId !== undefined) data.position = body.positionId ? { connect: { id: body.positionId } } : { disconnect: true };
    if (body.hireDate !== undefined) data.hireDate = body.hireDate;
    if (body.employmentType !== undefined) data.employmentType = body.employmentType;
    if (body.baseSalaryMinor !== undefined) data.baseSalaryMinor = BigInt(body.baseSalaryMinor);
    if (body.phone !== undefined) data.phone = body.phone || null;
    if (body.email !== undefined) data.email = body.email || null;
    if (body.birthDate !== undefined) data.birthDate = body.birthDate ?? null;
    if (body.address !== undefined) data.address = body.address || null;
    if (body.note !== undefined) data.note = body.note || null;
    const employee = await prisma.employee.update({ where: { id }, data });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'employee.update', entity: 'Employee', entityId: id, ip: req.ip });
    return { employee };
  });

  app.post('/employees/:id/terminate', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ date: z.coerce.date().optional() }).parse(req.body ?? {});
    const existing = await prisma.employee.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Сотрудник не найден');
    if (existing.status === 'terminated') throw BadRequest('Сотрудник уже уволен', 'ALREADY_TERMINATED');
    const employee = await prisma.employee.update({ where: { id }, data: { status: 'terminated', terminationDate: body.date ?? new Date() } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'employee.terminate', entity: 'Employee', entityId: id, ip: req.ip });
    return { employee };
  });

  app.post('/employees/:id/reinstate', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.employee.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Сотрудник не найден');
    const employee = await prisma.employee.update({ where: { id }, data: { status: 'active', terminationDate: null } });
    return { employee };
  });

  // ==================== ORG STRUCTURE (departments + positions) ====================
  async function defaultCompanyId(tenantId: string): Promise<string> {
    const company = await prisma.company.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    if (!company) throw BadRequest('Сначала создайте компанию', 'NO_COMPANY');
    return company.id;
  }

  app.get('/departments', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const departments = await prisma.department.findMany({
      where: { tenantId: req.auth.tid }, include: { _count: { select: { employees: true } } }, orderBy: { name: 'asc' },
    });
    return { departments };
  });

  app.post('/departments', { preHandler: [requirePermission('hr.write')] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(120), code: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i), parentId: z.string().nullish(), companyId: z.string().optional() }).parse(req.body);
    const companyId = body.companyId ?? await defaultCompanyId(req.auth.tid);
    const department = await prisma.department.create({ data: { tenantId: req.auth.tid, companyId, name: body.name, code: body.code, parentId: body.parentId || null } });
    return reply.code(201).send({ department });
  });

  app.patch('/departments/:id', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120).optional(), parentId: z.string().nullish() }).parse(req.body);
    const existing = await prisma.department.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Подразделение не найдено');
    const department = await prisma.department.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.parentId !== undefined ? { parentId: body.parentId || null } : {}) } });
    return { department };
  });

  app.delete('/departments/:id', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.department.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Подразделение не найдено');
    const count = await prisma.employee.count({ where: { tenantId: req.auth.tid, departmentId: id } });
    if (count > 0) throw BadRequest('В подразделении есть сотрудники', 'DEPARTMENT_NOT_EMPTY');
    await prisma.department.delete({ where: { id } });
    return { ok: true };
  });

  app.get('/positions', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const positions = await prisma.position.findMany({
      where: { tenantId: req.auth.tid }, include: { _count: { select: { employees: true } } }, orderBy: { name: 'asc' },
    });
    return { positions };
  });

  app.post('/positions', { preHandler: [requirePermission('hr.write')] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(120), code: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i), companyId: z.string().optional() }).parse(req.body);
    const companyId = body.companyId ?? await defaultCompanyId(req.auth.tid);
    const position = await prisma.position.create({ data: { tenantId: req.auth.tid, companyId, name: body.name, code: body.code } });
    return reply.code(201).send({ position });
  });

  app.patch('/positions/:id', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const existing = await prisma.position.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Должность не найдена');
    const position = await prisma.position.update({ where: { id }, data: { name: body.name } });
    return { position };
  });

  app.delete('/positions/:id', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.position.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Должность не найдена');
    const count = await prisma.employee.count({ where: { tenantId: req.auth.tid, positionId: id } });
    if (count > 0) throw BadRequest('На должности есть сотрудники', 'POSITION_NOT_EMPTY');
    await prisma.position.delete({ where: { id } });
    return { ok: true };
  });

  // ==================== LEAVE / TIME-OFF ====================
  app.get('/leaves', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const q = z.object({ status: z.string().optional(), employeeId: z.string().optional() }).parse(req.query);
    const where: Prisma.LeaveRequestWhereInput = { tenantId: req.auth.tid };
    if (q.status) where.status = q.status;
    if (q.employeeId) where.employeeId = q.employeeId;
    const leaves = await prisma.leaveRequest.findMany({
      where, include: { employee: { select: { fullName: true, number: true } } },
      orderBy: { createdAt: 'desc' }, take: 300,
    });
    return { leaves };
  });

  app.post('/leaves', { preHandler: [requirePermission('hr.write')] }, async (req, reply) => {
    const body = z.object({
      employeeId: z.string(),
      type: z.enum(['vacation', 'sick', 'unpaid', 'other']).default('vacation'),
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
      reason: z.string().max(500).nullish(),
    }).parse(req.body);
    if (body.endDate < body.startDate) throw BadRequest('Дата окончания раньше начала', 'BAD_RANGE');
    const emp = await prisma.employee.findFirst({ where: { id: body.employeeId, tenantId: req.auth.tid } });
    if (!emp) throw NotFound('Сотрудник не найден');
    const days = daysBetween(body.startDate, body.endDate);
    const leave = await prisma.leaveRequest.create({
      data: { tenantId: req.auth.tid, employeeId: body.employeeId, type: body.type, startDate: body.startDate, endDate: body.endDate, days, reason: body.reason || null, createdBy: req.auth.sub },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'leave.create', entity: 'LeaveRequest', entityId: leave.id, ip: req.ip });
    return reply.code(201).send({ leave });
  });

  async function decideLeave(req: any, id: string, status: 'approved' | 'rejected') {
    const leave = await prisma.leaveRequest.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!leave) throw NotFound('Заявка не найдена');
    if (leave.status !== 'pending') throw BadRequest('Заявка уже обработана', 'ALREADY_DECIDED');
    const updated = await prisma.leaveRequest.update({ where: { id }, data: { status, decidedBy: req.auth.sub, decidedAt: new Date() } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: `leave.${status}`, entity: 'LeaveRequest', entityId: id, ip: req.ip });
    return updated;
  }

  app.post('/leaves/:id/approve', { preHandler: [requirePermission('hr.approve')] }, async (req) => {
    const { id } = req.params as { id: string };
    return { leave: await decideLeave(req, id, 'approved') };
  });

  app.post('/leaves/:id/reject', { preHandler: [requirePermission('hr.approve')] }, async (req) => {
    const { id } = req.params as { id: string };
    return { leave: await decideLeave(req, id, 'rejected') };
  });

  app.post('/leaves/:id/cancel', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const leave = await prisma.leaveRequest.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!leave) throw NotFound('Заявка не найдена');
    if (leave.status === 'rejected') throw BadRequest('Заявка отклонена', 'BAD_STATE');
    const updated = await prisma.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
    return { leave: updated };
  });

  // ==================== ATTENDANCE / TIMESHEET ====================
  app.get('/attendance', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const q = z.object({ periodCode: periodCodeSchema() }).parse(req.query);
    const attendances = await prisma.attendance.findMany({
      where: { tenantId: req.auth.tid, periodCode: q.periodCode },
      include: { employee: { select: { fullName: true, number: true } } }, orderBy: { employee: { fullName: 'asc' } },
    });
    return { periodCode: q.periodCode, attendances };
  });

  // Upsert a single employee's timesheet for a period.
  app.post('/attendance', { preHandler: [requirePermission('hr.write')] }, async (req, reply) => {
    const body = z.object({
      employeeId: z.string(), periodCode: periodCodeSchema(),
      workedDays: z.number().int().min(0).max(31), normDays: z.number().int().min(0).max(31),
      absentDays: z.number().int().min(0).max(31).default(0), note: z.string().max(300).nullish(),
    }).parse(req.body);
    const emp = await prisma.employee.findFirst({ where: { id: body.employeeId, tenantId: req.auth.tid } });
    if (!emp) throw NotFound('Сотрудник не найден');
    const attendance = await prisma.attendance.upsert({
      where: { tenantId_employeeId_periodCode: { tenantId: req.auth.tid, employeeId: body.employeeId, periodCode: body.periodCode } },
      create: { tenantId: req.auth.tid, employeeId: body.employeeId, periodCode: body.periodCode, workedDays: body.workedDays, normDays: body.normDays, absentDays: body.absentDays, note: body.note || null },
      update: { workedDays: body.workedDays, normDays: body.normDays, absentDays: body.absentDays, note: body.note || null },
    });
    return reply.code(201).send({ attendance });
  });

  // Generate timesheet rows for all active employees in a period (defaults worked = norm).
  app.post('/attendance/generate', { preHandler: [requirePermission('hr.write')] }, async (req) => {
    const body = z.object({ periodCode: periodCodeSchema(), normDays: z.number().int().min(1).max(31) }).parse(req.body);
    const employees = await prisma.employee.findMany({ where: { tenantId: req.auth.tid, status: 'active' }, select: { id: true } });
    let created = 0;
    for (const e of employees) {
      const exists = await prisma.attendance.findUnique({ where: { tenantId_employeeId_periodCode: { tenantId: req.auth.tid, employeeId: e.id, periodCode: body.periodCode } } });
      if (exists) continue;
      await prisma.attendance.create({ data: { tenantId: req.auth.tid, employeeId: e.id, periodCode: body.periodCode, workedDays: body.normDays, normDays: body.normDays } });
      created++;
    }
    return { ok: true, created, employees: employees.length };
  });

  // ==================== PAYROLL ====================
  app.get('/payroll', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const runs = await prisma.payrollRun.findMany({
      where: { tenantId: req.auth.tid }, include: { _count: { select: { items: true } } }, orderBy: { periodCode: 'desc' }, take: 60,
    });
    return { runs };
  });

  app.get('/payroll/:id', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт не найден');
    const items = await prisma.payrollItem.findMany({ where: { runId: id }, orderBy: { employeeName: 'asc' } });
    return { run, items };
  });

  // Build the item rows for a run from active employees + their attendance for the period.
  async function buildItems(tx: Tx, tenantId: string, runId: string, periodCode: string, normDays: number) {
    const employees = await tx.employee.findMany({ where: { tenantId, status: 'active' } });
    const attendance = await tx.attendance.findMany({ where: { tenantId, periodCode } });
    const attByEmp = new Map(attendance.map((a) => [a.employeeId, a]));
    await tx.payrollItem.deleteMany({ where: { runId } });
    for (const e of employees) {
      const att = attByEmp.get(e.id);
      const worked = att ? att.workedDays : normDays;
      const norm = att && att.normDays > 0 ? att.normDays : normDays;
      const pay = computePay(e.baseSalaryMinor, worked, norm, 0n, 0n);
      await tx.payrollItem.create({
        data: {
          tenantId, runId, employeeId: e.id, employeeName: e.fullName, baseSalaryMinor: e.baseSalaryMinor,
          workedDays: worked, normDays: norm, accrualsMinor: 0n, grossMinor: pay.grossMinor, taxMinor: pay.taxMinor, deductionsMinor: 0n, netMinor: pay.netMinor,
        },
      });
    }
    await refreshRunTotals(tx, runId);
  }

  app.post('/payroll', { preHandler: [requirePermission('hr.payroll')] }, async (req, reply) => {
    const body = z.object({ periodCode: periodCodeSchema(), normDays: z.number().int().min(1).max(31).default(22), note: z.string().max(300).nullish() }).parse(req.body);
    const dup = await prisma.payrollRun.findUnique({ where: { tenantId_periodCode: { tenantId: req.auth.tid, periodCode: body.periodCode } } });
    if (dup) throw BadRequest('Расчёт за этот период уже существует', 'PERIOD_EXISTS');
    const run = await prisma.$transaction(async (tx) => {
      const r = await tx.payrollRun.create({ data: { tenantId: req.auth.tid, periodCode: body.periodCode, normDays: body.normDays, note: body.note || null, createdBy: req.auth.sub } });
      await buildItems(tx, req.auth.tid, r.id, body.periodCode, body.normDays);
      return tx.payrollRun.findUnique({ where: { id: r.id } });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'payroll.create', entity: 'PayrollRun', entityId: run!.id, meta: { periodCode: body.periodCode }, ip: req.ip });
    return reply.code(201).send({ run });
  });

  app.post('/payroll/:id/recompute', { preHandler: [requirePermission('hr.payroll')] }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт не найден');
    if (run.status !== 'draft') throw BadRequest('Изменять можно только черновик', 'NOT_DRAFT');
    await prisma.$transaction((tx) => buildItems(tx, req.auth.tid, id, run.periodCode, run.normDays));
    const updated = await prisma.payrollRun.findUnique({ where: { id } });
    return { run: updated };
  });

  // Adjust a single line (bonuses / deductions / worked days) on a draft run.
  app.patch('/payroll/:id/items/:itemId', { preHandler: [requirePermission('hr.payroll')] }, async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = z.object({
      workedDays: z.number().int().min(0).max(31).optional(),
      accrualsMinor: z.number().int().min(0).optional(),
      deductionsMinor: z.number().int().min(0).optional(),
      note: z.string().max(300).nullish(),
    }).parse(req.body);
    const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт не найден');
    if (run.status !== 'draft') throw BadRequest('Изменять можно только черновик', 'NOT_DRAFT');
    const item = await prisma.payrollItem.findFirst({ where: { id: itemId, runId: id } });
    if (!item) throw NotFound('Строка не найдена');
    const worked = body.workedDays ?? item.workedDays;
    const accruals = body.accrualsMinor !== undefined ? BigInt(body.accrualsMinor) : item.accrualsMinor;
    const deductions = body.deductionsMinor !== undefined ? BigInt(body.deductionsMinor) : item.deductionsMinor;
    const pay = computePay(item.baseSalaryMinor, worked, item.normDays, accruals, deductions);
    await prisma.$transaction(async (tx) => {
      await tx.payrollItem.update({
        where: { id: itemId },
        data: { workedDays: worked, accrualsMinor: accruals, deductionsMinor: deductions, grossMinor: pay.grossMinor, taxMinor: pay.taxMinor, netMinor: pay.netMinor, ...(body.note !== undefined ? { note: body.note || null } : {}) },
      });
      await refreshRunTotals(tx, id);
    });
    const updated = await prisma.payrollRun.findUnique({ where: { id } });
    const items = await prisma.payrollItem.findMany({ where: { runId: id }, orderBy: { employeeName: 'asc' } });
    return { run: updated, items };
  });

  // Approve a run: locks the figures and accrues wages to the ledger (if finance is on).
  app.post('/payroll/:id/approve', { preHandler: [requirePermission('hr.payroll')] }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт не найден');
    if (run.status !== 'draft') throw BadRequest('Расчёт уже утверждён', 'NOT_DRAFT');
    const count = await prisma.payrollItem.count({ where: { runId: id } });
    if (count === 0) throw BadRequest('В расчёте нет сотрудников', 'EMPTY_RUN');
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.payrollRun.update({ where: { id }, data: { status: 'approved', approvedBy: req.auth.sub, approvedAt: new Date() } });
      await emitEvent('payroll.accrued', { refId: r.id, periodCode: r.periodCode, grossMinor: r.totalGrossMinor, taxMinor: r.totalTaxMinor, netMinor: r.totalNetMinor }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
      return r;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'payroll.approve', entity: 'PayrollRun', entityId: id, ip: req.ip });
    return { run: updated };
  });

  // Pay a run: cash OUT of a chosen account settling the net payable (if finance is on).
  app.post('/payroll/:id/pay', { preHandler: [requirePermission('hr.payroll')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ accountId: z.string().optional(), date: z.coerce.date().optional() }).parse(req.body ?? {});
    const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт не найден');
    if (run.status !== 'approved') throw BadRequest('Оплатить можно только утверждённый расчёт', 'NOT_APPROVED');

    const financeOn = await isFinanceOn(req.auth.tid);
    const updated = await prisma.$transaction(async (tx) => {
      if (financeOn && body.accountId) {
        const acc = await tx.finAccount.findFirst({ where: { id: body.accountId, tenantId: req.auth.tid } });
        if (!acc) throw NotFound('Счёт не найден');
        if (acc.balanceMinor < run.totalNetMinor) throw BadRequest('Недостаточно средств на счёте', 'INSUFFICIENT_FUNDS');
        await recordCashTx(tx, req.auth.tid, req.auth.sub, { id: acc.id, ledgerCode: ledgerCodeForKind(acc.kind), currency: acc.currency, balanceMinor: acc.balanceMinor }, {
          direction: 'out', category: 'payroll', amountMinor: run.totalNetMinor, date: body.date ?? new Date(),
          counterparty: `Зарплата за ${run.periodCode}`, note: `Выплата зарплаты за ${run.periodCode}`, refType: 'PayrollRun', refId: run.id,
        });
      }
      return tx.payrollRun.update({ where: { id }, data: { status: 'paid', paidAt: new Date() } });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'payroll.pay', entity: 'PayrollRun', entityId: id, meta: { netMinor: Number(run.totalNetMinor) }, ip: req.ip });
    return { run: updated, paidViaFinance: financeOn && !!body.accountId };
  });

  app.delete('/payroll/:id', { preHandler: [requirePermission('hr.payroll')] }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт не найден');
    if (run.status !== 'draft') throw BadRequest('Удалить можно только черновик', 'NOT_DRAFT');
    await prisma.payrollRun.delete({ where: { id } });
    return { ok: true };
  });

  // ==================== SUMMARY (HR dashboard) ====================
  app.get('/summary', { preHandler: [requirePermission('hr.read')] }, async (req) => {
    const tid = req.auth.tid;
    const [total, active, onLeave, terminated, pendingLeaves, lastRun] = await Promise.all([
      prisma.employee.count({ where: { tenantId: tid } }),
      prisma.employee.count({ where: { tenantId: tid, status: 'active' } }),
      prisma.employee.count({ where: { tenantId: tid, status: 'on_leave' } }),
      prisma.employee.count({ where: { tenantId: tid, status: 'terminated' } }),
      prisma.leaveRequest.count({ where: { tenantId: tid, status: 'pending' } }),
      prisma.payrollRun.findFirst({ where: { tenantId: tid }, orderBy: { periodCode: 'desc' } }),
    ]);
    return { headcount: { total, active, onLeave, terminated }, pendingLeaves, lastRun };
  });
}
