import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill, TextArea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtQty, fmtTime, HOUSEHOLD_STATUS, todaySA } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { DistributionEvent, HouseholdStatus, ParcelSize } from '../lib/types';

interface Lookup {
  id: string;
  referenceCode: string;
  headOfHousehold: string;
  suburb: string;
  homeSiteName: string;
  status: HouseholdStatus;
  memberCount: number;
  parcelSize: ParcelSize | null;
  lastCollectedAt: string | null;
  alreadyCollected: { collectedAt: string; verifiedByName: string } | null;
}

interface Recorded {
  id: string;
  parcelSize: ParcelSize;
  isOverride: boolean;
  headOfHousehold: string;
  referenceCode: string;
  issued: { itemName: string; unitOfMeasure: string; quantity: number }[];
}

interface RecentRow {
  id: string;
  collectedAt: string;
  parcelSize: string;
  headOfHousehold: string;
  referenceCode: string;
  isOverride: boolean;
}

/** S6 and S7: the screen used most, on a phone, with a queue waiting. One input, one decision. */
export function DeskPage() {
  const { user, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = todaySA();
  const events = useLoad(() =>
    api<DistributionEvent[]>('/events', {
      query: { from: today, to: today, status: 'Open', siteId: user?.role === 'SiteCoordinator' ? user.siteId : undefined },
    }),
  );
  const eventId = params.get('event') ?? (events.data?.length === 1 ? events.data[0].id : null);
  const event = events.data?.find((e) => e.id === eventId) ?? null;

  if (events.loading && !events.data) return <Loading />;
  if (events.error) return <ErrorNotice error={events.error} />;

  if (!events.data?.length) {
    return (
      <>
        <PageHeader title="Event desk" />
        <Empty title="No event is open right now">
          <p>The desk works once a coordinator opens today&rsquo;s distribution event.</p>
          {can('SiteCoordinator', 'OperationsManager') ? (
            <p>
              <Link to="/events">Go to distribution events</Link>
            </p>
          ) : null}
        </Empty>
      </>
    );
  }

  if (!event) {
    return (
      <>
        <PageHeader title="Event desk" lede="More than one event is open today. Choose the one you are working at." />
        <ul className="list-plain panel">
          {events.data.map((e) => (
            <li key={e.id} className="row-between">
              <span>
                <strong>{e.siteName}</strong>{' '}
                <span className="muted small">
                  {e.startTime} to {e.endTime}
                </span>
              </span>
              <Button onClick={() => setParams({ event: e.id })}>Work at this event</Button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return <Desk event={event} canOverride={can('SiteCoordinator', 'OperationsManager')} />;
}

function Desk({ event, canOverride }: { event: DistributionEvent; canOverride: boolean }) {
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<ApiError | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [finding, setFinding] = useState(false);
  const record = useAction();
  const recent = useLoad(() => api<RecentRow[]>(`/events/${event.id}/collections`), [event.id]);

  useEffect(() => inputRef.current?.focus(), []);

  const reset = () => {
    setFound(null);
    setLookupError(null);
    setOverrideReason('');
    record.setError(null);
  };

  const find = async (e: FormEvent) => {
    e.preventDefault();
    reset();
    setRecorded(null);
    const value = code.trim();
    if (value.length < 6) return;
    setFinding(true);
    try {
      const result = await api<Lookup>(`/households/by-ref/${encodeURIComponent(value)}`, { query: { eventId: event.id } });
      setFound(result);
    } catch (err) {
      setLookupError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.'));
    } finally {
      setFinding(false);
    }
  };

  const submit = async (override: boolean) => {
    if (!found) return;
    const result = await record.run(() =>
      api<Recorded>('/collections', {
        body: { eventId: event.id, householdId: found.id, override: override || undefined, overrideReason: override ? overrideReason : undefined },
      }),
    );
    if (result) {
      setRecorded(result);
      setFound(null);
      setCode('');
      setOverrideReason('');
      recent.reload();
      inputRef.current?.focus();
    }
  };

  const eligible = found?.status === 'Active';
  const duplicate = found?.alreadyCollected ?? null;
  const stop = !!found && (!eligible || !!duplicate);

  return (
    <>
      <PageHeader
        title="Event desk"
        lede={`${event.siteName}, ${event.startTime} to ${event.endTime}`}
        actions={<Link className="btn btn-quiet" to={`/events/${event.id}`}>Event details</Link>}
      />
      <div className="desk">
        <div>
          <form className="desk-scan" onSubmit={find} noValidate>
            <label htmlFor="ref">Household reference code</label>
            <p className="field-hint" id="ref-hint">
              Type the code from the household&rsquo;s slip, or scan it. Letters O, I and L are read as 0 and 1.
            </p>
            <div className="code-entry">
              <input
                id="ref"
                ref={inputRef}
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SZN-2026-"
                size={1}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby="ref-hint"
              />
              <Button type="submit" kind="action" busy={finding}>
                Find
              </Button>
            </div>

            {lookupError ? (
              <div className="verdict verdict-stop" role="alert">
                <div className="verdict-band">
                  {lookupError.status === 404 ? 'No household has this code. Check the slip and try again.' : lookupError.message}
                </div>
              </div>
            ) : null}

            {recorded ? (
              <div className="verdict" role="status">
                <div className="verdict-head">
                  <span className="parcel-mark" aria-hidden="true">
                    {recorded.parcelSize[0]}
                  </span>
                  <div>
                    <p className="verdict-name">{recorded.headOfHousehold}</p>
                    <p className="muted" style={{ margin: 0 }}>
                      {recorded.referenceCode}
                    </p>
                  </div>
                </div>
                <div className="verdict-band">
                  Recorded{recorded.isOverride ? ' as an override' : ''}. Hand over a {recorded.parcelSize.toLowerCase()} parcel.
                </div>
                <div className="verdict-body">
                  <p className="small muted" style={{ margin: 0 }}>
                    Taken from stock:
                  </p>
                  <ul className="issued-list small">
                    {recorded.issued.map((i) => (
                      <li key={i.itemName}>
                        {fmtQty(i.quantity)} {i.unitOfMeasure} {i.itemName}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {found ? (
              <div className={`verdict${stop ? ' verdict-stop' : ''}`} role={stop ? 'alert' : 'status'}>
                <div className="verdict-head">
                  <span className="parcel-mark" aria-hidden="true">
                    {stop ? '!' : found.parcelSize?.[0]}
                  </span>
                  <div>
                    <p className="verdict-name">{found.headOfHousehold}</p>
                    <p className="muted" style={{ margin: 0 }}>
                      {found.memberCount} {found.memberCount === 1 ? 'person' : 'people'}, {found.suburb}
                    </p>
                  </div>
                </div>
                <div className="verdict-band">
                  {!eligible
                    ? `Cannot collect: household is ${HOUSEHOLD_STATUS[found.status].label.toLowerCase()}. Refer them to the coordinator.`
                    : duplicate
                      ? `Already collected at ${fmtTime(duplicate.collectedAt)}, recorded by ${duplicate.verifiedByName}.`
                      : `Eligible for a ${found.parcelSize?.toLowerCase()} parcel.`}
                </div>
                <div className="verdict-body">
                  {eligible && !duplicate ? (
                    <Button kind="action" className="btn-record" busy={record.busy} onClick={() => void submit(false)}>
                      Record collection
                    </Button>
                  ) : null}
                  {eligible && duplicate && canOverride ? (
                    <>
                      <TextArea
                        label="Override reason"
                        hint="Only for a genuine exception. The reason is kept in the audit log."
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        error={record.error?.code === 'OVERRIDE_REASON_REQUIRED' ? record.error.message : undefined}
                      />
                      <Button kind="danger" busy={record.busy} onClick={() => void submit(true)}>
                        Approve a second parcel
                      </Button>
                    </>
                  ) : null}
                  {eligible && duplicate && !canOverride ? <p style={{ margin: 0 }}>Ask the site coordinator if there is a genuine reason for a second parcel.</p> : null}
                  {!eligible ? <p style={{ margin: 0 }}>Do not issue a parcel.</p> : null}
                  {record.error && record.error.code !== 'OVERRIDE_REASON_REQUIRED' ? <ErrorNotice error={record.error} /> : null}
                  <p style={{ margin: 'var(--s-3) 0 0' }}>
                    <button type="button" className="link-button" onClick={() => {
                        reset();
                        setCode('');
                        inputRef.current?.focus();
                      }}>
                      Next household
                    </button>
                  </p>
                </div>
              </div>
            ) : null}
          </form>
        </div>

        <section className="panel" aria-labelledby="recent-h">
          <div className="panel-head">
            <h2 id="recent-h">Issued at this event</h2>
            <span className="muted">
              {recent.data?.length ?? 0} of {event.plannedParcels}
            </span>
          </div>
          {recent.data && recent.data.length === 0 ? <p className="muted">Nothing issued yet.</p> : null}
          <ul className="list-plain">
            {recent.data?.slice(0, 15).map((r) => (
              <li key={r.id} className="row-between">
                <span>
                  {r.headOfHousehold}
                  <span className="small muted"> {r.parcelSize}</span>
                </span>
                <span className="small muted nowrap">
                  {r.isOverride ? <Pill tone="warn">Override</Pill> : null} {fmtDateTime(r.collectedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {event.collectionCount >= event.plannedParcels ? (
        <Notice tone="warn">
          <p>The planned number of parcels has been reached. Check physical stock before issuing more.</p>
        </Notice>
      ) : null}
    </>
  );
}
