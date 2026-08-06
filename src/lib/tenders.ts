// 9.7 Tender parsing from public Uzbek procurement portals. Each source is a resilient
// adapter: it fetches live and parses defensively, and a failing source never breaks the
// others. tenderweek.com is server-rendered (fully parsed); etender/xt-xarid are SPAs
// backed by JSON APIs (best-effort — their public list contracts may need session tokens).
import { prisma } from '../db.js';

export interface ParsedTender {
  source: string;
  externalId: string;
  title: string;
  organization?: string | null;
  category?: string | null;
  region?: string | null;
  deadline?: Date | null;
  publishedAt?: Date | null;
  amountMinor?: bigint | null;
  url: string;
}

export const TENDER_SOURCES = [
  { key: 'tenderweek', name: 'TenderWeek', url: 'https://www.tenderweek.com/' },
  { key: 'etender', name: 'UZEX E-Tender', url: 'https://etender.uzex.uz/' },
  { key: 'xt-xarid', name: 'XT-Xarid', url: 'https://xt-xarid.uz/procedure/tender' },
] as const;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru', ...(opts.headers ?? {}) } });
  } finally { clearTimeout(t); }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&#8470;/g, '№').replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Parse DD.MM.YYYY (the format the Uzbek portals use).
function parseDmy(s?: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
}

// ---- tenderweek.com — server-rendered HTML cards ----
async function fetchTenderweek(): Promise<ParsedTender[]> {
  const res = await fetchWithTimeout('https://www.tenderweek.com/');
  const html = await res.text();
  const cards = html.split('<div class="tender-card">').slice(1);
  const out: ParsedTender[] = [];
  for (const c of cards) {
    const idM = c.match(/\/tender-(\d+)/);
    if (!idM) continue;
    const externalId = idM[1];
    const title = decodeEntities((c.match(/tender-card__title[^>]*>([^<]+)</)?.[1]) || (c.match(/aria-label="([^"]+)"/)?.[1]) || '');
    const organization = decodeEntities(c.match(/tender-card__org-name[^>]*>([^<]+)</)?.[1] || '');
    const category = decodeEntities(c.match(/tender-card__cat"[^>]*title="([^"]+)"/)?.[1] || c.match(/tender-card__cat"[^>]*>([^<]+)</)?.[1] || '');
    const dateVals = [...c.matchAll(/tender-card__date-value[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    // Cards render Published then Expires; the last date is the deadline.
    const publishedAt = parseDmy(dateVals[0]);
    const deadline = parseDmy(dateVals[dateVals.length - 1]);
    if (!title) continue;
    out.push({ source: 'tenderweek', externalId, title, organization: organization || null, category: category || null, region: null, publishedAt, deadline, url: `https://www.tenderweek.com/tender-${externalId}` });
  }
  return out;
}

// ---- etender.uzex.uz — UZEX JSON API (best-effort) ----
async function fetchEtender(): Promise<ParsedTender[]> {
  const res = await fetchWithTimeout('https://apietender.uzex.uz/api/common/TradeList', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ PropertyType: 1, TradeType: 1, PageIndex: 1, PageSize: 30 }),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => []) as any;
  const rows: any[] = Array.isArray(data) ? data : (data.Items ?? data.items ?? []);
  return rows.map((r) => {
    const externalId = String(r.LotId ?? r.Id ?? r.LotNumber ?? r.TradeId ?? '');
    return {
      source: 'etender', externalId,
      title: String(r.Name ?? r.LotName ?? r.ProductName ?? 'Лот'),
      organization: r.CustomerName ?? r.OrganizationName ?? null,
      category: r.CategoryName ?? null,
      region: r.RegionName ?? null,
      deadline: r.EndDate ? new Date(r.EndDate) : null,
      publishedAt: r.StartDate ? new Date(r.StartDate) : null,
      amountMinor: r.StartCost != null ? BigInt(Math.round(Number(r.StartCost) * 100)) : null,
      url: externalId ? `https://etender.uzex.uz/tender/${externalId}` : 'https://etender.uzex.uz/',
    } as ParsedTender;
  }).filter((t) => t.externalId);
}

// ---- xt-xarid.uz — procurement portal (best-effort JSON) ----
async function fetchXtXarid(): Promise<ParsedTender[]> {
  try {
    const res = await fetchWithTimeout('https://xt-xarid.uz/api/procedures?type=tender&page=1&limit=30');
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) return [];
    const data = await res.json().catch(() => null) as any;
    const rows: any[] = Array.isArray(data) ? data : (data?.data ?? data?.items ?? data?.content ?? []);
    return rows.map((r) => {
      const externalId = String(r.id ?? r.procedureId ?? r.number ?? '');
      return {
        source: 'xt-xarid', externalId,
        title: String(r.name ?? r.title ?? r.subject ?? 'Процедура'),
        organization: r.customerName ?? r.organization ?? null,
        category: r.category ?? null, region: r.region ?? null,
        deadline: r.endDate ? new Date(r.endDate) : (r.deadline ? new Date(r.deadline) : null),
        publishedAt: r.startDate ? new Date(r.startDate) : null,
        amountMinor: r.amount != null ? BigInt(Math.round(Number(r.amount) * 100)) : null,
        url: externalId ? `https://xt-xarid.uz/procedure/tender/${externalId}` : 'https://xt-xarid.uz/procedure/tender',
      } as ParsedTender;
    }).filter((t) => t.externalId);
  } catch { return []; }
}

const ADAPTERS: Record<string, () => Promise<ParsedTender[]>> = {
  tenderweek: fetchTenderweek,
  etender: fetchEtender,
  'xt-xarid': fetchXtXarid,
};

export async function fetchSource(key: string): Promise<ParsedTender[]> {
  const fn = ADAPTERS[key];
  if (!fn) return [];
  try { return await fn(); } catch (e) { console.error(`[tenders] ${key} failed:`, (e as Error).message); return []; }
}

// Refresh all sources for a tenant: fetch live, upsert by (source, externalId).
export async function refreshTenders(tenantId: string): Promise<{ bySource: Record<string, number>; total: number }> {
  const bySource: Record<string, number> = {};
  let total = 0;
  const results = await Promise.all(TENDER_SOURCES.map((s) => fetchSource(s.key)));
  for (let i = 0; i < TENDER_SOURCES.length; i++) {
    const key = TENDER_SOURCES[i].key;
    const parsed = results[i];
    bySource[key] = parsed.length;
    for (const t of parsed) {
      await prisma.tender.upsert({
        where: { tenantId_source_externalId: { tenantId, source: t.source, externalId: t.externalId } },
        create: { tenantId, ...t, fetchedAt: new Date() },
        update: { title: t.title, organization: t.organization ?? null, category: t.category ?? null, region: t.region ?? null, deadline: t.deadline ?? null, publishedAt: t.publishedAt ?? null, amountMinor: t.amountMinor ?? null, url: t.url, fetchedAt: new Date() },
      });
      total++;
    }
  }
  return { bySource, total };
}
