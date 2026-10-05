import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '../../domain/roles.js';
import type { Services } from '../../services/index.js';
import { actorOf, requireRole } from '../middleware/auth.js';
import { email, idParam, isoDate, paging, parse, personName, phone, text, uuid } from '../validation.js';

export function adminRoutes(services: Services) {
  const router = Router();
  const admin = requireRole('Admin');

  router.get('/users', admin, async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(80).optional(), role: z.enum(ROLES).optional() }), req.query);
    res.json(await services.admin.listUsers(q));
  });

  router.post('/users', admin, async (req, res) => {
    const body = parse(
      z.object({
        fullName: personName('Full name'),
        email,
        phoneNumber: phone,
        role: z.enum(ROLES, { errorMap: () => ({ message: 'Choose a role.' }) }),
        siteId: uuid('Site').nullish(),
        donorId: uuid('Donor').nullish(),
      }),
      req.body,
    );
    res.status(201).json(await services.admin.createUser(actorOf(req), body));
  });

  router.patch('/users/:id', admin, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          fullName: personName('Full name').optional(),
          phoneNumber: phone,
          role: z.enum(ROLES).optional(),
          siteId: uuid('Site').nullish(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    res.json(await services.admin.updateUser(actorOf(req), id, body));
  });

  router.get('/sites', requireRole('Admin', 'OperationsManager', 'SiteCoordinator', 'Volunteer'), async (_req, res) => {
    res.json(await services.admin.listSites());
  });

  router.post('/sites', admin, async (req, res) => {
    const body = parse(
      z.object({
        siteName: text('Site name', 3, 100),
        suburb: text('Suburb', 2, 80),
        capacityPerEvent: z.number().int().min(1).max(5000),
      }),
      req.body,
    );
    res.status(201).json(await services.admin.createSite(actorOf(req), body));
  });

  router.patch('/sites/:id', admin, async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z
        .object({
          siteName: text('Site name', 3, 100).optional(),
          suburb: text('Suburb', 2, 80).optional(),
          capacityPerEvent: z.number().int().min(1).max(5000).optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    res.json(await services.admin.updateSite(actorOf(req), id, body));
  });

  router.get('/audit', admin, async (req, res) => {
    const q = parse(
      z.object({
        entityName: z.string().max(60).optional(),
        userId: uuid('User').optional(),
        from: isoDate('From').optional(),
        to: isoDate('To').optional(),
        ...paging,
      }),
      req.query,
    );
    res.json(await services.admin.auditLog(q));
  });

  return router;
}

export function reportRoutes(services: Services) {
  const router = Router();
  const month = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must look like 2026-10.') });

  router.get('/reports/monthly', requireRole('OperationsManager', 'Admin'), async (req, res) => {
    const q = parse(month, req.query);
    res.json(await services.reports.monthly(q.month));
  });

  router.get('/reports/monthly.csv', requireRole('OperationsManager', 'Admin'), async (req, res) => {
    const q = parse(month, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sizani-monthly-${q.month}.csv"`);
    res.send(await services.reports.monthlyCsv(q.month));
  });

  router.get('/dashboard', async (req, res) => {
    res.json(await services.reports.dashboard(actorOf(req)));
  });

  // Donor portal: every query is scoped by the donor id in the verified token, never by a URL parameter.
  router.get('/me/impact', requireRole('Donor'), async (req, res) => {
    res.json(await services.reports.donorImpact(actorOf(req)));
  });

  return router;
}
