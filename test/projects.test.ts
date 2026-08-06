// Stage 16 — Проекты: projects, stages, tasks (kanban), timesheets with labour cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);
const uniq = () => Math.floor(performance.now() * 1000).toString(36);

test('Projects: demo project seeded with stages and tasks', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const list = (await app.inject({ url: '/api/v1/projects', headers: H(token) })).json();
  const demo = list.projects.find((p: any) => p.code === 'PRJ-2026-00001');
  assert.ok(demo, 'seeded project present');
  const detail = (await app.inject({ url: `/api/v1/projects/${demo.id}`, headers: H(token) })).json();
  assert.ok(detail.stages.length >= 3, 'stages seeded');
  assert.ok(detail.tasks.length >= 5, 'tasks seeded');
  assert.ok(Number(detail.summary.hours) > 0, 'time logged');
});

test('Projects: create → stage → task → move status → log time (labour cost)', async () => {
  const app = await getApp();
  const token = await ownerToken();

  const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: H(token), payload: { name: `Проект ${uniq()}`, budgetMinor: 1_000_000_000 } });
  assert.equal(created.statusCode, 201);
  const project = created.json().project;
  assert.match(project.code, /^PRJ-\d{4}-\d{5}$/);
  assert.equal(project.status, 'planning');

  // Stage
  const stage = (await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/stages`, headers: H(token), payload: { name: 'Этап 1' } })).json().stage;
  assert.equal(stage.sortOrder, 0);

  // Task in that stage
  const task = (await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/tasks`, headers: H(token), payload: { title: 'Задача 1', stageId: stage.id, priority: 'high', estimateHours: 4 } })).json().task;
  assert.equal(task.status, 'todo');

  // Move it across the board.
  const moved = await app.inject({ method: 'PATCH', url: `/api/v1/projects/tasks/${task.id}`, headers: H(token), payload: { status: 'in_progress' } });
  assert.equal(moved.json().task.status, 'in_progress');

  // Log time by a real employee → cost = hours × (salary / 176), rounded.
  const meta = (await app.inject({ url: '/api/v1/projects/meta', headers: H(token) })).json();
  const emp = meta.employees[0];
  assert.ok(emp, 'employee available for time log');
  const hours = 8;
  const entry = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/time`, headers: H(token), payload: { employeeId: emp.id, taskId: task.id, date: '2026-07-10', hours } });
  assert.equal(entry.statusCode, 201);
  const hourly = Math.floor(Number(emp.baseSalaryMinor) / 176);
  assert.equal(Number(entry.json().entry.costMinor), Math.round(hours * hourly));

  // Summary reflects the logged hours + cost.
  const detail = (await app.inject({ url: `/api/v1/projects/${project.id}`, headers: H(token) })).json();
  assert.equal(Number(detail.summary.hours), hours);
  assert.equal(Number(detail.summary.laborCostMinor), Math.round(hours * hourly));
  assert.equal(detail.summary.taskCounts.in_progress, 1);

  // Delete project (manage).
  const del = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${project.id}`, headers: H(token) });
  assert.equal(del.statusCode, 200);
});

test('Projects RBAC: operator without projects.read is denied (403)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ url: '/api/v1/projects', headers: H(token) });
  assert.equal(res.statusCode, 403);
});
