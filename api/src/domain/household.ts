import { conflict } from './errors.js';

export const HOUSEHOLD_STATUSES = ['Draft', 'PendingVerification', 'Active', 'Suspended', 'Archived'] as const;
export type HouseholdStatus = (typeof HOUSEHOLD_STATUSES)[number];

export type HouseholdAction = 'verify' | 'returnForCorrection' | 'resubmit' | 'suspend' | 'reinstate' | 'archive';

/** The lifecycle from the state diagram in Section 7.2 of the Task 1 documentation. */
const TRANSITIONS: Record<HouseholdAction, { from: readonly HouseholdStatus[]; to: HouseholdStatus; verb: string }> = {
  verify: { from: ['PendingVerification'], to: 'Active', verb: 'verified' },
  returnForCorrection: { from: ['PendingVerification'], to: 'Draft', verb: 'returned for correction' },
  resubmit: { from: ['Draft'], to: 'PendingVerification', verb: 'resubmitted' },
  suspend: { from: ['Active'], to: 'Suspended', verb: 'suspended' },
  reinstate: { from: ['Suspended'], to: 'Active', verb: 'reinstated' },
  archive: { from: ['Active', 'Suspended'], to: 'Archived', verb: 'archived' },
};

export const STATUS_LABELS: Record<HouseholdStatus, string> = {
  Draft: 'returned for correction',
  PendingVerification: 'waiting for verification',
  Active: 'active',
  Suspended: 'suspended',
  Archived: 'archived',
};

export function transitionHousehold(current: HouseholdStatus, action: HouseholdAction): HouseholdStatus {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) {
    throw conflict(
      'INVALID_STATUS_CHANGE',
      `A household that is ${STATUS_LABELS[current]} cannot be ${rule.verb}.`,
      { current, action },
    );
  }
  return rule.to;
}

/** BR-02: only an active household may be issued a parcel. */
export function isEligibleForParcel(status: HouseholdStatus): boolean {
  return status === 'Active';
}

/** Details may be corrected until a household is suspended or archived. */
export function canEditDetails(status: HouseholdStatus): boolean {
  return status === 'Draft' || status === 'PendingVerification' || status === 'Active';
}
