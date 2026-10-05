import { Link } from 'react-router-dom';
import { Empty, ErrorNotice, Loading, PageHeader, Pill, Stat, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EVENT_STATUS, fmtDate } from '../lib/format';
import { useLoad } from '../lib/hooks';
import type { EventStatus } from '../lib/types';

interface Dashboard {
  today: string;
  households: Record<string, number>;
  upcomingEvents: {
    id: string;
    siteName: string;
    scheduledDate: string;
    startTime: string;
    endTime: string;
    status: EventStatus;
    plannedParcels: number;
    collectionCount: number;
  }[];
  unfilledShifts: number;
  lowStockCount: number;
  expiringBatchCount: number;
}

/** S3 (coordinator) and S9 (operations): one summary, scoped by role on the server. */
export function OverviewPage() {
  const { user } = useAuth();
  const { data, error, loading } = useLoad(() => api<Dashboard>('/dashboard'));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;

  const pending = data.households.PendingVerification ?? 0;
  const todays = data.upcomingEvents.filter((e) => e.scheduledDate === data.today);
  const first = user?.fullName.split(' ')[0];

  return (
    <>
      <PageHeader
        title={`Good day, ${first}`}
        lede={
          user?.role === 'SiteCoordinator'
            ? `Figures for ${user.siteName}.`
            : 'Figures across all distribution sites.'
        }
        actions={
          user?.role !== 'Admin' ? (
            <>
              {todays.some((e) => e.status === 'Open') ? (
                <Link className="btn btn-action" to="/desk">
                  Open the event desk
                </Link>
              ) : null}
              <Link className="btn btn-quiet" to="/households/new">
                Register a household
              </Link>
            </>
          ) : null
        }
      />

      <div className="stats">
        <Stat value={data.households.Active ?? 0} label="Active households" tone="good" />
        <Stat value={pending} label="Waiting for verification" tone={pending > 0 ? 'warn' : undefined} />
        <Stat value={data.unfilledShifts} label="Shifts still needing people" tone={data.unfilledShifts > 0 ? 'warn' : undefined} />
        <Stat
          value={data.lowStockCount + data.expiringBatchCount}
          label="Stock alerts"
          tone={data.lowStockCount + data.expiringBatchCount > 0 ? 'bad' : undefined}
        />
      </div>

      <div className="grid-2">
        <section className="panel" aria-labelledby="upcoming-h">
          <div className="panel-head">
            <h2 id="upcoming-h">Coming up</h2>
            <Link to="/events">All events</Link>
          </div>
          {data.upcomingEvents.length === 0 ? (
            <Empty title="Nothing scheduled">
              <p>Distribution events for the next weeks appear here once they are scheduled.</p>
            </Empty>
          ) : (
            <ul className="list-plain">
              {data.upcomingEvents.map((e) => (
                <li key={e.id} className="row-between">
                  <div>
                    <Link to={`/events/${e.id}`}>
                      <strong>{e.siteName}</strong>
                    </Link>
                    <div className="small muted">
                      {e.scheduledDate === data.today ? 'Today' : fmtDate(e.scheduledDate)}, {e.startTime} to {e.endTime}
                      {e.status === 'Open' ? `, ${e.collectionCount} of ${e.plannedParcels} parcels issued` : ''}
                    </div>
                  </div>
                  <Pill tone={EVENT_STATUS[e.status].tone}>{EVENT_STATUS[e.status].label}</Pill>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="todo-h">
          <h2 id="todo-h">Needs attention</h2>
          <Table caption="Items needing attention">
            <tbody>
              <tr>
                <td>Households waiting for verification</td>
                <td className="num">{pending}</td>
                <td>
                  <Link to="/households?status=PendingVerification">Review</Link>
                </td>
              </tr>
              <tr>
                <td>Households returned for correction</td>
                <td className="num">{data.households.Draft ?? 0}</td>
                <td>
                  <Link to="/households?status=Draft">Review</Link>
                </td>
              </tr>
              <tr>
                <td>Items below reorder level</td>
                <td className="num">{data.lowStockCount}</td>
                <td>
                  <Link to="/stock">Check stock</Link>
                </td>
              </tr>
              <tr>
                <td>Batches expiring within 14 days</td>
                <td className="num">{data.expiringBatchCount}</td>
                <td>
                  <Link to="/stock">Check stock</Link>
                </td>
              </tr>
            </tbody>
          </Table>
        </section>
      </div>
    </>
  );
}
