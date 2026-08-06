// 9.3 Realtime via Server-Sent Events (no Socket.IO). A tiny in-process pub/sub:
// SSE handlers subscribe a client (keyed by tenant+user); publishers push events.
// Single-process only — fine for the local/embedded deployment model.
import type { FastifyReply } from 'fastify';

interface Client { tenantId: string; userId: string; reply: FastifyReply }

const clients = new Set<Client>();

export function addClient(reply: FastifyReply, tenantId: string, userId: string): Client {
  const client: Client = { tenantId, userId, reply };
  clients.add(client);
  return client;
}

export function removeClient(client: Client): void {
  clients.delete(client);
}

function write(client: Client, event: string, data: unknown): void {
  try {
    client.reply.raw.write(`event: ${event}\n`);
    client.reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

// Push to a specific user (all their open tabs).
export function publishToUser(tenantId: string, userId: string, event: string, data: unknown): void {
  for (const c of clients) if (c.tenantId === tenantId && c.userId === userId) write(c, event, data);
}

// Push to everyone in a tenant (e.g. live stock changes).
export function publishToTenant(tenantId: string, event: string, data: unknown): void {
  for (const c of clients) if (c.tenantId === tenantId) write(c, event, data);
}

export function connectedCount(): number { return clients.size; }
