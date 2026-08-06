// 9.6 Cross-entity search. Postgres case-insensitive matching across the main business
// objects (no OpenSearch/Docker). Tenant-scoped; each hit carries a type + link target
// so the UI can route to the right page.
import { prisma } from '../db.js';

export interface SearchHit { type: string; id: string; title: string; subtitle?: string; to: string }

export async function searchAll(tenantId: string, q: string, limit = 8): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = { contains: term, mode: 'insensitive' as const };

  const [products, customers, suppliers, documents] = await Promise.all([
    prisma.product.findMany({ where: { tenantId, OR: [{ name: like }, { sku: like }] }, take: limit, select: { id: true, name: true, sku: true } }),
    prisma.customer.findMany({ where: { tenantId, OR: [{ name: like }, { code: like }] }, take: limit, select: { id: true, name: true, code: true } }),
    prisma.supplier.findMany({ where: { tenantId, OR: [{ name: like }, { code: like }] }, take: limit, select: { id: true, name: true, code: true } }),
    prisma.document.findMany({ where: { tenantId, OR: [{ title: like }, { number: like }] }, take: limit, select: { id: true, title: true, number: true, status: true } }),
  ]);

  const hits: SearchHit[] = [];
  for (const p of products) hits.push({ type: 'product', id: p.id, title: p.name, subtitle: p.sku, to: '/products' });
  for (const c of customers) hits.push({ type: 'customer', id: c.id, title: c.name, subtitle: c.code, to: '/customers' });
  for (const s of suppliers) hits.push({ type: 'supplier', id: s.id, title: s.name, subtitle: s.code, to: '/suppliers' });
  for (const d of documents) hits.push({ type: 'document', id: d.id, title: d.title, subtitle: `${d.number} · ${d.status}`, to: '/documents' });
  return hits;
}
