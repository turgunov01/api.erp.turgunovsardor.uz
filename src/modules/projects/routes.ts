// Проекты (Stage 16). Project management behind /api/v1/projects:
//   - projects (budget, manager, status)
//   - stages / milestones (ordered phases)
//   - tasks (kanban: todo → in_progress → review → done)
//   - timesheets: hours logged per employee, valued at the employee's hourly labour cost
// Money is integer minor units (BigInt). Labour cost snapshots on each time entry.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/ledger.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

// Standard working hours per month, used to derive an hourly rate from a monthly salary.
const MONTH_HOURS = 176; // 22 days × 8h

const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'cancelled'] as const;

export default async function projectsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // Employees for manager/assignee pickers (needs hr.read; empty if not permitted).
  app.get('/meta', { preHandler: [requirePermission('projects.read')] }, async (req) => {
    let employees: { id: string; fullName: string; baseSalaryMinor: bigint }[] = [];
    try {
      employees = await prisma.employee.findMany({ where: { tenantId: req.auth.tid, status: 'active' }, select: { id: true, fullName: true, baseSalaryMinor: true }, orderBy: { fullName: 'asc' } });
    } catch { /* HR tables absent — leave empty */ }
    return { employees };
  });

  // ==================== PROJECTS ====================
  app.get('/', { preHandler: [requirePermission('projects.read')] }, async (req) => {
    const q = z.object({ status: z.string().optional(), q: z.string().trim().optional() }).parse(req.query);
    const where: Prisma.ProjectWhereInput = { tenantId: req.auth.tid };
    if (q.status) where.status = q.status;
    if (q.q) where.name = { contains: q.q, mode: 'insensitive' };
    const projects = await prisma.project.findMany({ where, include: { _count: { select: { tasks: true } } }, orderBy: { createdAt: 'desc' }, take: 300 });
    return { projects };
  });

  const projectBody = z.object({
    name: z.string().min(1).max(160),
    description: z.string().max(2000).nullish(),
    customerName: z.string().max(160).nullish(),
    managerId: z.string().nullish(),
    status: z.enum(['planning', 'active', 'on_hold', 'done', 'cancelled']).optional(),
    startDate: z.coerce.date().nullish(),
    endDate: z.coerce.date().nullish(),
    budgetMinor: z.number().int().min(0).optional(),
  });

  async function managerName(tenantId: string, managerId?: string | null): Promise<string | null> {
    if (!managerId) return null;
    const e = await prisma.employee.findFirst({ where: { id: managerId, tenantId }, select: { fullName: true } });
    return e?.fullName ?? null;
  }

  app.post('/', { preHandler: [requirePermission('projects.write')] }, async (req, reply) => {
    const body = projectBody.parse(req.body);
    const project = await prisma.$transaction(async (tx) => {
      const code = await nextDocNumber(tx, req.auth.tid, 'project', 'PRJ');
      return tx.project.create({
        data: {
          tenantId: req.auth.tid, code, name: body.name, description: body.description || null,
          customerName: body.customerName || null, managerId: body.managerId || null, managerName: await managerName(req.auth.tid, body.managerId),
          status: body.status ?? 'planning', startDate: body.startDate ?? null, endDate: body.endDate ?? null,
          budgetMinor: BigInt(body.budgetMinor ?? 0), createdBy: req.auth.sub,
        },
      });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'project.create', entity: 'Project', entityId: project.id, meta: { code: project.code }, ip: req.ip });
    return reply.code(201).send({ project });
  });

  app.get('/:id', { preHandler: [requirePermission('projects.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const project = await prisma.project.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!project) throw NotFound('Проект не найден');
    const [stages, tasks, timeAgg, byStatus] = await Promise.all([
      prisma.projectStage.findMany({ where: { projectId: id }, orderBy: { sortOrder: 'asc' } }),
      prisma.projectTask.findMany({ where: { projectId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.timeEntry.aggregate({ where: { projectId: id }, _sum: { hours: true, costMinor: true } }),
      prisma.projectTask.groupBy({ by: ['status'], where: { projectId: id }, _count: true }),
    ]);
    const taskCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count]));
    const summary = {
      hours: Number(timeAgg._sum.hours ?? 0),
      laborCostMinor: timeAgg._sum.costMinor ?? 0n,
      budgetMinor: project.budgetMinor,
      taskCounts, taskTotal: tasks.length,
    };
    return { project, stages, tasks, summary };
  });

  app.patch('/:id', { preHandler: [requirePermission('projects.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = projectBody.partial().parse(req.body);
    const existing = await prisma.project.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Проект не найден');
    const data: Prisma.ProjectUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description || null;
    if (body.customerName !== undefined) data.customerName = body.customerName || null;
    if (body.managerId !== undefined) { data.managerId = body.managerId || null; data.managerName = await managerName(req.auth.tid, body.managerId); }
    if (body.status !== undefined) data.status = body.status;
    if (body.startDate !== undefined) data.startDate = body.startDate ?? null;
    if (body.endDate !== undefined) data.endDate = body.endDate ?? null;
    if (body.budgetMinor !== undefined) data.budgetMinor = BigInt(body.budgetMinor);
    const project = await prisma.project.update({ where: { id }, data });
    return { project };
  });

  app.delete('/:id', { preHandler: [requirePermission('projects.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.project.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Проект не найден');
    await prisma.project.delete({ where: { id } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'project.delete', entity: 'Project', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ==================== STAGES ====================
  app.post('/:id/stages', { preHandler: [requirePermission('projects.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120), dueDate: z.coerce.date().nullish() }).parse(req.body);
    const project = await prisma.project.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!project) throw NotFound('Проект не найден');
    const count = await prisma.projectStage.count({ where: { projectId: id } });
    const stage = await prisma.projectStage.create({ data: { tenantId: req.auth.tid, projectId: id, name: body.name, sortOrder: count, dueDate: body.dueDate ?? null } });
    return reply.code(201).send({ stage });
  });

  app.patch('/stages/:sid', { preHandler: [requirePermission('projects.write')] }, async (req) => {
    const { sid } = req.params as { sid: string };
    const body = z.object({ name: z.string().min(1).optional(), status: z.enum(['pending', 'active', 'done']).optional(), dueDate: z.coerce.date().nullish() }).parse(req.body);
    const stage = await prisma.projectStage.findFirst({ where: { id: sid, tenantId: req.auth.tid } });
    if (!stage) throw NotFound('Этап не найден');
    const updated = await prisma.projectStage.update({ where: { id: sid }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.status !== undefined ? { status: body.status } : {}), ...(body.dueDate !== undefined ? { dueDate: body.dueDate ?? null } : {}) } });
    return { stage: updated };
  });

  app.delete('/stages/:sid', { preHandler: [requirePermission('projects.write')] }, async (req) => {
    const { sid } = req.params as { sid: string };
    const stage = await prisma.projectStage.findFirst({ where: { id: sid, tenantId: req.auth.tid } });
    if (!stage) throw NotFound('Этап не найден');
    await prisma.projectTask.updateMany({ where: { stageId: sid }, data: { stageId: null } });
    await prisma.projectStage.delete({ where: { id: sid } });
    return { ok: true };
  });

  // ==================== TASKS ====================
  const taskBody = z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    stageId: z.string().nullish(),
    assigneeId: z.string().nullish(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    estimateHours: z.number().min(0).optional(),
    dueDate: z.coerce.date().nullish(),
  });

  async function assigneeName(tenantId: string, assigneeId?: string | null): Promise<string | null> {
    if (!assigneeId) return null;
    const e = await prisma.employee.findFirst({ where: { id: assigneeId, tenantId }, select: { fullName: true } });
    return e?.fullName ?? null;
  }

  app.post('/:id/tasks', { preHandler: [requirePermission('projects.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = taskBody.parse(req.body);
    const project = await prisma.project.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!project) throw NotFound('Проект не найден');
    const count = await prisma.projectTask.count({ where: { projectId: id } });
    const task = await prisma.projectTask.create({
      data: {
        tenantId: req.auth.tid, projectId: id, title: body.title, description: body.description || null,
        stageId: body.stageId || null, assigneeId: body.assigneeId || null, assigneeName: await assigneeName(req.auth.tid, body.assigneeId),
        status: body.status ?? 'todo', priority: body.priority ?? 'normal', estimateHours: D(body.estimateHours ?? 0),
        dueDate: body.dueDate ?? null, sortOrder: count, createdBy: req.auth.sub,
      },
    });
    return reply.code(201).send({ task });
  });

  app.patch('/tasks/:tid', { preHandler: [requirePermission('projects.write')] }, async (req) => {
    const { tid } = req.params as { tid: string };
    const body = taskBody.partial().parse(req.body);
    const task = await prisma.projectTask.findFirst({ where: { id: tid, tenantId: req.auth.tid } });
    if (!task) throw NotFound('Задача не найдена');
    const data: Prisma.ProjectTaskUpdateInput = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description || null;
    if (body.stageId !== undefined) data.stage = body.stageId ? { connect: { id: body.stageId } } : { disconnect: true };
    if (body.assigneeId !== undefined) { data.assigneeId = body.assigneeId || null; data.assigneeName = await assigneeName(req.auth.tid, body.assigneeId); }
    if (body.status !== undefined) data.status = body.status;
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.estimateHours !== undefined) data.estimateHours = D(body.estimateHours);
    if (body.dueDate !== undefined) data.dueDate = body.dueDate ?? null;
    const updated = await prisma.projectTask.update({ where: { id: tid }, data });
    return { task: updated };
  });

  app.delete('/tasks/:tid', { preHandler: [requirePermission('projects.write')] }, async (req) => {
    const { tid } = req.params as { tid: string };
    const task = await prisma.projectTask.findFirst({ where: { id: tid, tenantId: req.auth.tid } });
    if (!task) throw NotFound('Задача не найдена');
    await prisma.timeEntry.updateMany({ where: { taskId: tid }, data: { taskId: null } });
    await prisma.projectTask.delete({ where: { id: tid } });
    return { ok: true };
  });

  // ==================== TIME ENTRIES (timesheets) ====================
  app.get('/:id/time', { preHandler: [requirePermission('projects.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const entries = await prisma.timeEntry.findMany({ where: { tenantId: req.auth.tid, projectId: id }, orderBy: { date: 'desc' }, take: 500 });
    return { entries };
  });

  app.post('/:id/time', { preHandler: [requirePermission('projects.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      employeeId: z.string(),
      taskId: z.string().nullish(),
      date: z.coerce.date(),
      hours: z.number().positive().max(24),
      note: z.string().max(500).nullish(),
      billable: z.boolean().default(true),
    }).parse(req.body);
    const project = await prisma.project.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!project) throw NotFound('Проект не найден');
    const emp = await prisma.employee.findFirst({ where: { id: body.employeeId, tenantId: req.auth.tid } });
    if (!emp) throw NotFound('Сотрудник не найден');
    // Labour cost = hours × (monthly salary / standard month hours).
    const hourlyMinor = emp.baseSalaryMinor / BigInt(MONTH_HOURS);
    const costMinor = BigInt(D(body.hours).mul(hourlyMinor.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
    const entry = await prisma.timeEntry.create({
      data: { tenantId: req.auth.tid, projectId: id, taskId: body.taskId || null, employeeId: body.employeeId, employeeName: emp.fullName, date: body.date, hours: D(body.hours), note: body.note || null, billable: body.billable, costMinor, createdBy: req.auth.sub },
    });
    return reply.code(201).send({ entry });
  });

  app.delete('/time/:eid', { preHandler: [requirePermission('projects.write')] }, async (req) => {
    const { eid } = req.params as { eid: string };
    const entry = await prisma.timeEntry.findFirst({ where: { id: eid, tenantId: req.auth.tid } });
    if (!entry) throw NotFound('Запись не найдена');
    await prisma.timeEntry.delete({ where: { id: eid } });
    return { ok: true };
  });

  // ==================== SUMMARY (projects dashboard) ====================
  app.get('/summary/overview', { preHandler: [requirePermission('projects.read')] }, async (req) => {
    const tid = req.auth.tid;
    const [total, active, done, hoursAgg] = await Promise.all([
      prisma.project.count({ where: { tenantId: tid } }),
      prisma.project.count({ where: { tenantId: tid, status: 'active' } }),
      prisma.project.count({ where: { tenantId: tid, status: 'done' } }),
      prisma.timeEntry.aggregate({ where: { tenantId: tid }, _sum: { hours: true, costMinor: true } }),
    ]);
    return { total, active, done, hours: Number(hoursAgg._sum.hours ?? 0), laborCostMinor: hoursAgg._sum.costMinor ?? 0n };
  });
}
