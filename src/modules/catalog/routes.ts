// Catalog module: units, categories, products. Tenant-scoped.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { assertWithinLimit } from '../../lib/limits.js';
import { audit } from '../../lib/audit.js';
import { Conflict, NotFound, BadRequest } from '../../lib/errors.js';
import { pageQuery, skipTake, safeOrderBy, pageMeta } from '../../lib/pagination.js';
import { moneyMinor } from '../../lib/validators.js';

const unitSchema = z.object({ name: z.string().min(1), code: z.string().min(1), precision: z.number().int().min(0).max(6).default(0) });
const categorySchema = z.object({ name: z.string().min(1), code: z.string().min(1), parentId: z.string().optional() });
const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['stockable', 'service']).default('stockable'),
  categoryId: z.string().optional(),
  unitId: z.string().optional(),
  priceMinor: moneyMinor.default(0),
  currency: z.string().default('UZS'),
  barcode: z.string().optional(),
  tracking: z.enum(['none', 'batch', 'serial']).optional(), // Stage 7.3 lot/serial tracking
});

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ---- Units ----
  app.get('/units', { preHandler: [requirePermission('catalog.read')] }, async (req) => {
    return { units: await prisma.unit.findMany({ where: { tenantId: req.auth.tid }, orderBy: { code: 'asc' } }) };
  });
  app.post('/units', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const body = unitSchema.parse(req.body);
    const unit = await prisma.unit.create({ data: { ...body, tenantId: req.auth.tid } });
    return reply.code(201).send({ unit });
  });

  // ---- Categories ----
  app.get('/categories', { preHandler: [requirePermission('catalog.read')] }, async (req) => {
    const rows = await prisma.category.findMany({
      where: { tenantId: req.auth.tid },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    // Flatten the product count so the UI can show usage + guard deletes.
    const categories = rows.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
    return { categories };
  });
  app.post('/categories', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const body = categorySchema.parse(req.body);
    const clash = await prisma.category.findFirst({ where: { tenantId: req.auth.tid, code: body.code } });
    if (clash) throw Conflict(`Категория с кодом «${body.code}» уже существует`, 'CATEGORY_CODE_EXISTS');
    const category = await prisma.category.create({ data: { ...body, parentId: body.parentId || null, tenantId: req.auth.tid } });
    return reply.code(201).send({ category });
  });
  app.patch('/categories/:id', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = categorySchema.partial().parse(req.body);
    const existing = await prisma.category.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Категория не найдена');
    if (body.parentId === id) throw BadRequest('Категория не может быть родителем самой себе', 'CATEGORY_SELF_PARENT');
    if (body.code && body.code !== existing.code) {
      const clash = await prisma.category.findFirst({ where: { tenantId: req.auth.tid, code: body.code, NOT: { id } } });
      if (clash) throw Conflict(`Категория с кодом «${body.code}» уже существует`, 'CATEGORY_CODE_EXISTS');
    }
    const data = { ...body, ...(body.parentId !== undefined ? { parentId: body.parentId || null } : {}) };
    const category = await prisma.category.update({ where: { id }, data });
    return reply.send({ category });
  });
  app.delete('/categories/:id', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.category.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Категория не найдена');
    const productCount = await prisma.product.count({ where: { tenantId: req.auth.tid, categoryId: id } });
    if (productCount > 0) throw Conflict(`Нельзя удалить: к категории привязано товаров — ${productCount}`, 'CATEGORY_IN_USE');
    const childCount = await prisma.category.count({ where: { tenantId: req.auth.tid, parentId: id } });
    if (childCount > 0) throw Conflict(`Нельзя удалить: есть подкатегории — ${childCount}`, 'CATEGORY_HAS_CHILDREN');
    await prisma.category.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // ---- Products (paginated + searchable + sortable) ----
  app.get('/products', { preHandler: [requirePermission('catalog.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = {
      tenantId: req.auth.tid,
      status: 'active',
      ...(q.search
        ? { OR: [
            { name: { contains: q.search, mode: 'insensitive' as const } },
            { sku: { contains: q.search, mode: 'insensitive' as const } },
            { barcode: { contains: q.search, mode: 'insensitive' as const } },
          ] }
        : {}),
    };
    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        orderBy: safeOrderBy(q, ['name', 'sku', 'priceMinor', 'createdAt'], 'name'),
        include: { unit: true, category: true },
        ...skipTake(q),
      }),
      prisma.product.count({ where }),
    ]);
    // Field-level: hide prices from users without catalog.price.
    const canPrice = req.auth.perms.includes('catalog.price');
    const masked = canPrice ? products : products.map((p) => ({ ...p, priceMinor: null }));
    return { products: masked, meta: pageMeta(q, total), priceVisible: canPrice };
  });

  app.post('/products', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const body = productSchema.parse(req.body);
    await assertWithinLimit(req.auth.tid, 'products');
    const exists = await prisma.product.findFirst({ where: { tenantId: req.auth.tid, sku: body.sku } });
    if (exists) throw Conflict(`Product with SKU "${body.sku}" already exists`, 'SKU_EXISTS');
    const product = await prisma.product.create({ data: { ...body, tenantId: req.auth.tid } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'catalog.product.create', entity: 'Product', entityId: product.id, meta: { sku: body.sku }, ip: req.ip });
    return reply.code(201).send({ product });
  });

  // Auto-generate a unique SKU from category code + party: {CATCODE}-{PARTY}-{NNN}.
  // Both category and party are REQUIRED — otherwise generation is refused with an error.
  app.post('/products/generate-sku', { preHandler: [requirePermission('catalog.write')] }, async (req) => {
    const body = z.object({
      categoryId: z.string().min(1),
      party: z.string().min(1),
    }).parse(req.body);
    const category = await prisma.category.findFirst({ where: { id: body.categoryId, tenantId: req.auth.tid } });
    if (!category) throw NotFound('Категория не найдена');
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 16);
    const cat = norm(category.code);
    const party = norm(body.party);
    if (!cat) throw BadRequest('Код категории пуст — задайте код в категории', 'CATEGORY_CODE_EMPTY');
    if (!party) throw BadRequest('Партия должна содержать буквы или цифры', 'PARTY_INVALID');
    const prefix = `${cat}-${party}-`;
    // Find the highest existing sequence for this category+party prefix, then increment.
    // Format: {CAT}-{PARTY}-{NNN}-{RND5} (NNN = readable running number, RND5 = numeric suffix).
    const siblings = await prisma.product.findMany({
      where: { tenantId: req.auth.tid, sku: { startsWith: prefix } },
      select: { sku: true },
    });
    let max = 0;
    for (const s of siblings) {
      const m = s.sku.slice(prefix.length).match(/^(\d+)/); // first numeric group after prefix = NNN
      if (m) max = Math.max(max, Number(m[1]));
    }
    const seq = max + 1;
    const rnd = () => String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    let sku = `${prefix}${String(seq).padStart(3, '0')}-${rnd()}`;
    // Regenerate the numeric suffix on the (near-impossible) chance of a full clash.
    for (let attempt = 0; attempt < 50 && (await prisma.product.findFirst({ where: { tenantId: req.auth.tid, sku } })); attempt++) {
      sku = `${prefix}${String(seq).padStart(3, '0')}-${rnd()}`;
    }
    return { sku };
  });

  app.patch('/products/:id', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = productSchema.partial().omit({ sku: true }).parse(req.body);
    const existing = await prisma.product.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Товар не найден');
    const product = await prisma.product.update({ where: { id }, data: body });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'catalog.product.update', entity: 'Product', entityId: id, ip: req.ip });
    return reply.send({ product });
  });

  // ---- Barcodes (Stage 7.5) ----
  // EAN-13 check digit: weights 1,3 alternating over the first 12 digits.
  function ean13Check(d12: string): string {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
  }
  // Generate a unique EAN-13 barcode (200-prefix = internal/in-store range).
  app.post('/products/:id/barcode', { preHandler: [requirePermission('catalog.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const product = await prisma.product.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!product) throw NotFound('Товар не найден');
    let code = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const base = '200' + String(Math.floor(Date.now() % 1_000_000_000)).padStart(9, '0').slice(-9);
      code = base + ean13Check(base);
      const clash = await prisma.product.findFirst({ where: { tenantId: req.auth.tid, barcode: code, NOT: { id } } });
      if (!clash) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    const updated = await prisma.product.update({ where: { id }, data: { barcode: code } });
    return reply.send({ product: updated });
  });

  // Scan lookup: resolve a product by its barcode.
  app.get('/products/by-barcode/:code', { preHandler: [requirePermission('catalog.read')] }, async (req) => {
    const { code } = req.params as { code: string };
    const product = await prisma.product.findFirst({ where: { tenantId: req.auth.tid, barcode: code }, include: { category: true, unit: true } });
    if (!product) throw NotFound('Товар с таким штрихкодом не найден');
    return { product };
  });
}
