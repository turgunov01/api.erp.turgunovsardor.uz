// Centralized, validated configuration. No hardcoded secrets in code.
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  // Encrypts stored secrets at rest (AI keys, integration creds). Falls back to JWT_SECRET
  // in dev; MUST be set independently in production (see the prod check below).
  SECRET_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Comma-separated allowlist of browser origins. Empty = reflect request origin (dev).
  CORS_ORIGINS: z.string().default(''),
  // Rate limit for auth endpoints
  AUTH_RATE_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW: z.string().default('1 minute'),
  // Public base URL (used to build password-reset links)
  APP_URL: z.string().default('http://localhost:3000'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@demo-factory.com'),
  SEED_ADMIN_PASSWORD: z.string().min(6).default('Admin123!'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';

// Production security gate: refuse to boot with insecure defaults (13.3 hardening).
if (isProd) {
  const errs: string[] = [];
  if (config.JWT_SECRET.length < 32) errs.push('JWT_SECRET must be at least 32 characters');
  if (!config.SECRET_KEY || config.SECRET_KEY.length < 32) errs.push('SECRET_KEY must be set (>= 32 chars) to encrypt stored credentials');
  if (config.SECRET_KEY && config.SECRET_KEY === config.JWT_SECRET) errs.push('SECRET_KEY must differ from JWT_SECRET (separate blast radius)');
  if (!config.CORS_ORIGINS.trim()) errs.push('CORS_ORIGINS must be an explicit allowlist (no reflect-any-origin in prod)');
  if (config.SEED_ADMIN_PASSWORD === 'Admin123!') errs.push('SEED_ADMIN_PASSWORD must be changed from the demo default');
  if (errs.length) {
    console.error('❌ Production security check failed:\n - ' + errs.join('\n - '));
    process.exit(1);
  }
}
