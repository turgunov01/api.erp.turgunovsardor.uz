// Stage 12.3 — registry of external integrations. Credentials are stored encrypted
// per tenant (lib/secretbox); several map to existing stubs (payments/didox/telegram/
// email) so "connecting" here flips them from env-configured to tenant-configured.
import { prisma } from '../db.js';
import { encryptSecret, decryptSecret } from './secretbox.js';

export interface IntegrationField { key: string; label: string; secret?: boolean }
export interface IntegrationDef { key: string; name: string; category: string; description: string; icon: string; fields: IntegrationField[]; env?: string }

export const INTEGRATIONS: IntegrationDef[] = [
  { key: 'telegram', name: 'Telegram-бот', category: 'Мессенджеры', icon: '✈', description: 'Уведомления сотрудникам в Telegram', env: 'TELEGRAM_BOT_TOKEN',
    fields: [{ key: 'botToken', label: 'Bot Token', secret: true }, { key: 'chatId', label: 'Chat ID' }] },
  { key: 'smtp', name: 'Email (SMTP)', category: 'Мессенджеры', icon: '✉', description: 'Отправка писем и уведомлений', env: 'SMTP_URL',
    fields: [{ key: 'url', label: 'SMTP URL (smtp://user:pass@host:port)', secret: true }] },
  { key: 'payme', name: 'Payme', category: 'Платёжные системы', icon: '₽', description: 'Приём онлайн-платежей (Узбекистан)',
    fields: [{ key: 'merchantId', label: 'Merchant ID' }, { key: 'key', label: 'Secret Key', secret: true }] },
  { key: 'click', name: 'Click', category: 'Платёжные системы', icon: '⇢', description: 'Приём онлайн-платежей (Узбекистан)',
    fields: [{ key: 'serviceId', label: 'Service ID' }, { key: 'merchantId', label: 'Merchant ID' }, { key: 'secretKey', label: 'Secret Key', secret: true }] },
  { key: 'stripe', name: 'Stripe', category: 'Платёжные системы', icon: '§', description: 'Международные платежи картой',
    fields: [{ key: 'secretKey', label: 'Secret Key', secret: true }] },
  { key: 'didox', name: 'Didox ЭСФ', category: 'Гос-сервисы', icon: '▤', description: 'Электронные счета-фактуры (ЭСФ)', env: 'DIDOX_API_KEY',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }, { key: 'token', label: 'Token', secret: true }] },
  { key: 'telephony', name: 'Телефония (SIP)', category: 'Телефония', icon: '☎', description: 'Интеграция с АТС / звонки из CRM',
    fields: [{ key: 'sipUrl', label: 'SIP/API URL' }, { key: 'token', label: 'Token', secret: true }] },
];

export const INTEGRATION_KEYS = INTEGRATIONS.map((i) => i.key);

// Returns connection status + which secret fields are filled (never the values).
export async function integrationStatus(tenantId: string) {
  const rows = await prisma.integration.findMany({ where: { tenantId } });
  const byKey = new Map(rows.map((r) => [r.provider, r]));
  return INTEGRATIONS.map((def) => {
    const row = byKey.get(def.key);
    let filled: string[] = [];
    if (row?.configEnc) { try { filled = Object.keys(JSON.parse(decryptSecret(row.configEnc))); } catch { /* corrupt */ } }
    const envConfigured = def.env ? !!process.env[def.env] : false;
    return { ...def, status: row?.status ?? (envConfigured ? 'env' : 'disconnected'), connected: row?.status === 'connected' || envConfigured, filledFields: filled, envConfigured };
  });
}

export async function saveIntegration(tenantId: string, provider: string, config: Record<string, string>): Promise<void> {
  const def = INTEGRATIONS.find((i) => i.key === provider);
  if (!def) throw new Error('Unknown integration');
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) if (v && String(v).trim()) clean[k] = String(v).trim();
  const configEnc = Object.keys(clean).length ? encryptSecret(JSON.stringify(clean)) : null;
  await prisma.integration.upsert({
    where: { tenantId_provider: { tenantId, provider } },
    create: { tenantId, provider, status: configEnc ? 'connected' : 'disconnected', configEnc },
    update: { status: configEnc ? 'connected' : 'disconnected', configEnc },
  });
}

export async function disconnectIntegration(tenantId: string, provider: string): Promise<void> {
  await prisma.integration.updateMany({ where: { tenantId, provider }, data: { status: 'disconnected', configEnc: null } });
}
