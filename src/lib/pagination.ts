// Reusable pagination / sorting / search query parsing for list endpoints.
import { z } from 'zod';

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().trim().optional(),
});

export type PageQuery = z.infer<typeof pageQuery>;

export function skipTake(q: PageQuery) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

// Build a safe orderBy: only whitelisted fields are honoured (prevents injection).
export function safeOrderBy(
  q: PageQuery,
  allowed: readonly string[],
  fallbackField: string,
  fallbackOrder: 'asc' | 'desc' = 'asc',
): Record<string, 'asc' | 'desc'> {
  const field = q.sort && allowed.includes(q.sort) ? q.sort : fallbackField;
  const order = q.order ?? fallbackOrder;
  return { [field]: order };
}

export function pageMeta(q: PageQuery, total: number) {
  return { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}
