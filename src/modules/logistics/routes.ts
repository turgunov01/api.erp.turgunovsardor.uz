// Логистика (Stage 17). Fleet + delivery routing behind /api/v1/logistics:
//   - vehicles (fleet: plate, capacity, status, assigned driver)
//   - deliveries (routes): an ordered set of stops assigned to a vehicle + driver
//   - dispatch flow: planned → in_transit (vehicle → in_use) → delivered (vehicle → available)
// Drivers are HR employees (denormalized refs + snapshot names).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/ledger.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

async function driverName(tenantId: string, driverId?: string | null): Promise<string | null> {
  if (!driverId) return null;
  const e = await prisma.employee.findFirst({ where: { id: driverId, tenantId }, select: { fullName: true } });
  return e?.fullName ?? null;
}

export default async function logisticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // Drivers (HR employees) for pickers; empty if HR data unavailable.
  app.get('/meta', { preHandler: [requirePermission('logistics.read')] }, async (req) => {
    let drivers: { id: string; fullName: string }[] = [];
    try {
      drivers = await prisma.employee.findMany({ where: { tenantId: req.auth.tid, status: 'active' }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });
    } catch { /* HR absent */ }
    const vehicles = await prisma.vehicle.findMany({ where: { tenantId: req.auth.tid, status: { not: 'maintenance' } }, select: { id: true, plate: true, model: true, status: true }, orderBy: { plate: 'asc' } });
    return { drivers, vehicles };
  });

  // ==================== VEHICLES ====================
  app.get('/vehicles', { preHandler: [requirePermission('logistics.read')] }, async (req) => {
    const vehicles = await prisma.vehicle.findMany({ where: { tenantId: req.auth.tid }, orderBy: { plate: 'asc' } });
    return { vehicles };
  });

  const vehicleBody = z.object({
    plate: z.string().min(1).max(30),
    model: z.string().max(80).nullish(),
    type: z.enum(['truck', 'van', 'car']).default('truck'),
    capacityKg: z.number().min(0).default(0),
    status: z.enum(['available', 'in_use', 'maintenance']).optional(),
    driverId: z.string().nullish(),
    note: z.string().max(300).nullish(),
  });

  app.post('/vehicles', { preHandler: [requirePermission('logistics.write')] }, async (req, reply) => {
    const body = vehicleBody.parse(req.body);
    if (await prisma.vehicle.findUnique({ where: { tenantId_plate: { tenantId: req.auth.tid, plate: body.plate } } })) throw BadRequest('ТС с таким номером уже есть', 'PLATE_EXISTS');
    const vehicle = await prisma.vehicle.create({
      data: { tenantId: req.auth.tid, plate: body.plate, model: body.model || null, type: body.type, capacityKg: D(body.capacityKg), status: body.status ?? 'available', driverId: body.driverId || null, driverName: await driverName(req.auth.tid, body.driverId), note: body.note || null },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'vehicle.create', entity: 'Vehicle', entityId: vehicle.id, ip: req.ip });
    return reply.code(201).send({ vehicle });
  });

  app.patch('/vehicles/:id', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = vehicleBody.partial().parse(req.body);
    const existing = await prisma.vehicle.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('ТС не найдено');
    const data: Prisma.VehicleUpdateInput = {};
    if (body.model !== undefined) data.model = body.model || null;
    if (body.type !== undefined) data.type = body.type;
    if (body.capacityKg !== undefined) data.capacityKg = D(body.capacityKg);
    if (body.status !== undefined) data.status = body.status;
    if (body.driverId !== undefined) { data.driverId = body.driverId || null; data.driverName = await driverName(req.auth.tid, body.driverId); }
    if (body.note !== undefined) data.note = body.note || null;
    const vehicle = await prisma.vehicle.update({ where: { id }, data });
    return { vehicle };
  });

  app.delete('/vehicles/:id', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.vehicle.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('ТС не найдено');
    const active = await prisma.delivery.count({ where: { tenantId: req.auth.tid, vehicleId: id, status: { in: ['planned', 'in_transit'] } } });
    if (active > 0) throw BadRequest('У ТС есть активные рейсы', 'VEHICLE_BUSY');
    await prisma.vehicle.delete({ where: { id } });
    return { ok: true };
  });

  // ==================== DELIVERIES ====================
  app.get('/deliveries', { preHandler: [requirePermission('logistics.read')] }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const where: Prisma.DeliveryWhereInput = { tenantId: req.auth.tid };
    if (q.status) where.status = q.status;
    const deliveries = await prisma.delivery.findMany({ where, include: { _count: { select: { stops: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
    return { deliveries };
  });

  const stopInput = z.object({ address: z.string().min(1).max(300), customerName: z.string().max(160).nullish(), salesRef: z.string().max(60).nullish(), note: z.string().max(300).nullish() });

  app.post('/deliveries', { preHandler: [requirePermission('logistics.write')] }, async (req, reply) => {
    const body = z.object({
      vehicleId: z.string().nullish(),
      driverId: z.string().nullish(),
      scheduledDate: z.coerce.date().nullish(),
      costMinor: z.number().int().min(0).default(0),
      note: z.string().max(300).nullish(),
      stops: z.array(stopInput).default([]),
    }).parse(req.body);

    let vehiclePlate: string | null = null;
    if (body.vehicleId) {
      const v = await prisma.vehicle.findFirst({ where: { id: body.vehicleId, tenantId: req.auth.tid } });
      if (!v) throw NotFound('ТС не найдено');
      vehiclePlate = v.plate;
    }
    const delivery = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.auth.tid, 'delivery', 'DLV');
      const d = await tx.delivery.create({
        data: {
          tenantId: req.auth.tid, number, vehicleId: body.vehicleId || null, vehiclePlate,
          driverId: body.driverId || null, driverName: await driverName(req.auth.tid, body.driverId),
          scheduledDate: body.scheduledDate ?? null, costMinor: BigInt(body.costMinor), note: body.note || null, createdBy: req.auth.sub,
        },
      });
      for (let i = 0; i < body.stops.length; i++) {
        const s = body.stops[i];
        await tx.deliveryStop.create({ data: { tenantId: req.auth.tid, deliveryId: d.id, sequence: i, address: s.address, customerName: s.customerName || null, salesRef: s.salesRef || null, note: s.note || null } });
      }
      return d;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'delivery.create', entity: 'Delivery', entityId: delivery.id, meta: { number: delivery.number }, ip: req.ip });
    return reply.code(201).send({ delivery });
  });

  app.get('/deliveries/:id', { preHandler: [requirePermission('logistics.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const delivery = await prisma.delivery.findFirst({ where: { id, tenantId: req.auth.tid }, include: { vehicle: { select: { plate: true, model: true } } } });
    if (!delivery) throw NotFound('Рейс не найден');
    const stops = await prisma.deliveryStop.findMany({ where: { deliveryId: id }, orderBy: { sequence: 'asc' } });
    return { delivery, stops };
  });

  app.patch('/deliveries/:id', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ vehicleId: z.string().nullish(), driverId: z.string().nullish(), scheduledDate: z.coerce.date().nullish(), costMinor: z.number().int().min(0).optional(), note: z.string().max(300).nullish() }).parse(req.body);
    const delivery = await prisma.delivery.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!delivery) throw NotFound('Рейс не найден');
    if (delivery.status === 'delivered' || delivery.status === 'cancelled') throw BadRequest('Рейс завершён', 'DELIVERY_CLOSED');
    const data: Prisma.DeliveryUpdateInput = {};
    if (body.vehicleId !== undefined) {
      if (body.vehicleId) { const v = await prisma.vehicle.findFirst({ where: { id: body.vehicleId, tenantId: req.auth.tid } }); if (!v) throw NotFound('ТС не найдено'); data.vehicle = { connect: { id: v.id } }; data.vehiclePlate = v.plate; }
      else { data.vehicle = { disconnect: true }; data.vehiclePlate = null; }
    }
    if (body.driverId !== undefined) { data.driverId = body.driverId || null; data.driverName = await driverName(req.auth.tid, body.driverId); }
    if (body.scheduledDate !== undefined) data.scheduledDate = body.scheduledDate ?? null;
    if (body.costMinor !== undefined) data.costMinor = BigInt(body.costMinor);
    if (body.note !== undefined) data.note = body.note || null;
    const updated = await prisma.delivery.update({ where: { id }, data });
    return { delivery: updated };
  });

  // Dispatch: planned → in_transit, marks the vehicle in_use.
  app.post('/deliveries/:id/dispatch', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const delivery = await prisma.delivery.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!delivery) throw NotFound('Рейс не найден');
    if (delivery.status !== 'planned') throw BadRequest('Отправить можно только запланированный рейс', 'NOT_PLANNED');
    const stops = await prisma.deliveryStop.count({ where: { deliveryId: id } });
    if (stops === 0) throw BadRequest('В рейсе нет точек маршрута', 'NO_STOPS');
    const updated = await prisma.$transaction(async (tx) => {
      if (delivery.vehicleId) await tx.vehicle.update({ where: { id: delivery.vehicleId }, data: { status: 'in_use' } });
      return tx.delivery.update({ where: { id }, data: { status: 'in_transit', dispatchedAt: new Date() } });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'delivery.dispatch', entity: 'Delivery', entityId: id, ip: req.ip });
    return { delivery: updated };
  });

  // Complete: in_transit → delivered, frees the vehicle, marks remaining stops completed.
  app.post('/deliveries/:id/complete', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const delivery = await prisma.delivery.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!delivery) throw NotFound('Рейс не найден');
    if (delivery.status !== 'in_transit') throw BadRequest('Завершить можно только рейс в пути', 'NOT_IN_TRANSIT');
    const updated = await prisma.$transaction(async (tx) => {
      await tx.deliveryStop.updateMany({ where: { deliveryId: id, status: { in: ['pending', 'arrived'] } }, data: { status: 'completed' } });
      if (delivery.vehicleId) await tx.vehicle.update({ where: { id: delivery.vehicleId }, data: { status: 'available' } });
      return tx.delivery.update({ where: { id }, data: { status: 'delivered', completedAt: new Date() } });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'delivery.complete', entity: 'Delivery', entityId: id, ip: req.ip });
    return { delivery: updated };
  });

  app.post('/deliveries/:id/cancel', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const delivery = await prisma.delivery.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!delivery) throw NotFound('Рейс не найден');
    if (delivery.status === 'delivered' || delivery.status === 'cancelled') throw BadRequest('Рейс уже завершён', 'DELIVERY_CLOSED');
    const updated = await prisma.$transaction(async (tx) => {
      if (delivery.vehicleId) await tx.vehicle.update({ where: { id: delivery.vehicleId }, data: { status: 'available' } });
      return tx.delivery.update({ where: { id }, data: { status: 'cancelled' } });
    });
    return { delivery: updated };
  });

  // ==================== STOPS ====================
  app.post('/deliveries/:id/stops', { preHandler: [requirePermission('logistics.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = stopInput.parse(req.body);
    const delivery = await prisma.delivery.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!delivery) throw NotFound('Рейс не найден');
    const count = await prisma.deliveryStop.count({ where: { deliveryId: id } });
    const stop = await prisma.deliveryStop.create({ data: { tenantId: req.auth.tid, deliveryId: id, sequence: count, address: body.address, customerName: body.customerName || null, salesRef: body.salesRef || null, note: body.note || null } });
    return reply.code(201).send({ stop });
  });

  app.patch('/stops/:sid', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { sid } = req.params as { sid: string };
    const body = z.object({ status: z.enum(['pending', 'arrived', 'completed', 'failed']).optional(), note: z.string().max(300).nullish() }).parse(req.body);
    const stop = await prisma.deliveryStop.findFirst({ where: { id: sid, tenantId: req.auth.tid } });
    if (!stop) throw NotFound('Точка не найдена');
    const updated = await prisma.deliveryStop.update({ where: { id: sid }, data: { ...(body.status !== undefined ? { status: body.status, arrivedAt: body.status === 'arrived' || body.status === 'completed' ? (stop.arrivedAt ?? new Date()) : stop.arrivedAt } : {}), ...(body.note !== undefined ? { note: body.note || null } : {}) } });
    return { stop: updated };
  });

  app.delete('/stops/:sid', { preHandler: [requirePermission('logistics.write')] }, async (req) => {
    const { sid } = req.params as { sid: string };
    const stop = await prisma.deliveryStop.findFirst({ where: { id: sid, tenantId: req.auth.tid } });
    if (!stop) throw NotFound('Точка не найдена');
    await prisma.deliveryStop.delete({ where: { id: sid } });
    return { ok: true };
  });

  // ==================== SUMMARY ====================
  app.get('/summary', { preHandler: [requirePermission('logistics.read')] }, async (req) => {
    const tid = req.auth.tid;
    const [vehicles, available, inTransit, planned, deliveredToday] = await Promise.all([
      prisma.vehicle.count({ where: { tenantId: tid } }),
      prisma.vehicle.count({ where: { tenantId: tid, status: 'available' } }),
      prisma.delivery.count({ where: { tenantId: tid, status: 'in_transit' } }),
      prisma.delivery.count({ where: { tenantId: tid, status: 'planned' } }),
      prisma.delivery.count({ where: { tenantId: tid, status: 'delivered' } }),
    ]);
    return { vehicles, availableVehicles: available, inTransit, planned, delivered: deliveredToday };
  });
}
