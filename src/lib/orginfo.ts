// Best-effort public-registry lookup by INN via orginfo.uz (server-side to avoid CORS).
// orginfo renders an SSR page whose <script type="application/ld+json"> carries a clean
// schema.org Organization object — the most stable thing to parse. Resilient: any failure
// returns null so the supplier form just stays manually editable.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface OrgLookup {
  name?: string;
  legalName?: string;
  inn?: string;
  address?: string;
  email?: string;
  phone?: string;
  status?: string; // "Active" | "Inactive" (schema.org)
  statusText?: string; // Russian status from the page body ("Действует" | "Ликвидирована"…)
  foundingDate?: string; // YYYY-MM-DD
  oked?: string; // activity code + name, e.g. "01470 - Птицеводство"
  charterCapital?: string; // e.g. "8 000 000,00 UZS"
  source: string;
}

// Strip tags/entities to a normalized text blob for label→value extraction of the extra
// fields orginfo renders in the page body (not in the JSON-LD).
function stripText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/&#x60;/g, '`').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function lookupByInn(innRaw: string): Promise<OrgLookup | null> {
  const inn = String(innRaw || '').replace(/\D/g, '');
  if (inn.length !== 9) return null;

  // 1) Search → resolve the organization slug.
  const search = await get(`https://orginfo.uz/ru/search/all/?q=${inn}`);
  if (!search) return null;
  const linkMatch = search.match(/\/ru\/organization\/([a-z0-9-]+)\//i);
  if (!linkMatch) return null;
  const slug = linkMatch[1];

  // 2) Organization page → JSON-LD Organization block.
  const page = await get(`https://orginfo.uz/ru/organization/${slug}/`);
  if (!page) return null;
  const blocks = [...page.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let org: Record<string, any> | null = null;
  for (const b of blocks) {
    try {
      const d = JSON.parse(b.trim());
      if (d && d['@type'] === 'Organization') { org = d; break; }
    } catch { /* skip malformed block */ }
  }
  if (!org) return null;

  const addr = (org.address ?? {}) as Record<string, any>;
  const address = [addr.addressLocality, addr.streetAddress].filter(Boolean).join(', ') || undefined;

  // Extra fields from the page body (best-effort; undefined if the layout shifts).
  const text = stripText(page);
  const okedM = text.match(/ОКЭД\s+(\d{3,5})\s*-\s*(.+?)(?=\s+(?:Уставный|Форма|Статус|Регион|Область|Район|Оператор|Реклама|Reklama|Телефон|Email|Адрес|Дата|Количество)|$)/);
  const oked = okedM ? `${okedM[1]} - ${okedM[2].trim()}` : undefined;
  const capM = text.match(/Уставный фонд\s+(\d[\d\s.,]*\s*[A-Z]{3})/);
  const charterCapital = capM ? capM[1].replace(/\s+/g, ' ').trim() : undefined;
  const stM = text.match(/Статус\s+([А-Яа-яЁё]+)/);
  const statusText = stM ? stM[1] : undefined;

  return {
    name: org.name ?? undefined,
    legalName: org.legalName ?? undefined,
    inn: org.taxID ?? org.identifier ?? inn,
    address,
    email: org.email ?? undefined,
    phone: org.telephone ?? undefined,
    status: org.status ?? undefined,
    statusText,
    foundingDate: org.foundingDate ?? undefined,
    oked,
    charterCapital,
    source: org.url ?? `https://orginfo.uz/ru/organization/${slug}/`,
  };
}
