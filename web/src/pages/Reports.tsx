import { useState } from 'react';
import { Button, ErrorNotice, Loading, PageHeader, Stat, Table, TextInput } from '../components/ui';
import { api, download } from '../lib/api';
import { fmtRand } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';

interface Monthly {
  month: string;
  sites: { siteId: string; siteName: string; eventsHeld: number; householdsServed: number; parcelsIssued: number; overrides: number; volunteerHours: number }[];
  totals: { eventsHeld: number; householdsServed: number; parcelsIssued: number; overrides: number; volunteerHours: number };
  donations: { cashTotal: number; inKindCount: number; donationCount: number };
}

function lastMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });

/** S13: the monthly board and funder report (US-15) */
export function ReportsPage() {
  const [month, setMonth] = useState(lastMonth());
  const { data, error, loading } = useLoad(() => api<Monthly>('/reports/monthly', { query: { month } }), [month]);
  const exportCsv = useAction();

  return (
    <>
      <PageHeader
        title={`Monthly report, ${monthName(month)}`}
        lede="Households are counted once even if they visited more than one site."
        actions={
          <>
            <Button kind="quiet" busy={exportCsv.busy} onClick={() => void exportCsv.run(() => download('/reports/monthly.csv', `sizani-${month}.csv`, { month }))}>
              Download CSV
            </Button>
            <Button kind="quiet" onClick={() => window.print()}>
              Print or save as PDF
            </Button>
          </>
        }
      />
      <div className="no-print" style={{ maxWidth: '16rem' }}>
        <TextInput label="Month" type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </div>
      <ErrorNotice error={error ?? exportCsv.error} />
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <div className="stats">
            <Stat value={data.totals.householdsServed} label="Households served" tone="good" />
            <Stat value={data.totals.parcelsIssued} label="Parcels issued" />
            <Stat value={data.totals.volunteerHours} label="Volunteer hours" />
            <Stat value={fmtRand(data.donations.cashTotal)} label={`Cash received, plus ${data.donations.inKindCount} in-kind deliveries`} />
          </div>
          <Table caption={`Report by site for ${monthName(month)}`}>
            <thead>
              <tr>
                <th>Site</th>
                <th className="num">Events</th>
                <th className="num">Households</th>
                <th className="num">Parcels</th>
                <th className="num">Overrides</th>
                <th className="num">Volunteer hours</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((s) => (
                <tr key={s.siteId}>
                  <td>{s.siteName}</td>
                  <td className="num">{s.eventsHeld}</td>
                  <td className="num">{s.householdsServed}</td>
                  <td className="num">{s.parcelsIssued}</td>
                  <td className="num">{s.overrides}</td>
                  <td className="num">{s.volunteerHours}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>All sites</strong>
                </td>
                <td className="num">
                  <strong>{data.totals.eventsHeld}</strong>
                </td>
                <td className="num">
                  <strong>{data.totals.householdsServed}</strong>
                </td>
                <td className="num">
                  <strong>{data.totals.parcelsIssued}</strong>
                </td>
                <td className="num">
                  <strong>{data.totals.overrides}</strong>
                </td>
                <td className="num">
                  <strong>{data.totals.volunteerHours}</strong>
                </td>
              </tr>
            </tbody>
          </Table>
        </>
      ) : null}
    </>
  );
}
