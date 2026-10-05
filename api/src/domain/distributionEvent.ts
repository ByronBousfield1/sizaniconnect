import { badRequest, conflict } from './errors.js';

export const EVENT_STATUSES = ['Planned', 'Stocked', 'Open', 'Closed', 'Reconciled', 'Cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventAction = 'allocateStock' | 'open' | 'close' | 'reconcile' | 'cancel';

/** The DistributionEvent lifecycle from Section 7.2 of the Task 1 documentation. */
const TRANSITIONS: Record<EventAction, { from: readonly EventStatus[]; to: EventStatus; verb: string }> = {
  allocateStock: { from: ['Planned'], to: 'Stocked', verb: 'marked as stocked' },
  open: { from: ['Stocked'], to: 'Open', verb: 'opened' },
  close: { from: ['Open'], to: 'Closed', verb: 'closed' },
  reconcile: { from: ['Closed'], to: 'Reconciled', verb: 'reconciled' },
  cancel: { from: ['Planned', 'Stocked'], to: 'Cancelled', verb: 'cancelled' },
};

export function transitionEvent(current: EventStatus, action: EventAction): EventStatus {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) {
    throw conflict('INVALID_STATUS_CHANGE', `An event that is ${current.toLowerCase()} cannot be ${rule.verb}.`, {
      current,
      action,
    });
  }
  return rule.to;
}

/** US-11: a non-zero variance between the count and the system record must be explained. */
export function assessVariance(systemCount: number, physicalCount: number, reason: string | undefined | null) {
  const variance = physicalCount - systemCount;
  const trimmed = reason?.trim() ?? '';
  if (variance !== 0 && trimmed.length < 10) {
    throw badRequest(
      'VARIANCE_REASON_REQUIRED',
      `The physical count differs from the system by ${variance > 0 ? '+' : ''}${variance}. Explain the difference in at least 10 characters.`,
      { variance },
    );
  }
  return { variance, reason: variance === 0 ? null : trimmed };
}
