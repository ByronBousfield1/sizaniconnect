import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Dialog, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill, Select, Table, TextArea, TextInput } from '../components/ui';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, HOUSEHOLD_STATUS } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { Household, HouseholdDetail, HouseholdStatus, Member, Paged, Site } from '../lib/types';

const AGE_BANDS = ['0-5', '6-12', '13-17', '18-59', '60+'];
const RELATIONSHIPS = ['Self', 'Spouse', 'Child', 'Elderly', 'Other'];
const RELATIONSHIP_LABEL: Record<string, string> = {
  Self: 'Head of household',
  Spouse: 'Spouse or partner',
  Child: 'Child',
  Elderly: 'Elderly dependant',
  Other: 'Other',
};

/** S5: search and list */
export function HouseholdsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = (params.get('status') ?? '') as HouseholdStatus | '';
  const page = Number(params.get('page') ?? 1);
  const { can } = useAuth();

  const { data, error, loading } = useLoad(
    () => api<Paged<Household>>('/households', { query: { q: params.get('q'), status, page, pageSize: 25 } }),
    [params.toString()],
  );

  const update = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (!('page' in next)) merged.delete('page');
    setParams(merged);
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Households"
        lede="Search by name, reference code or suburb."
        actions={
          can('SiteCoordinator', 'OperationsManager') ? (
            <Link className="btn btn-primary" to="/households/new">
              Register a household
            </Link>
          ) : null
        }
      />
      <form
        className="panel form-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: q.trim() });
        }}
      >
        <TextInput label="Search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Mokoena or SZN-2026-7K4Q" />
        <Select label="Status" value={status} onChange={(e) => update({ status: e.target.value })}>
          <option value="">Any status</option>
          {(Object.keys(HOUSEHOLD_STATUS) as HouseholdStatus[]).map((s) => (
            <option key={s} value={s}>
              {HOUSEHOLD_STATUS[s].label}
            </option>
          ))}
        </Select>
        <div className="field" style={{ alignSelf: 'end' }}>
          <Button type="submit">Search</Button>
        </div>
      </form>

      <ErrorNotice error={error} />
      {loading && !data ? <Loading /> : null}
      {data && data.items.length === 0 ? (
        <Empty title="No households match">
          <p>Check the spelling, or clear the status filter.</p>
        </Empty>
      ) : null}
      {data && data.items.length > 0 ? (
        <>
          <p className="muted small" aria-live="polite">
            {data.total} household{data.total === 1 ? '' : 's'}
          </p>
          <Table caption="Households">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Head of household</th>
                <th>Site</th>
                <th className="num">People</th>
                <th>Status</th>
                <th>Last collected</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((h) => (
                <tr key={h.id}>
                  <td>
                    <Link className="ref-code" to={`/households/${h.id}`}>
                      {h.referenceCode}
                    </Link>
                  </td>
                  <td>{h.headOfHousehold}</td>
                  <td>
                    {h.homeSiteName}
                    <div className="small muted">{h.suburb}</div>
                  </td>
                  <td className="num">{h.memberCount}</td>
                  <td>
                    <Pill tone={HOUSEHOLD_STATUS[h.status].tone}>{HOUSEHOLD_STATUS[h.status].label}</Pill>
                  </td>
                  <td className="nowrap">{fmtDate(h.lastCollectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {pages > 1 ? (
            <nav className="form-actions" aria-label="Pages">
              <Button kind="quiet" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
                Previous page
              </Button>
              <span className="muted">
                Page {page} of {pages}
              </span>
              <Button kind="quiet" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>
                Next page
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function MembersEditor({ members, onChange, errors }: { members: Member[]; onChange: (m: Member[]) => void; errors: Record<string, string> }) {
  const set = (i: number, patch: Partial<Member>) => onChange(members.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <fieldset className="panel">
      <legend className="sr-only">Household members</legend>
      <div className="panel-head">
        <h2>Who lives in the household</h2>
        <span className="muted">
          {members.length} {members.length === 1 ? 'person' : 'people'}
        </span>
      </div>
      <p className="muted small">
        Include the head of household. Parcel size follows the number of people: 1 to 2 small, 3 to 5 medium, 6 or more large.
      </p>
      {members.map((m, i) => (
        <div className="form-row" key={i}>
          <TextInput label={`Person ${i + 1}: first name`} value={m.firstName} onChange={(e) => set(i, { firstName: e.target.value })} error={errors[`members.${i}.firstName`]} />
          <Select label="Age" value={m.ageBand} onChange={(e) => set(i, { ageBand: e.target.value })}>
            {AGE_BANDS.map((b) => (
              <option key={b} value={b}>
                {b === '60+' ? '60 or older' : `${b.replace('-', ' to ')} years`}
              </option>
            ))}
          </Select>
          <Select label="Relationship" value={m.dependantType} onChange={(e) => set(i, { dependantType: e.target.value })} disabled={i === 0}>
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {RELATIONSHIP_LABEL[r]}
              </option>
            ))}
          </Select>
          {i > 0 ? (
            <div className="field" style={{ alignSelf: 'end' }}>
              <Button kind="quiet" onClick={() => onChange(members.filter((_, j) => j !== i))} aria-label={`Remove person ${i + 1}`}>
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      <Button kind="quiet" onClick={() => onChange([...members, { firstName: '', ageBand: '6-12', dependantType: 'Child' }])}>
        Add a person
      </Button>
    </fieldset>
  );
}

/** S4: register a household (SD-01) */
export function HouseholdNewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const sites = useLoad(() => api<Site[]>('/sites'));
  const [form, setForm] = useState({
    headOfHousehold: '',
    idNumber: '',
    contactNumber: '',
    addressLine: '',
    suburb: '',
    homeSiteId: user?.siteId ?? '',
  });
  const [members, setMembers] = useState<Member[]>([{ firstName: '', ageBand: '18-59', dependantType: 'Self' }]);
  const { busy, error, run } = useAction();
  const fe = error?.fieldErrors ?? {};
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const firstName = members[0].firstName || form.headOfHousehold.split(' ')[0];
    const result = await run(() =>
      api<{ id: string; referenceCode: string }>('/households', {
        body: { ...form, members: [{ ...members[0], firstName }, ...members.slice(1)] },
      }),
    );
    if (result) navigate(`/households/${result.id}`, { state: { created: result.referenceCode } });
  };

  return (
    <>
      <PageHeader title="Register a household" lede="The household starts as waiting for verification. An operations manager verifies it before it can collect." />
      <form onSubmit={submit} noValidate>
        <section className="panel">
          <h2>Head of household</h2>
          <div className="form-row">
            <TextInput label="Full name" autoComplete="off" value={form.headOfHousehold} onChange={set('headOfHousehold')} error={fe.headOfHousehold} />
            <TextInput
              label="ID or passport number"
              hint="Checked against every site for duplicates, then discarded. Only a one-way code is kept."
              autoComplete="off"
              inputMode="text"
              value={form.idNumber}
              onChange={set('idNumber')}
              error={fe.idNumber}
            />
          </div>
          <div className="form-row">
            <TextInput label="Phone number" hint="Optional" type="tel" value={form.contactNumber} onChange={set('contactNumber')} error={fe.contactNumber} />
            <Select label="Collects at" value={form.homeSiteId} onChange={set('homeSiteId')} error={fe.homeSiteId} disabled={user?.role === 'SiteCoordinator'}>
              <option value="">Choose a site</option>
              {sites.data?.filter((s) => s.isActive).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.siteName}
                </option>
              ))}
            </Select>
          </div>
          <div className="form-row">
            <TextInput label="Street address" value={form.addressLine} onChange={set('addressLine')} error={fe.addressLine} />
            <TextInput label="Suburb" value={form.suburb} onChange={set('suburb')} error={fe.suburb} />
          </div>
        </section>

        <MembersEditor members={members} onChange={setMembers} errors={fe} />

        {error?.code === 'DUPLICATE_HOUSEHOLD' ? (
          <Notice tone="warn">
            <p>
              <strong>{error.message}</strong>
            </p>
            <p>
              <Link to={`/households/${(error.details as { householdId?: string })?.householdId}`}>Open the existing household</Link>
            </p>
          </Notice>
        ) : (
          <ErrorNotice error={error} />
        )}
        <div className="form-actions">
          <Button type="submit" busy={busy}>
            Register household
          </Button>
          <Link to="/households">Cancel</Link>
        </div>
      </form>
    </>
  );
}

type StatusAction = 'verify' | 'return' | 'resubmit' | 'suspend' | 'reinstate' | 'archive';
const ACTION_LABEL: Record<StatusAction, string> = {
  verify: 'Verify household',
  return: 'Return for correction',
  resubmit: 'Resubmit for verification',
  suspend: 'Suspend',
  reinstate: 'Reinstate',
  archive: 'Archive',
};
const NEEDS_REASON: StatusAction[] = ['return', 'suspend', 'archive'];

/** S5: profile */
export function HouseholdDetailPage() {
  const { id = '' } = useParams();
  const { user, can } = useAuth();
  const { data: h, error, loading, reload } = useLoad(() => api<HouseholdDetail>(`/households/${id}`), [id]);
  const [pending, setPending] = useState<StatusAction | null>(null);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ contactNumber: '', addressLine: '', suburb: '' });
  const action = useAction();
  const location = useLocation();
  const created = (location.state as { created?: string } | null)?.created;

  if (loading && !h) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  if (!h) return null;

  const isOps = user?.role === 'OperationsManager';
  const available: StatusAction[] = [];
  if (h.status === 'PendingVerification' && isOps) available.push('verify', 'return');
  if (h.status === 'Draft' && can('SiteCoordinator', 'OperationsManager')) available.push('resubmit');
  if (h.status === 'Active' && can('SiteCoordinator', 'OperationsManager')) available.push('suspend');
  if (h.status === 'Suspended' && isOps) available.push('reinstate');
  if ((h.status === 'Active' || h.status === 'Suspended') && can('OperationsManager', 'Admin')) available.push('archive');

  const confirm = async () => {
    if (!pending) return;
    const ok = await action.run(() => api(`/households/${h.id}/${pending}`, { body: NEEDS_REASON.includes(pending) ? { reason } : {} }));
    if (ok) {
      setPending(null);
      setReason('');
      reload();
    }
  };

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api(`/households/${h.id}`, { method: 'PATCH', body: edit }));
    if (ok) {
      setEditing(false);
      reload();
    }
  };

  return (
    <>
      <PageHeader
        title={h.headOfHousehold}
        lede={
          <>
            <span className="ref-code">{h.referenceCode}</span> at {h.homeSiteName}
          </>
        }
        actions={
          <>
            {available.map((a) => (
              <Button key={a} kind={a === 'verify' || a === 'reinstate' || a === 'resubmit' ? 'primary' : a === 'return' ? 'quiet' : 'danger'} onClick={() => setPending(a)}>
                {ACTION_LABEL[a]}
              </Button>
            ))}
            {can('OperationsManager', 'Admin') ? (
              <Button kind="quiet" onClick={() => void download(`/households/${h.id}/export`, `household-${h.referenceCode}.json`)}>
                Export data (POPIA request)
              </Button>
            ) : null}
          </>
        }
      />

      {created ? (
        <Notice tone="good">
          <p>
            Registered. Write <strong className="ref-code">{created}</strong> on the household&rsquo;s collection slip.
          </p>
        </Notice>
      ) : null}
      {h.status === 'PendingVerification' && h.registeredByName && isOps ? (
        <Notice tone="warn">
          <p>Verify once you have seen proof of address. The person who registered a household cannot verify it.</p>
        </Notice>
      ) : null}
      {h.statusReason ? (
        <Notice tone={h.status === 'Suspended' ? 'bad' : 'warn'}>
          <p>
            <strong>Reason recorded:</strong> {h.statusReason}
          </p>
        </Notice>
      ) : null}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Details</h2>
            {can('SiteCoordinator', 'OperationsManager') && ['Draft', 'PendingVerification', 'Active'].includes(h.status) && !editing ? (
              <Button kind="quiet" className="btn-small" onClick={() => {
                  setEdit({ contactNumber: h.contactNumber ?? '', addressLine: h.addressLine, suburb: h.suburb });
                  setEditing(true);
                }}>
                Edit contact details
              </Button>
            ) : null}
          </div>
          {editing ? (
            <form onSubmit={saveEdit} noValidate>
              <ErrorNotice error={action.error} />
              <TextInput label="Phone number" type="tel" value={edit.contactNumber} onChange={(e) => setEdit({ ...edit, contactNumber: e.target.value })} error={action.error?.fieldErrors.contactNumber} />
              <TextInput label="Street address" value={edit.addressLine} onChange={(e) => setEdit({ ...edit, addressLine: e.target.value })} error={action.error?.fieldErrors.addressLine} />
              <TextInput label="Suburb" value={edit.suburb} onChange={(e) => setEdit({ ...edit, suburb: e.target.value })} error={action.error?.fieldErrors.suburb} />
              <div className="form-actions">
                <Button type="submit" busy={action.busy}>
                  Save changes
                </Button>
                <Button kind="quiet" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <dl className="def-list">
              <dt>Status</dt>
              <dd>
                <Pill tone={HOUSEHOLD_STATUS[h.status].tone}>{HOUSEHOLD_STATUS[h.status].label}</Pill>
              </dd>
              <dt>Parcel size</dt>
              <dd>{h.parcelSize}</dd>
              <dt>Phone</dt>
              <dd>{h.contactNumber ?? '—'}</dd>
              <dt>Address</dt>
              <dd>
                {h.addressLine}, {h.suburb}
              </dd>
              <dt>Registered</dt>
              <dd>
                {fmtDate(h.registeredOn)} by {h.registeredByName}
              </dd>
              <dt>Verified</dt>
              <dd>{h.verifiedOn ? `${fmtDate(h.verifiedOn)} by ${h.verifiedByName}` : 'Not yet'}</dd>
            </dl>
          )}
        </section>

        <section className="panel">
          <h2>People ({h.members.length})</h2>
          <ul className="list-plain">
            {h.members.map((m) => (
              <li key={m.id} className="row-between">
                <span>{m.firstName}</span>
                <span className="muted small">
                  {RELATIONSHIP_LABEL[m.dependantType]}, {m.ageBand === '60+' ? '60+' : `${m.ageBand} yrs`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <h2>Collections</h2>
        {h.collections.length === 0 ? (
          <p className="muted">No parcels collected yet.</p>
        ) : (
          <Table caption="Collection history">
            <thead>
              <tr>
                <th>When</th>
                <th>Site</th>
                <th>Parcel</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {h.collections.map((c) => (
                <tr key={c.id}>
                  <td className="nowrap">{fmtDateTime(c.collectedAt)}</td>
                  <td>{c.siteName}</td>
                  <td>{c.parcelSize}</td>
                  <td>{c.isOverride ? <Pill tone="warn">Coordinator override</Pill> : null}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <Dialog open={pending !== null} title={pending ? ACTION_LABEL[pending] : ''} onClose={() => setPending(null)}>
        {pending === 'verify' ? <p>Confirm you have checked this household&rsquo;s identity document and proof of address.</p> : null}
        {pending && NEEDS_REASON.includes(pending) ? (
          <TextArea label="Reason" hint="The household will be told this reason." value={reason} onChange={(e) => setReason(e.target.value)} />
        ) : null}
        <ErrorNotice error={action.error} />
        <div className="form-actions">
          <Button kind={pending === 'suspend' || pending === 'archive' ? 'danger' : 'primary'} busy={action.busy} onClick={() => void confirm()}>
            {pending ? ACTION_LABEL[pending] : ''}
          </Button>
          <Button kind="quiet" onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
