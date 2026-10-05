import { Router } from 'express';
import { z } from 'zod';
import { HOUSEHOLD_STATUSES } from '../../domain/household.js';
import type { Services } from '../../services/index.js';
import { actorOf, requireRole } from '../middleware/auth.js';
import { idParam, optionalText, paging, parse, personName, phone, text, uuid } from '../validation.js';

const member = z.object({
  firstName: personName('First name'),
  ageBand: z.enum(['0-5', '6-12', '13-17', '18-59', '60+'], { errorMap: () => ({ message: 'Choose an age band.' }) }),
  dependantType: z.enum(['Self', 'Spouse', 'Child', 'Elderly', 'Other'], {
    errorMap: () => ({ message: 'Choose a relationship.' }),
  }),
});

const registerSchema = z.object({
  headOfHousehold: personName('Head of household'),
  idNumber: z.string({ required_error: 'ID or passport number is required.' }).max(30),
  contactNumber: phone,
  addressLine: text('Address', 3, 200),
  suburb: text('Suburb', 2, 80),
  homeSiteId: uuid('Site'),
  members: z.array(member).min(1, 'Add at least one household member.').max(20, 'A household can have at most 20 members.'),
});

const updateSchema = z
  .object({
    headOfHousehold: personName('Head of household').optional(),
    contactNumber: phone,
    addressLine: text('Address', 3, 200).optional(),
    suburb: text('Suburb', 2, 80).optional(),
    members: z.array(member).min(1).max(20).optional(),
  })
  .strict();

export function householdRoutes(services: Services) {
  const router = Router();
  const staff = requireRole('SiteCoordinator', 'OperationsManager', 'Admin');
  const desk = requireRole('Volunteer', 'SiteCoordinator', 'OperationsManager');

  router.get('/', staff, async (req, res) => {
    const q = parse(
      z.object({
        q: z.string().trim().max(80).optional(),
        status: z.enum(HOUSEHOLD_STATUSES).optional(),
        siteId: uuid('Site').optional(),
        ...paging,
      }),
      req.query,
    );
    res.json(await services.households.search(q));
  });

  router.post('/', requireRole('SiteCoordinator', 'OperationsManager'), async (req, res) => {
    const body = parse(registerSchema, req.body);
    const result = await services.households.register(actorOf(req), body);
    res.status(201).location(`/api/v1/households/${result.id}`).json(result);
  });

  router.get('/by-ref/:code', desk, async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(20) }), req.params);
    const { eventId } = parse(z.object({ eventId: uuid('Event').optional() }), req.query);
    res.json(await services.households.lookupByReference(code, eventId));
  });

  router.post('/archive-inactive', requireRole('OperationsManager', 'Admin'), async (req, res) => {
    res.json(await services.households.archiveInactive(actorOf(req)));
  });

  router.get('/:id', staff, async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await services.households.get(id));
  });

  router.get('/:id/export', requireRole('OperationsManager', 'Admin'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const data = await services.households.exportSubjectData(actorOf(req), id);
    res.setHeader('Content-Disposition', `attachment; filename="household-${id}.json"`);
    res.json(data);
  });

  router.patch('/:id', requireRole('SiteCoordinator', 'OperationsManager'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(updateSchema, req.body);
    res.json(await services.households.update(actorOf(req), id, body));
  });

  const statusAction = (action: Parameters<Services['households']['changeStatus']>[2], ...roles: Parameters<typeof requireRole>) =>
    router.post(`/:id/${action === 'returnForCorrection' ? 'return' : action}`, requireRole(...roles), async (req, res) => {
      const { id } = parse(idParam, req.params);
      const { reason } = parse(z.object({ reason: optionalText('Reason', 300) }).partial(), req.body ?? {});
      res.json(await services.households.changeStatus(actorOf(req), id, action, reason ?? undefined));
    });

  // BR-03: verification is an operations manager decision.
  statusAction('verify', 'OperationsManager');
  statusAction('returnForCorrection', 'OperationsManager');
  statusAction('resubmit', 'SiteCoordinator', 'OperationsManager');
  statusAction('suspend', 'SiteCoordinator', 'OperationsManager');
  statusAction('reinstate', 'OperationsManager');
  statusAction('archive', 'OperationsManager', 'Admin');

  return router;
}
