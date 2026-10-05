import { Router } from 'express';
import { z } from 'zod';
import { EVENT_STATUSES } from '../../domain/distributionEvent.js';
import type { Services } from '../../services/index.js';
import { actorOf, requireRole } from '../middleware/auth.js';
import { clockTime, idParam, isoDate, optionalText, parse, text, uuid } from '../validation.js';

export function eventRoutes(services: Services) {
  const router = Router();
  const anyStaff = requireRole('Volunteer', 'SiteCoordinator', 'OperationsManager', 'Admin');
  const runners = requireRole('SiteCoordinator', 'OperationsManager');

  router.get('/', anyStaff, async (req, res) => {
    const q = parse(
      z.object({
        from: isoDate('From').optional(),
        to: isoDate('To').optional(),
        siteId: uuid('Site').optional(),
        status: z.enum(EVENT_STATUSES).optional(),
      }),
      req.query,
    );
    res.json(await services.events.list(q));
  });

  router.post('/', requireRole('OperationsManager'), async (req, res) => {
    const body = parse(
      z.object({
        siteId: uuid('Site'),
        scheduledDate: isoDate('Date'),
        startTime: clockTime('Start time'),
        endTime: clockTime('End time'),
        plannedParcels: z.number({ invalid_type_error: 'Planned parcels must be a number.' }).int().min(1).max(5000),
        minVolunteers: z.number().int().min(0).max(50).optional(),
      }),
      req.body,
    );
    res.status(201).json(await services.events.schedule(actorOf(req), body));
  });

  router.get('/:id', anyStaff, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.events.get(id));
  });

  router.get('/:id/collections', anyStaff, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.collections.listForEvent(id));
  });

  router.post('/:id/stock', requireRole('OperationsManager'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.events.allocateStock(actorOf(req), id));
  });

  router.post('/:id/open', runners, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.events.open(actorOf(req), id));
  });

  router.post('/:id/close', runners, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.events.close(actorOf(req), id));
  });

  router.post('/:id/reconcile', runners, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        physicalCount: z.number({ required_error: 'Enter the number of parcels counted.' }).int().min(0).max(10000),
        varianceReason: optionalText('Reason', 500),
      }),
      req.body,
    );
    res.json(await services.events.reconcile(actorOf(req), id, { ...body, varianceReason: body.varianceReason ?? undefined }));
  });

  router.post('/:id/cancel', requireRole('OperationsManager'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: text('Reason', 5, 300) }), req.body);
    res.json(await services.events.cancel(actorOf(req), id, reason));
  });

  return router;
}

export function collectionRoutes(services: Services) {
  const router = Router();
  router.post('/', requireRole('Volunteer', 'SiteCoordinator', 'OperationsManager'), async (req, res) => {
    const body = parse(
      z.object({
        eventId: uuid('Event'),
        householdId: uuid('Household'),
        override: z.boolean().optional(),
        overrideReason: optionalText('Override reason', 300),
      }),
      req.body,
    );
    const result = await services.collections.record(actorOf(req), { ...body, overrideReason: body.overrideReason ?? undefined });
    res.status(201).json(result);
  });
  return router;
}

export function shiftRoutes(services: Services) {
  const router = Router();
  const volunteers = requireRole('Volunteer', 'SiteCoordinator');

  router.get('/', requireRole('Volunteer', 'SiteCoordinator', 'OperationsManager'), async (req, res) => {
    const q = parse(
      z.object({ siteId: uuid('Site').optional(), eventId: uuid('Event').optional(), days: z.coerce.number().int().min(1).max(60).optional() }),
      req.query,
    );
    res.json(await services.shifts.board(actorOf(req), q));
  });

  router.get('/mine', volunteers, async (req, res) => {
    res.json(await services.shifts.mine(actorOf(req)));
  });

  router.post('/', requireRole('SiteCoordinator', 'OperationsManager'), async (req, res) => {
    const body = parse(
      z.object({
        eventId: uuid('Event'),
        startsAt: z.string().datetime({ offset: true, message: 'Start must be a date and time.' }),
        endsAt: z.string().datetime({ offset: true, message: 'End must be a date and time.' }),
        volunteersNeeded: z.number().int().min(1).max(50),
        notes: optionalText('Notes', 200),
      }),
      req.body,
    );
    res.status(201).json(await services.shifts.publish(actorOf(req), { ...body, notes: body.notes ?? undefined }));
  });

  for (const [path, fn] of [
    ['signup', 'signUp'],
    ['withdraw', 'withdraw'],
    ['checkin', 'checkIn'],
  ] as const) {
    router.post(`/:id/${path}`, volunteers, async (req, res) => {
      const { id } = parse(idParam, req.params);
      res.json(await services.shifts[fn](actorOf(req), id));
    });
  }

  return router;
}
