import { badRequest, conflict, forbidden, notFound } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { assertSiteScope, audit, type ServiceDeps } from './context.js';

const DAY_MS = 86_400_000;

export class ShiftService {
  constructor(private readonly deps: ServiceDeps) {}

  async publish(actor: Actor, input: { eventId: string; startsAt: string; endsAt: string; volunteersNeeded: number; notes?: string }) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (!(endsAt > startsAt)) throw badRequest('INVALID_TIMES', 'The shift must end after it starts.');
    return this.deps.uow.run(async (r) => {
      const event = await r.events.findEvent(input.eventId);
      if (!event) throw notFound('Distribution event');
      assertSiteScope(actor, event.siteId);
      if (['Closed', 'Reconciled', 'Cancelled'].includes(event.status)) {
        throw conflict('EVENT_FINISHED', 'Shifts can only be added to events that have not finished.');
      }
      const id = await r.shifts.insert({
        eventId: event.id,
        startsAt,
        endsAt,
        volunteersNeeded: input.volunteersNeeded,
        notes: input.notes?.trim() || null,
      });
      await audit(r, actor, 'VolunteerShift', id, 'CREATE', { eventId: event.id });
      return { id };
    });
  }

  /** US-06: shifts in the next 14 days, with places remaining. */
  async board(actor: Actor, filter: { siteId?: string; eventId?: string; days?: number }) {
    const now = this.deps.clock();
    return this.deps.uow.read((r) =>
      r.shifts.list(actor.id, {
        from: now,
        to: new Date(now.getTime() + (filter.days ?? 14) * DAY_MS),
        siteId: filter.siteId,
        eventId: filter.eventId,
      }),
    );
  }

  async mine(actor: Actor) {
    return this.deps.uow.read((r) => r.shifts.listMine(actor.id));
  }

  /** US-07 */
  async signUp(actor: Actor, shiftId: string) {
    return this.deps.uow.run(async (r) => {
      const shift = await r.shifts.find(shiftId, actor.id, true);
      if (!shift) throw notFound('Shift');
      if (shift.startsAt <= this.deps.clock()) throw conflict('SHIFT_STARTED', 'This shift has already started.');
      if (shift.myStatus === 'Assigned' || shift.myStatus === 'CheckedIn') {
        throw conflict('ALREADY_SIGNED_UP', 'You are already signed up for this shift.');
      }
      if (shift.filled >= shift.volunteersNeeded) throw conflict('SHIFT_FULL', 'This shift is full. Choose another one.');
      await r.shifts.assign(shift.id, actor.id);
      await audit(r, actor, 'ShiftAssignment', shift.id, 'SIGN_UP');
      return { shiftId: shift.id, status: 'Assigned' };
    });
  }

  /** US-07: withdrawal more than 24 hours ahead releases the place and tells the coordinator. */
  async withdraw(actor: Actor, shiftId: string) {
    const shift = await this.deps.uow.run(async (r) => {
      const s = await r.shifts.find(shiftId, actor.id, true);
      if (!s) throw notFound('Shift');
      const assignment = await r.shifts.findAssignment(s.id, actor.id);
      if (!assignment || assignment.status !== 'Assigned') {
        throw conflict('NOT_SIGNED_UP', 'You are not signed up for this shift.');
      }
      if (s.startsAt.getTime() - this.deps.clock().getTime() < DAY_MS) {
        throw conflict(
          'WITHDRAW_TOO_LATE',
          'This shift starts within 24 hours. Phone your site coordinator so they can find cover.',
        );
      }
      await r.shifts.setAssignmentStatus(assignment.id, 'Withdrawn');
      await audit(r, actor, 'ShiftAssignment', s.id, 'WITHDRAW');
      return s;
    });
    await this.deps.bus.publish({
      type: 'ShiftWithdrawn',
      shiftId: shift.id,
      volunteerName: actor.name,
      siteId: shift.siteId,
      startsAt: shift.startsAt.toISOString(),
    });
    return { shiftId: shift.id, status: 'Withdrawn' };
  }

  /** US-08 / BR-10: check-in opens 60 minutes before the shift and closes when it ends. */
  async checkIn(actor: Actor, shiftId: string) {
    return this.deps.uow.run(async (r) => {
      const shift = await r.shifts.find(shiftId, actor.id, true);
      if (!shift) throw notFound('Shift');
      const assignment = await r.shifts.findAssignment(shift.id, actor.id);
      if (!assignment) throw forbidden('Sign up for this shift before checking in.');
      if (assignment.status === 'CheckedIn') throw conflict('ALREADY_CHECKED_IN', 'You are already checked in.');
      if (assignment.status !== 'Assigned') throw conflict('NOT_SIGNED_UP', 'You withdrew from this shift.');

      const now = this.deps.clock().getTime();
      const opensAt = shift.startsAt.getTime() - this.deps.config.checkinWindowMinutes * 60_000;
      if (now < opensAt) {
        throw conflict(
          'CHECKIN_NOT_OPEN',
          `Check-in opens ${this.deps.config.checkinWindowMinutes} minutes before the shift starts.`,
          { opensAt: new Date(opensAt).toISOString() },
        );
      }
      if (now > shift.endsAt.getTime()) throw conflict('SHIFT_ENDED', 'This shift has ended.');

      await r.shifts.setAssignmentStatus(assignment.id, 'CheckedIn');
      await audit(r, actor, 'ShiftAssignment', shift.id, 'CHECK_IN');
      return { shiftId: shift.id, status: 'CheckedIn' };
    });
  }
}
