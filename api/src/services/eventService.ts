import { assessVariance, transitionEvent, type EventStatus } from '../domain/distributionEvent.js';
import { badRequest, conflict, notFound } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import type { Repositories } from '../repositories/index.js';
import { saDate } from '../domain/time.js';
import { assertSiteScope, audit, type ServiceDeps } from './context.js';

export interface ScheduleEventInput {
  siteId: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  plannedParcels: number;
  minVolunteers?: number;
}

export class EventService {
  constructor(private readonly deps: ServiceDeps) {}

  private today() {
    return saDate(this.deps.clock());
  }

  /** US-05 */
  async schedule(actor: Actor, input: ScheduleEventInput) {
    if (input.scheduledDate < this.today()) {
      throw badRequest('DATE_IN_PAST', 'Choose today or a future date.');
    }
    if (input.endTime <= input.startTime) throw badRequest('INVALID_TIMES', 'The end time must be after the start time.');
    return this.deps.uow.run(async (r) => {
      const site = await r.events.findSite(input.siteId);
      if (!site || !site.isActive) throw badRequest('INVALID_SITE', 'Choose an active distribution site.');
      if (input.plannedParcels > site.capacityPerEvent) {
        throw badRequest(
          'CAPACITY_EXCEEDED',
          `${site.siteName} can handle at most ${site.capacityPerEvent} parcels per event.`,
          { capacity: site.capacityPerEvent },
        );
      }
      const id = await r.events.insertEvent({
        ...input,
        minVolunteers: input.minVolunteers ?? 2,
        createdBy: actor.id,
      });
      await audit(r, actor, 'DistributionEvent', id, 'CREATE', { siteId: input.siteId, date: input.scheduledDate });
      return { id, status: 'Planned' as EventStatus };
    });
  }

  async list(filter: { from?: string; to?: string; siteId?: string; status?: EventStatus }) {
    return this.deps.uow.read((r) => r.events.listEvents(filter));
  }

  async get(id: string) {
    return this.deps.uow.read(async (r) => {
      const event = await r.events.findEvent(id);
      if (!event) throw notFound('Distribution event');
      const [householdsServed, roster] = await Promise.all([r.events.householdsServed(id), r.shifts.rosterForEvent(id)]);
      return { ...event, householdsServed, roster };
    });
  }

  /**
   * Planned -> Stocked. Checks there is enough unexpired stock on the event date for the planned
   * number of medium parcels, the most common size.
   */
  async allocateStock(actor: Actor, id: string) {
    return this.deps.uow.run(async (r) => {
      const event = await this.load(r, id);
      const next = transitionEvent(event.status, 'allocateStock');
      const components = await r.stock.parcelComponents('Medium');
      if (components.length === 0) {
        throw conflict('PARCEL_NOT_CONFIGURED', 'Set up the parcel contents before stocking an event.');
      }
      const shortfalls = [];
      for (const c of components) {
        const required = c.quantity * event.plannedParcels;
        const available = await r.stock.availableOn(c.stockItemId, event.scheduledDate);
        if (available < required) shortfalls.push({ itemName: c.itemName, unitOfMeasure: c.unitOfMeasure, required, available });
      }
      if (shortfalls.length > 0) {
        throw conflict(
          'INSUFFICIENT_STOCK',
          `Not enough stock for ${event.plannedParcels} parcels: ${shortfalls.map((s) => s.itemName).join(', ')}.`,
          { shortfalls },
        );
      }
      await r.events.setStatus(id, next);
      await audit(r, actor, 'DistributionEvent', id, 'STATUS_CHANGE', { from: event.status, to: next });
      return { id, status: next };
    });
  }

  /** Stocked -> Open, only on the day, and only once enough volunteers have checked in (BR-07). */
  async open(actor: Actor, id: string) {
    return this.deps.uow.run(async (r) => {
      const event = await this.load(r, id);
      assertSiteScope(actor, event.siteId);
      const next = transitionEvent(event.status, 'open');
      if (event.scheduledDate !== this.today()) {
        throw conflict('EVENT_NOT_TODAY', `This event is scheduled for ${event.scheduledDate}. Events open on the day.`);
      }
      if (event.checkedInVolunteers < event.minVolunteers) {
        throw conflict(
          'NOT_ENOUGH_VOLUNTEERS',
          `${event.checkedInVolunteers} of the ${event.minVolunteers} volunteers needed have checked in. Open the event once they have.`,
          { checkedIn: event.checkedInVolunteers, required: event.minVolunteers },
        );
      }
      await r.events.setStatus(id, next);
      await audit(r, actor, 'DistributionEvent', id, 'STATUS_CHANGE', { from: event.status, to: next });
      return { id, status: next };
    });
  }

  async close(actor: Actor, id: string) {
    return this.deps.uow.run(async (r) => {
      const event = await this.load(r, id);
      assertSiteScope(actor, event.siteId);
      const next = transitionEvent(event.status, 'close');
      await r.events.setStatus(id, next);
      await r.shifts.recordHoursForEvent(id);
      await audit(r, actor, 'DistributionEvent', id, 'STATUS_CHANGE', { from: event.status, to: next });
      return { id, status: next, systemCount: event.collectionCount };
    });
  }

  /** US-11: compare the physical count with what the system recorded. */
  async reconcile(actor: Actor, id: string, input: { physicalCount: number; varianceReason?: string }) {
    return this.deps.uow.run(async (r) => {
      const event = await this.load(r, id);
      assertSiteScope(actor, event.siteId);
      const next = transitionEvent(event.status, 'reconcile');
      const { variance, reason } = assessVariance(event.collectionCount, input.physicalCount, input.varianceReason);
      await r.events.setStatus(id, next, { physicalCount: input.physicalCount, variance, varianceReason: reason });
      await audit(r, actor, 'DistributionEvent', id, 'RECONCILE', {
        systemCount: event.collectionCount,
        physicalCount: input.physicalCount,
        variance,
        reason,
      });
      return { id, status: next, systemCount: event.collectionCount, physicalCount: input.physicalCount, variance };
    });
  }

  async cancel(actor: Actor, id: string, reason: string) {
    if (reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Give a reason of at least 5 characters.');
    return this.deps.uow.run(async (r) => {
      const event = await this.load(r, id);
      const next = transitionEvent(event.status, 'cancel');
      await r.events.setStatus(id, next, { cancelReason: reason.trim() });
      await audit(r, actor, 'DistributionEvent', id, 'STATUS_CHANGE', { from: event.status, to: next, reason });
      return { id, status: next };
    });
  }

  private async load(r: Repositories, id: string) {
    const event = await r.events.findEvent(id, true);
    if (!event) throw notFound('Distribution event');
    return event;
  }
}
