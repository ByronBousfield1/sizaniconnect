import { useState, type FormEvent } from 'react';
import { Button, ErrorNotice, Loading, Notice, PageHeader, Pill, Select, Table, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, ROLE_LABELS } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { Paged, Role, Site, User } from '../lib/types';

const ROLES: Role[] = ['Admin', 'OperationsManager', 'SiteCoordinator', 'Volunteer', 'Donor'];

/** S20: users and roles (US-18) */
export function UsersPage() {
  const { user: me } = useAuth();
  const users = useLoad(() => api<User[]>('/users'));
  const sites = useLoad(() => api<Site[]>('/sites'));
  const donors = useLoad(() => api<{ id: string; donorName: string }[]>('/donors'));
  const [form, setForm] = useState({ fullName: '', email: '', phoneNumber: '', role: 'Volunteer' as Role, siteId: '', donorId: '' });
  const [created, setCreated] = useState<{ name: string; link?: string } | null>(null);
  const create = useAction();
  const update = useAction();
  const fe = create.error?.fieldErrors ?? {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create.run(() =>
      api<{ id: string; activationLink?: string }>('/users', {
        body: { ...form, siteId: form.siteId || null, donorId: form.donorId || null },
      }),
    );
    if (res) {
      setCreated({ name: form.fullName, link: res.activationLink });
      setForm({ fullName: '', email: '', phoneNumber: '', role: 'Volunteer', siteId: '', donorId: '' });
      users.reload();
    }
  };

  const toggle = async (u: User) => {
    const ok = await update.run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { isActive: !u.isActive } }));
    if (ok) users.reload();
  };

  return (
    <>
      <PageHeader title="Users" lede="New accounts get an emailed link to choose their own password. Nobody, including administrators, ever sees it." />
      {created ? (
        <Notice tone="good">
          <p>Account created for {created.name}.</p>
          {created.link ? (
            <p className="small">
              Email is not configured, so hand this one-time activation link to the person directly. It expires in 72 hours:
              <br />
              <code style={{ wordBreak: 'break-all' }}>{created.link}</code>
            </p>
          ) : null}
        </Notice>
      ) : null}

      <form className="panel" onSubmit={submit} noValidate>
        <h2>Add a user</h2>
        <ErrorNotice error={create.error} />
        <div className="form-row">
          <TextInput label="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} error={fe.fullName} />
          <TextInput label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={fe.email} />
          <TextInput label="Phone" hint="Optional" type="tel" value={form.phoneNumber} onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })} error={fe.phoneNumber} />
        </div>
        <div className="form-row">
          <Select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
          {form.role === 'SiteCoordinator' ? (
            <Select label="Site" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
              <option value="">Choose a site</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.siteName}
                </option>
              ))}
            </Select>
          ) : null}
          {form.role === 'Donor' ? (
            <Select label="Donor record" value={form.donorId} onChange={(e) => setForm({ ...form, donorId: e.target.value })}>
              <option value="">Choose a donor</option>
              {donors.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.donorName}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <Button type="submit" busy={create.busy}>
          Create account
        </Button>
      </form>

      <ErrorNotice error={users.error ?? update.error} />
      {users.loading && !users.data ? <Loading /> : null}
      {users.data ? (
        <Table caption="Users">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <td>{u.fullName}</td>
                <td>{u.email}</td>
                <td>
                  {ROLE_LABELS[u.role]}
                  {u.siteName ? <div className="small muted">{u.siteName}</div> : null}
                </td>
                <td>{u.isActive ? <Pill tone="good">Active</Pill> : <Pill tone="neutral">Deactivated</Pill>}</td>
                <td>
                  {u.id !== me?.id ? (
                    <Button kind={u.isActive ? 'danger' : 'quiet'} className="btn-small" busy={update.busy} onClick={() => void toggle(u)}>
                      {u.isActive ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  ) : (
                    <span className="small muted">You</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}

/** S21: distribution sites */
export function SitesPage() {
  const sites = useLoad(() => api<Site[]>('/sites'));
  const [form, setForm] = useState({ siteName: '', suburb: '', capacityPerEvent: '100' });
  const create = useAction();
  const update = useAction();
  const fe = create.error?.fieldErrors ?? {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await create.run(() => api('/sites', { body: { ...form, capacityPerEvent: Number(form.capacityPerEvent) } }));
    if (ok) {
      setForm({ siteName: '', suburb: '', capacityPerEvent: '100' });
      sites.reload();
    }
  };

  return (
    <>
      <PageHeader title="Distribution sites" />
      <form className="panel" onSubmit={submit} noValidate>
        <h2>Add a site</h2>
        <ErrorNotice error={create.error} />
        <div className="form-row">
          <TextInput label="Site name" value={form.siteName} onChange={(e) => setForm({ ...form, siteName: e.target.value })} error={fe.siteName} />
          <TextInput label="Suburb" value={form.suburb} onChange={(e) => setForm({ ...form, suburb: e.target.value })} error={fe.suburb} />
          <TextInput label="Parcels per event, at most" type="number" min={1} value={form.capacityPerEvent} onChange={(e) => setForm({ ...form, capacityPerEvent: e.target.value })} error={fe.capacityPerEvent} />
        </div>
        <Button type="submit" busy={create.busy}>
          Add site
        </Button>
      </form>
      <ErrorNotice error={sites.error ?? update.error} />
      {sites.data ? (
        <Table caption="Sites">
          <thead>
            <tr>
              <th>Site</th>
              <th>Suburb</th>
              <th className="num">Capacity</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sites.data.map((s) => (
              <tr key={s.id}>
                <td>{s.siteName}</td>
                <td>{s.suburb}</td>
                <td className="num">{s.capacityPerEvent}</td>
                <td>{s.isActive ? <Pill tone="good">In use</Pill> : <Pill tone="neutral">Closed</Pill>}</td>
                <td>
                  <Button
                    kind="quiet"
                    className="btn-small"
                    busy={update.busy}
                    onClick={() => void update.run(() => api(`/sites/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } })).then((ok) => ok && sites.reload())}
                  >
                    {s.isActive ? 'Close site' : 'Reopen site'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}

interface AuditRow {
  id: number;
  occurredAt: string;
  entityName: string;
  entityId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userName: string | null;
}

/** S22: the POPIA audit trail (US-19). Read-only by design: the database refuses edits. */
export function AuditPage() {
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useLoad(() => api<Paged<AuditRow>>('/audit', { query: { entityName: entity, page, pageSize: 50 } }), [entity, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="Audit log" lede="Every change to beneficiary, user and stock records, newest first. Entries cannot be edited or deleted." />
      <div style={{ maxWidth: '20rem' }}>
        <Select label="Show" value={entity} onChange={(e) => {
            setEntity(e.target.value);
            setPage(1);
          }}>
          <option value="">All records</option>
          {['Household', 'Collection', 'User', 'DistributionEvent', 'Donation', 'StockBatch', 'ShiftAssignment'].map((x) => (
            <option key={x} value={x}>
              {x.replace(/([a-z])([A-Z])/g, '$1 $2')}
            </option>
          ))}
        </Select>
      </div>
      <ErrorNotice error={error} />
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <Table caption="Audit entries">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Record</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{fmtDateTime(a.occurredAt)}</td>
                  <td>{a.userName ?? <span className="muted">System or anonymous</span>}</td>
                  <td>{a.entityName}</td>
                  <td className="nowrap">{a.action.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="small muted">
                    {a.details
                      ? Object.entries(a.details)
                          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                          .join('; ')
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <nav className="form-actions" aria-label="Pages">
            <Button kind="quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Newer
            </Button>
            <span className="muted">
              Page {page} of {pages}
            </span>
            <Button kind="quiet" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Older
            </Button>
          </nav>
        </>
      ) : null}
    </>
  );
}
