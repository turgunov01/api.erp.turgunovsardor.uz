// 9.1 Background job queue — DB-backed, no Redis. A single in-process worker polls
// for due jobs, runs the registered handler, and retries failed jobs with backoff.
// Jobs run OUTSIDE request transactions (they are async side-effects like sending an
// email or rebuilding a search index).
import { prisma } from '../db.js';

export interface JobContext { id: string; tenantId: string | null; attempts: number }
export type JobHandler = (payload: any, ctx: JobContext) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export interface EnqueueOpts { tenantId?: string | null; runAt?: Date; maxAttempts?: number }

// Add a job to the queue. Safe to call inside or outside a request.
export async function enqueue(type: string, payload: Record<string, unknown> = {}, opts: EnqueueOpts = {}): Promise<string> {
  const job = await prisma.job.create({
    data: {
      type, payloadJson: payload as object, tenantId: opts.tenantId ?? null,
      runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 3,
    },
  });
  return job.id;
}

// Exponential-ish backoff between retries.
function backoffMs(attempts: number): number {
  return Math.min(60_000, 2000 * 2 ** (attempts - 1));
}

async function runOne(jobId: string): Promise<void> {
  // Claim atomically: only the racer that flips queued->running proceeds.
  const claim = await prisma.job.updateMany({ where: { id: jobId, status: 'queued' }, data: { status: 'running' } });
  if (claim.count === 0) return;
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  const handler = handlers.get(job.type);
  const attempts = job.attempts + 1;
  if (!handler) {
    await prisma.job.update({ where: { id: job.id }, data: { status: 'failed', attempts, lastError: `No handler for ${job.type}` } });
    return;
  }
  try {
    const result = await handler(job.payloadJson, { id: job.id, tenantId: job.tenantId, attempts });
    await prisma.job.update({ where: { id: job.id }, data: { status: 'done', attempts, resultJson: (result ?? null) as object, lastError: null } });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (attempts >= job.maxAttempts) {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'failed', attempts, lastError: msg } });
    } else {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'queued', attempts, lastError: msg, runAt: new Date(Date.now() + backoffMs(attempts)) } });
    }
  }
}

// Process one batch of due jobs. Returns how many were attempted.
export async function drainDue(limit = 10): Promise<number> {
  const now = new Date();
  const due = await prisma.job.findMany({ where: { status: 'queued', runAt: { lte: now } }, orderBy: { runAt: 'asc' }, take: limit, select: { id: true } });
  for (const j of due) await runOne(j.id);
  return due.length;
}

let timer: NodeJS.Timeout | null = null;

// Start the polling worker. Idempotent; a no-op in test mode (tests drive drainDue directly).
export function startJobWorker(intervalMs = 3000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  const tick = async () => {
    try { await drainDue(); } catch (e) { console.error('[jobs] worker error', e); }
  };
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive
}

export function stopJobWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
