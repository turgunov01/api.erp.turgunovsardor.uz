// Stage 10.3/10.4 AI client. Per-tenant config: each tenant sets its own provider,
// model and API key (encrypted at rest). Falls back to server env vars if unset.
// Supports Anthropic and OpenAI. Read-only: the assistant only answers over a snapshot
// we assemble server-side; it never gets write tools. Without a key → honest stub.
import { prisma } from '../db.js';
import { decryptSecret } from './secretbox.js';

export type Provider = 'anthropic' | 'openai';

// Suggested models per provider (clients may also type a custom model id).
export const AI_MODELS: Record<Provider, { id: string; name: string }[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 — быстрый, дешёвый' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 — сбалансированный' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 — самый мощный' },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini — быстрый, дешёвый' },
    { id: 'gpt-4o', name: 'GPT-4o — сбалансированный' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
  ],
};

const DEFAULT_MODEL: Record<Provider, string> = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' };
const STUB = 'AI-функции отключены: не задан API-ключ. Откройте настройки AI, выберите провайдера и модель и вставьте свой ключ.';

export interface AiConfig { provider: Provider; apiKey?: string; model: string; enabled: boolean; source: 'tenant' | 'env' | 'none' }

export async function getAiConfig(tenantId: string): Promise<AiConfig> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { aiProvider: true, aiApiKeyEnc: true, aiModel: true } });
  const provider = (t?.aiProvider === 'openai' ? 'openai' : 'anthropic') as Provider;
  let apiKey: string | undefined;
  let source: AiConfig['source'] = 'none';
  if (t?.aiApiKeyEnc) { try { apiKey = decryptSecret(t.aiApiKeyEnc); source = 'tenant'; } catch { /* corrupt */ } }
  if (!apiKey) {
    const envKey = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    if (envKey) { apiKey = envKey; source = 'env'; }
  }
  const model = t?.aiModel || (source === 'env' && provider === 'anthropic' ? process.env.AI_MODEL || DEFAULT_MODEL[provider] : DEFAULT_MODEL[provider]);
  return { provider, apiKey, model, enabled: !!apiKey, source };
}

interface Msg { system: string; userText?: string; image?: { data: string; mediaType: string }; maxTokens?: number }

async function call(cfg: AiConfig, m: Msg): Promise<string> {
  if (cfg.provider === 'openai') {
    const content: any[] = [];
    if (m.userText) content.push({ type: 'text', text: m.userText });
    if (m.image) content.push({ type: 'image_url', image_url: { url: `data:${m.image.mediaType};base64,${m.image.data}` } });
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, max_tokens: m.maxTokens ?? 800, messages: [{ role: 'system', content: m.system }, { role: 'user', content: content.length === 1 && !m.image ? m.userText : content }] }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json() as any;
    return (j.choices?.[0]?.message?.content ?? '').trim();
  }
  // Anthropic
  const content: any[] = [];
  if (m.image) content.push({ type: 'image', source: { type: 'base64', media_type: m.image.mediaType, data: m.image.data } });
  if (m.userText) content.push({ type: 'text', text: m.userText });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': cfg.apiKey as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, max_tokens: m.maxTokens ?? 800, system: m.system, messages: [{ role: 'user', content: m.image ? content : (m.userText ?? '') }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as any;
  return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
}

export async function askAI(cfg: AiConfig, question: string, snapshot: unknown): Promise<{ answer: string; enabled: boolean }> {
  if (!cfg.enabled) return { answer: STUB, enabled: false };
  const system = 'Ты — аналитик-ассистент ERP-системы TTR ONE. Отвечай кратко и по-деловому на русском, опираясь ТОЛЬКО на переданные данные (JSON). Суммы даны в тийинах (делите на 100 для сум). Если данных нет — так и скажи. Не выдумывай цифры.';
  const answer = await call(cfg, { system, userText: `Данные компании (JSON):\n${JSON.stringify(snapshot)}\n\nВопрос: ${question}`, maxTokens: 700 });
  return { answer: answer || 'Не удалось получить ответ.', enabled: true };
}

export async function ocrInvoice(cfg: AiConfig, imageBase64: string, mediaType: string): Promise<{ enabled: boolean; supplier?: string; lines?: { name: string; quantity: number; priceMinor: number }[]; raw?: string }> {
  if (!cfg.enabled) return { enabled: false, raw: STUB };
  const prompt = 'Извлеки из этой накладной/счёта данные строго в JSON: {"supplier": string, "lines": [{"name": string, "quantity": number, "priceMinor": number}]}. priceMinor — цена за единицу в тийинах (сумма×100). Верни ТОЛЬКО JSON.';
  const text = await call(cfg, { system: 'Ты извлекаешь данные из документов и возвращаешь только JSON.', userText: prompt, image: { data: imageBase64, mediaType }, maxTokens: 1500 });
  try {
    const json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
    return { enabled: true, supplier: json.supplier, lines: Array.isArray(json.lines) ? json.lines : [] };
  } catch { return { enabled: true, raw: text }; }
}
