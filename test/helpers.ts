// Shared test helpers: build the app once (in-process, no network) via app.inject.
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ensurePg } from '../src/pg.js';

let cached: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!cached) {
    await ensurePg();
    cached = await buildApp();
    await cached.ready();
  }
  return cached;
}

export function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

export async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  return { status: res.statusCode, body: res.json() as any };
}

export async function tokenFor(app: FastifyInstance, email: string, password: string): Promise<string> {
  const { body } = await login(app, email, password);
  return body.accessToken as string;
}
