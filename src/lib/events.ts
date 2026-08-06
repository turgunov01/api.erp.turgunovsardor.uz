// Minimal in-process domain-event bus (Stage 8.4). Handlers run synchronously and
// inside the caller's DB transaction, so auto-postings commit atomically with the
// business fact that triggered them (a shipment and its journal entry succeed or
// fail together). The finance module registers handlers at startup; if no handler
// is registered (finance disabled at the code level) emitting is a no-op.
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface EventContext {
  tx: Tx;
  tenantId: string;
  userId?: string | null;
}

export type EventHandler = (payload: any, ctx: EventContext) => Promise<void>;

const handlers: Record<string, EventHandler[]> = {};

export function onEvent(type: string, handler: EventHandler): void {
  (handlers[type] ||= []).push(handler);
}

// Emit within a transaction. Handlers run in registration order; a throwing handler
// aborts the surrounding transaction (intended — postings must not silently drop).
export async function emitEvent(type: string, payload: any, ctx: EventContext): Promise<void> {
  const hs = handlers[type];
  if (!hs || hs.length === 0) return;
  for (const h of hs) await h(payload, ctx);
}

// Test/support: clear registrations (used so repeated app builds don't double-register).
export function resetEventHandlers(): void {
  for (const k of Object.keys(handlers)) delete handlers[k];
}
