import { forbidden } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { monthRange, saDate } from '../domain/time.js';
import type { ServiceDeps } from './context.js';

/** CSV injection guard: a cell starting with = + - @ is executed as a formula by spreadsheet apps. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class ReportService {
  constructor(private readonly deps: ServiceDeps) {}

  /** US-15: households served, parcels issued and volunteer hours per site for one month. */
  async monthly(month: string) {
    const { start, end } = monthRange(month);
    return this.deps.uow.read(async (r) => {
      const [sites, donations, distinctHouseholds] = await Promise.all([
        r.reports.monthlyBySite(start, end),
        r.reports.donationsInRange(start, end),
        r.reports.distinctHouseholdsInRange(start, end),
      ]);
      const totals = sites.reduce(
        (t, s) => ({
          eventsHeld: t.eventsHeld + s.eventsHeld,
          parcelsIssued: t.parcelsIssued + s.parcelsIssued,
          overrides: t.overrides + s.overrides,
          volunteerHours: Math.round((t.volunteerHours + s.volunteerHours) * 100) / 100,
        }),
        { eventsHeld: 0, parcelsIssued: 0, overrides: 0, volunteerHours: 0 },
      );
      // Households are counted once across sites, not summed, since one household may visit two sites.
      return { month, sites, totals: { ...totals, householdsServed: distinctHouseholds }, donations };
    });
  }

  async monthlyCsv(month: string): Promise<string> {
    const report = await this.monthly(month);
    const header = ['Site', 'Events held', 'Households served', 'Parcels issued', 'Overrides', 'Volunteer hours'];
    const rows = report.sites.map((s) => [s.siteName, s.eventsHeld, s.householdsServed, s.parcelsIssued, s.overrides, s.volunteerHours]);
    const t = report.totals;
    rows.push(['All sites', t.eventsHeld, t.householdsServed, t.parcelsIssued, t.overrides, t.volunteerHours]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /** US-16: what a donor's gifts made possible. Donors only ever see their own impact. */
  async donorImpact(actor: Actor) {
    if (actor.role !== 'Donor' || !actor.donorId) throw forbidden('The donor portal is for donor accounts.');
    const [impact, donations] = await Promise.all([
      this.deps.uow.read((r) => r.reports.donorImpact(actor.donorId!)),
      this.deps.uow.read((r) => r.donations.list({ donorId: actor.donorId!, limit: 100 })),
    ]);
    return { ...impact, donations };
  }

  /** One summary call per dashboard, shaped to the role that asks. */
  async dashboard(actor: Actor) {
    const today = saDate(this.deps.clock());
    const now = this.deps.clock();
    return this.deps.uow.read(async (r) => {
      const siteScope = actor.role === 'SiteCoordinator' ? actor.siteId : null;
      const [statusCounts, upcoming, unfilledShifts, items, expiring] = await Promise.all([
        r.households.statusCounts(siteScope),
        r.reports.upcomingEvents(today, siteScope, 6),
        r.reports.unfilledShiftCount(now, new Date(now.getTime() + 14 * 86_400_000)),
        r.stock.listItems(today),
        r.stock.expiringBatches(today, new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)),
      ]);
      return {
        today,
        households: statusCounts,
        upcomingEvents: upcoming,
        unfilledShifts,
        lowStockCount: items.filter((i) => i.onHand < i.reorderLevel).length,
        expiringBatchCount: expiring.length,
      };
    });
  }
}
