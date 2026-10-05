import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../services/index.js';
import { actorOf, requireRole } from '../middleware/auth.js';
import { email, idParam, isoDate, optionalText, parse, text, uuid } from '../validation.js';

export function supplyRoutes(services: Services) {
  const router = Router();
  const ops = requireRole('OperationsManager');
  const opsOrAdmin = requireRole('OperationsManager', 'Admin');

  // ---- donors & donations
  router.get('/donors', opsOrAdmin, async (_req, res) => {
    res.json(await services.donations.listDonors());
  });

  router.post('/donors', ops, async (req, res) => {
    const body = parse(
      z.object({
        donorName: text('Donor name', 2, 150),
        donorType: z.enum(['Individual', 'Corporate', 'Trust', 'Government'], {
          errorMap: () => ({ message: 'Choose a donor type.' }),
        }),
        contactEmail: z.union([email, z.literal(''), z.null()]).optional(),
        isAnonymous: z.boolean().optional(),
      }),
      req.body,
    );
    res.status(201).json(await services.donations.createDonor(actorOf(req), body));
  });

  router.get('/donations', opsOrAdmin, async (req, res) => {
    const q = parse(z.object({ donorId: uuid('Donor').optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
    res.json(await services.donations.list(q));
  });

  router.post('/donations', ops, async (req, res) => {
    const body = parse(
      z.object({
        donorId: uuid('Donor'),
        donationType: z.enum(['Cash', 'InKind'], { errorMap: () => ({ message: 'Choose cash or in-kind.' }) }),
        monetaryValue: z.number().min(0).max(100_000_000).optional(),
        receivedOn: isoDate('Received on'),
        notes: optionalText('Notes', 300),
        lines: z
          .array(
            z.object({
              stockItemId: uuid('Item'),
              quantity: z.number({ invalid_type_error: 'Quantity must be a number.' }).positive('Quantity must be more than zero.').max(1_000_000),
              expiryDate: isoDate('Expiry date').nullish(),
            }),
          )
          .max(50)
          .optional(),
      }),
      req.body,
    );
    res.status(201).json(await services.donations.capture(actorOf(req), { ...body, notes: body.notes ?? undefined }));
  });

  router.get('/donations/:id', requireRole('OperationsManager', 'Admin', 'Donor'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.donations.get(actorOf(req), id));
  });

  // ---- stock
  router.get('/stock/items', requireRole('OperationsManager', 'SiteCoordinator', 'Admin'), async (_req, res) => {
    res.json(await services.stock.items());
  });

  router.post('/stock/items', ops, async (req, res) => {
    const body = parse(
      z.object({
        itemName: text('Item name', 2, 100),
        category: text('Category', 2, 50),
        unitOfMeasure: text('Unit', 1, 20),
        reorderLevel: z.number().min(0).max(1_000_000),
      }),
      req.body,
    );
    res.status(201).json(await services.stock.createItem(actorOf(req), body));
  });

  router.get('/stock/items/:id/batches', requireRole('OperationsManager', 'SiteCoordinator', 'Admin'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.stock.batches(id));
  });

  router.get('/stock/alerts', requireRole('OperationsManager', 'SiteCoordinator', 'Admin'), async (_req, res) => {
    res.json(await services.stock.alerts());
  });

  router.post('/stock/batches/:id/write-off', ops, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: text('Reason', 5, 300) }), req.body);
    res.json(await services.stock.writeOff(actorOf(req), id, reason));
  });

  router.get('/parcels', requireRole('OperationsManager', 'SiteCoordinator', 'Volunteer', 'Admin'), async (_req, res) => {
    res.json(await services.stock.parcels());
  });

  return router;
}
