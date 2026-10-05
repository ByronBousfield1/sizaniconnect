import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Dialog, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill, Select, Table, TextArea, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDays, EVENT_STATUS, fmtDate, fmtDateTime, fmtTime, todaySA } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { DistributionEvent, Site } from '../lib/types';

/** S10: schedule and browse distribution events */
export function EventsPage() {
  const { user, can } = useAuth();
  const [range, setRange] = useState<'upcoming' | 'past'>('upcoming');
  const today = todaySA();
  const query = range === 'upcoming' ? { from: today, to: addDays(today, 60) } : { from: addDays(today, -90), to: addDays(today, -1) };
  const { data, error, loading, reload } = useLoad(
    () => api<DistributionEvent[]>('/events', { query: { ...query, siteId: user?.role === 'SiteCoordinator' ? user.siteId : undefined } }),
    [range],
  );
  const [scheduling, setScheduling] = useState(false);

  const rows = range === 'past' ? [...(data ?? [])].reverse() : data ?? [];

  return (
    <>
      <PageHeader
        title="Distribution events"
        lede={user?.role === 'SiteCoordinator' ? `Events at ${user.siteName}.` : 'Every scheduled distribution, by date.'}
        actions={can('OperationsManager') ? <Button onClick={() => setScheduling(true)}>Schedule an event</Button> : null}
      />
      {scheduling ? <ScheduleForm onDone={() => {
            setScheduling(false);
            reload();
          }} onCancel={() => setScheduling(false)} /> : null}

      <div className="segmented" role="group" aria-label="Which events">
        <button type="button" aria-pressed={range === 'upcoming'} onClick={() => setRange('upcoming')}>
          Today and upcoming
        </button>
        <button type="button" aria-pressed={range === 'past'} onClick={() => setRange('past')}>
          Past 90 days
        </button>
      </div>

      <ErrorNotice error={error} />
      {loading && !data ? <Loading /> : null}
      {data && rows.length === 0 ? (
        <Empty title={range === 'upcoming' ? 'Nothing scheduled' : 'No past events'}>
          {can('OperationsManager') && range === 'upcoming' ? <p>Schedule the next distribution to start planning volunteers and stock.</p> : null}
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <Table caption="Distribution events">
          <thead>
            <tr>
              <th>Date</th>
              <th>Site</th>
              <th>Time</th>
              <th className="num">Planned</th>
              <th className="num">Issued</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">
                  <Link to={`/events/${e.id}`}>{e.scheduledDate === today ? 'Today' : fmtDate(e.scheduledDate)}</Link>
                </td>
                <td>{e.siteName}</td>
                <td className="nowrap">
                  {e.startTime} to {e.endTime}
                </td>
                <td className="num">{e.plannedParcels}</td>
                <td className="num">{e.collectionCount}</td>
                <td>
                  <Pill tone={EVENT_STATUS[e.status].tone}>{EVENT_STATUS[e.status].label}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}

function ScheduleForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const sites = useLoad(() => api<Site[]>('/sites'));
  const [form, setForm] = useState({ siteId: '', scheduledDate: addDays(todaySA(), 7), startTime: '09:00', endTime: '13:00', plannedParcels: '40', minVolunteers: '2' });
  const { busy, error, run } = useAction();
  const fe = error?.fieldErrors ?? {};
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const site = sites.data?.find((s) => s.id === form.siteId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() =>
      api('/events', { body: { ...form, plannedParcels: Number(form.plannedParcels), minVolunteers: Number(form.minVolunteers) } }),
    );
    if (ok) onDone();
  };

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <h2>Schedule an event</h2>
      <ErrorNotice error={error} />
      <div className="form-row">
        <Select label="Site" value={form.siteId} onChange={set('siteId')} error={fe.siteId}>
          <option value="">Choose a site</option>
          {sites.data?.filter((s) => s.isActive).map((s) => (
            <option key={s.id} value={s.id}>
              {s.siteName}
            </option>
          ))}
        </Select>
        <TextInput label="Date" type="date" min={todaySA()} value={form.scheduledDate} onChange={set('scheduledDate')} error={fe.scheduledDate} />
        <TextInput label="Starts" type="time" value={form.startTime} onChange={set('startTime')} error={fe.startTime} />
        <TextInput label="Ends" type="time" value={form.endTime} onChange={set('endTime')} error={fe.endTime} />
      </div>
      <div className="form-row">
        <TextInput
          label="Planned parcels"
          type="number"
          min={1}
          hint={site ? `${site.siteName} handles up to ${site.capacityPerEvent}.` : undefined}
          value={form.plannedParcels}
          onChange={set('plannedParcels')}
          error={fe.plannedParcels}
        />
        <TextInput label="Volunteers needed to open" type="number" min={0} value={form.minVolunteers} onChange={set('minVolunteers')} error={fe.minVolunteers} />
      </div>
      <div className="form-actions">
        <Button type="submit" busy={busy}>
          Schedule event
        </Button>
        <Button kind="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface EventDetail extends DistributionEvent {
  householdsServed: number;
  roster: { shiftId: string; startsAt: string; endsAt: string; volunteerName: string; status: string; hoursServed: number | null }[];
}

interface CollectionRow {
  id: string;
  collectedAt: string;
  parcelSize: string;
  isOverride: boolean;
  overrideReason: string | null;
  referenceCode: string;
  headOfHousehold: string;
  verifiedByName: string;
}

/** Event detail: the lifecycle buttons follow the state diagram, so only legal next steps appear. */
export function EventDetailPage() {
  const { id = '' } = useParams();
  const { user, can } = useAuth();
  const { data: ev, error, loading, reload } = useLoad(() => api<EventDetail>(`/events/${id}`), [id]);
  const collections = useLoad(() => api<CollectionRow[]>(`/events/${id}/collections`), [id]);
  const action = useAction();
  const [dialog, setDialog] = useState<'reconcile' | 'cancel' | 'shift' | null>(null);
  const [count, setCount] = useState('');
  const [reason, setReason] = useState('');
  const [shift, setShift] = useState({ start: '08:30', end: '13:00', needed: '3', notes: '' });

  if (loading && !ev) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  if (!ev) return null;

  const mySite = user?.role !== 'SiteCoordinator' || user.siteId === ev.siteId;
  const runner = can('SiteCoordinator', 'OperationsManager') && mySite;
  const isOps = can('OperationsManager');

  const step = async (path: string, body: unknown = {}) => {
    const ok = await action.run(() => api(`/events/${ev.id}/${path}`, { body }));
    if (ok) {
      setDialog(null);
      setReason('');
      reload();
      collections.reload();
    }
  };

  const addShift = async (e: FormEvent) => {
    e.preventDefault();
    const at = (t: string) => new Date(`${ev.scheduledDate}T${t}:00+02:00`).toISOString();
    const ok = await action.run(() =>
      api('/shifts', { body: { eventId: ev.id, startsAt: at(shift.start), endsAt: at(shift.end), volunteersNeeded: Number(shift.needed), notes: shift.notes } }),
    );
    if (ok) {
      setDialog(null);
      reload();
    }
  };

  const variance = count === '' ? null : Number(count) - ev.collectionCount;

  return (
    <>
      <PageHeader
        title={ev.siteName}
        lede={`${ev.scheduledDate === todaySA() ? 'Today' : fmtDate(ev.scheduledDate)}, ${ev.startTime} to ${ev.endTime}`}
        actions={
          <>
            {ev.status === 'Planned' && isOps ? <Button busy={action.busy} onClick={() => void step('stock')}>Mark as stocked</Button> : null}
            {ev.status === 'Stocked' && runner ? <Button kind="action" busy={action.busy} onClick={() => void step('open')}>Open event</Button> : null}
            {ev.status === 'Open' ? (
              <Link className="btn btn-action" to={`/desk?event=${ev.id}`}>
                Go to the event desk
              </Link>
            ) : null}
            {ev.status === 'Open' && runner ? <Button kind="quiet" busy={action.busy} onClick={() => void step('close')}>Close event</Button> : null}
            {ev.status === 'Closed' && runner ? <Button onClick={() => setDialog('reconcile')}>Reconcile</Button> : null}
            {['Planned', 'Stocked', 'Open'].includes(ev.status) && runner ? <Button kind="quiet" onClick={() => setDialog('shift')}>Add a shift</Button> : null}
            {['Planned', 'Stocked'].includes(ev.status) && isOps ? <Button kind="danger" onClick={() => setDialog('cancel')}>Cancel event</Button> : null}
          </>
        }
      />
      {dialog === null ? <ErrorNotice error={action.error} /> : null}
      {action.error?.code === 'INSUFFICIENT_STOCK' && dialog === null ? (
        <Table caption="Stock shortfalls">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Needed</th>
              <th className="num">Available</th>
            </tr>
          </thead>
          <tbody>
            {((action.error.details as { shortfalls?: { itemName: string; required: number; available: number }[] })?.shortfalls ?? []).map((s) => (
              <tr key={s.itemName}>
                <td>{s.itemName}</td>
                <td className="num">{s.required}</td>
                <td className="num">{s.available}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      <div className="stats">
        <div className="stat">
          <span className="stat-value">
            <Pill tone={EVENT_STATUS[ev.status].tone}>{EVENT_STATUS[ev.status].label}</Pill>
          </span>
          <span className="stat-label">Status</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {ev.collectionCount} / {ev.plannedParcels}
          </span>
          <span className="stat-label">Parcels issued of planned</span>
        </div>
        <div className="stat">
          <span className="stat-value">{ev.householdsServed}</span>
          <span className="stat-label">Households served</span>
        </div>
        <div className={`stat ${ev.checkedInVolunteers < ev.minVolunteers && ev.status === 'Stocked' ? 'stat-warn' : ''}`}>
          <span className="stat-value">
            {ev.checkedInVolunteers} / {ev.minVolunteers}
          </span>
          <span className="stat-label">Volunteers checked in of needed</span>
        </div>
      </div>

      {ev.status === 'Reconciled' ? (
        <Notice tone={ev.variance ? 'warn' : 'good'}>
          <p>
            Counted {ev.physicalCount} parcels against {ev.collectionCount} recorded
            {ev.variance ? `, a difference of ${ev.variance > 0 ? '+' : ''}${ev.variance}. Reason: ${ev.varianceReason}` : '. No difference.'}
          </p>
        </Notice>
      ) : null}
      {ev.status === 'Cancelled' ? (
        <Notice tone="bad">
          <p>Cancelled: {ev.cancelReason}</p>
        </Notice>
      ) : null}

      <div className="grid-2">
        <section className="panel">
          <h2>Volunteers</h2>
          {ev.roster.length === 0 ? (
            <p className="muted">No one has signed up yet.</p>
          ) : (
            <ul className="list-plain">
              {ev.roster.map((r) => (
                <li key={`${r.shiftId}-${r.volunteerName}`} className="row-between">
                  <span>
                    {r.volunteerName}
                    <span className="small muted">
                      {' '}
                      {fmtTime(r.startsAt)} to {fmtTime(r.endsAt)}
                    </span>
                  </span>
                  <Pill tone={r.status === 'CheckedIn' ? 'good' : 'neutral'}>
                    {r.status === 'CheckedIn' ? (r.hoursServed !== null ? `${r.hoursServed} h served` : 'Checked in') : 'Signed up'}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Collections</h2>
          {collections.data?.length ? (
            <ul className="list-plain">
              {collections.data.slice(0, 12).map((c) => (
                <li key={c.id} className="row-between">
                  <span>
                    <strong>{c.headOfHousehold}</strong>{' '}
                    <span className="small muted">
                      {c.parcelSize}, {fmtDateTime(c.collectedAt)}
                    </span>
                  </span>
                  {c.isOverride ? <Pill tone="warn">Override</Pill> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No parcels issued yet.</p>
          )}
        </section>
      </div>

      <Dialog open={dialog === 'reconcile'} title="Reconcile the event" onClose={() => setDialog(null)}>
        <p>
          The system recorded <strong>{ev.collectionCount}</strong> parcels. Count what actually left the site.
        </p>
        <TextInput label="Parcels counted" type="number" min={0} value={count} onChange={(e) => setCount(e.target.value)} />
        {variance !== null && variance !== 0 ? (
          <TextArea
            label={`Explain the difference of ${variance > 0 ? '+' : ''}${variance}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        ) : null}
        <ErrorNotice error={action.error} />
        <div className="form-actions">
          <Button busy={action.busy} disabled={count === ''} onClick={() => void step('reconcile', { physicalCount: Number(count), varianceReason: reason || null })}>
            Save reconciliation
          </Button>
          <Button kind="quiet" onClick={() => setDialog(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'cancel'} title="Cancel this event" onClose={() => setDialog(null)}>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorNotice error={action.error} />
        <div className="form-actions">
          <Button kind="danger" busy={action.busy} onClick={() => void step('cancel', { reason })}>
            Cancel event
          </Button>
          <Button kind="quiet" onClick={() => setDialog(null)}>
            Keep it
          </Button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'shift'} title="Add a volunteer shift" onClose={() => setDialog(null)}>
        <form onSubmit={addShift} noValidate>
          <div className="form-row">
            <TextInput label="Starts" type="time" value={shift.start} onChange={(e) => setShift({ ...shift, start: e.target.value })} />
            <TextInput label="Ends" type="time" value={shift.end} onChange={(e) => setShift({ ...shift, end: e.target.value })} />
            <TextInput label="People needed" type="number" min={1} value={shift.needed} onChange={(e) => setShift({ ...shift, needed: e.target.value })} />
          </div>
          <TextInput label="What they will do" hint="Optional" value={shift.notes} onChange={(e) => setShift({ ...shift, notes: e.target.value })} />
          <ErrorNotice error={action.error} />
          <div className="form-actions">
            <Button type="submit" busy={action.busy}>
              Publish shift
            </Button>
            <Button kind="quiet" onClick={() => setDialog(null)}>
              Cancel
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
