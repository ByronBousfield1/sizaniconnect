import type { EventStatus, HouseholdStatus, Role } from './types';

const TZ = 'Africa/Johannesburg';

export const fmtDate = (value: string | null | undefined) => {
  if (!value) return '—';
  const d = value.length === 10 ? new Date(`${value}T12:00:00+02:00`) : new Date(value);
  return d.toLocaleDateString('en-ZA', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('en-ZA', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

export const fmtTime = (value: string) =>
  new Date(value).toLocaleTimeString('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

export const fmtRand = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n);

export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function todaySA(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const ROLE_LABELS: Record<Role, string> = {
  Admin: 'Administrator',
  OperationsManager: 'Operations manager',
  SiteCoordinator: 'Site coordinator',
  Volunteer: 'Volunteer',
  Donor: 'Donor',
};

export const HOUSEHOLD_STATUS: Record<HouseholdStatus, { label: string; tone: Tone }> = {
  Draft: { label: 'Returned for correction', tone: 'warn' },
  PendingVerification: { label: 'Waiting for verification', tone: 'warn' },
  Active: { label: 'Active', tone: 'good' },
  Suspended: { label: 'Suspended', tone: 'bad' },
  Archived: { label: 'Archived', tone: 'neutral' },
};

export const EVENT_STATUS: Record<EventStatus, { label: string; tone: Tone }> = {
  Planned: { label: 'Planned', tone: 'neutral' },
  Stocked: { label: 'Stocked', tone: 'info' },
  Open: { label: 'Open now', tone: 'good' },
  Closed: { label: 'Closed, not reconciled', tone: 'warn' },
  Reconciled: { label: 'Reconciled', tone: 'neutral' },
  Cancelled: { label: 'Cancelled', tone: 'bad' },
};

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
