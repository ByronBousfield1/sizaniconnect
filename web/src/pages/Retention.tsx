import { useState, type FormEvent } from 'react';
import { Button, Dialog, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill, Select, Table, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { fmtDate, ROLE_LABELS } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { User } from '../lib/types';

export const DEACTIVATION_REASONS = {
  Retired: 'Retired',
  Resigned: 'Resigned',
  RoleEnded: 'Contract or role ended',
  Other: 'Other',
} as const;
export type DeactivationReason = keyof typeof DEACTIVATION_REASONS;

export interface OffboardResult {
  shiftsReleased: number;
  siteLeftWithoutCoordinator: string | null;
  erasureDueOn: string;
}

/** Step 1 when someone leaves. Explains exactly what will happen before it happens (NFR-09). */
export function OffboardDialog({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: (r: OffboardResult) => void }) {
  const [reason, setReason] = useState<DeactivationReason | ''>('');
  const { busy, error, run, setError } = useAction();
  const close = () => {
    setReason('');
    setError(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await run(() => api<OffboardResult>(`/users/${user!.id}/offboard`, { body: { reason } }));
    if (res) {
      setReason('');
      onDone(res);
    }
  };
  return (
    <Dialog open={!!user} title={user ? `Offboard ${user.fullName}` : 'Offboard'} onClose={close}>
      {user ? (
        <form onSubmit={submit} noValidate>
          <p>Use this when someone has left the organisation. Straight away:</p>
          <ul>
            <li>they are signed out everywhere and cannot sign in;</li>
            <li>any reset link or recovery code they hold stops working;</li>
            <li>their places on shifts that have not started are given up, so others can sign up.</li>
          </ul>
          <p>
            Their personal details stay for 30 days in case this was a mistake (you can reactivate the account). After that, erase them from{' '}
            <strong>Data retention</strong>.
          </p>
          <ErrorNotice error={error && !error.fieldErrors.reason ? error : null} />
          <Select label="Why are they leaving?" value={reason} onChange={(e) => setReason(e.target.value as DeactivationReason)} error={error?.fieldErrors.reason}>
            <option value="">Choose a reason</option>
            {Object.entries(DEACTIVATION_REASONS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <div className="form-actions">
            <Button type="submit" kind="danger" busy={busy}>
              Offboard {user.fullName.split(' ')[0]}
            </Button>
            <Button kind="quiet" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** Step 2: irreversible, so the administrator types the email address to confirm. */
export function EraseDialog({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: (outcome: 'Deleted' | 'Anonymised') => void }) {
  const [confirm, setConfirm] = useState('');
  const { busy, error, run, setError } = useAction();
  const close = () => {
    setConfirm('');
    setError(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await run(() => api<{ outcome: 'Deleted' | 'Anonymised' }>(`/users/${user!.id}/erase`, { body: { confirmEmail: confirm } }));
    if (res) {
      setConfirm('');
      onDone(res.outcome);
    }
  };
  return (
    <Dialog open={!!user} title={user ? `Erase ${user.fullName}'s personal data` : 'Erase'} onClose={close}>
      {user ? (
        <form onSubmit={submit} noValidate>
          <Notice tone="bad">
            <p>
              <strong>This cannot be undone.</strong>
            </p>
          </Notice>
          <ul>
            <li>If the account was never used, it is deleted from the database completely.</li>
            <li>
              If it was used, the name, email, cellphone and password are removed for good. An anonymous &ldquo;Former user&rdquo; entry stays so
              that collections they recorded and the audit trail still add up.
            </li>
          </ul>
          <TextInput
            label={`Type ${user.email} to confirm`}
            autoComplete="off"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={error?.fieldErrors.confirmEmail}
          />
          <ErrorNotice error={error && !error.fieldErrors.confirmEmail ? error : null} />
          <div className="form-actions">
            <Button type="submit" kind="danger" busy={busy} disabled={confirm.trim().toLowerCase() !== user.email.toLowerCase()}>
              Erase permanently
            </Button>
            <Button kind="quiet" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

interface Overview {
  policy: { userErasureGraceDays: number; householdRetentionMonths: number };
  usersAwaitingErasure: (User & { erasureDueOn: string; isDue: boolean })[];
  erasedUserCount: number;
  householdsDue: { total: number; items: { id: string; referenceCode: string; suburb: string; archivedAt: string }[] };
  anonymisedHouseholdCount: number;
}

/** S23: what personal data is due for removal, and the buttons that remove it (POPIA, NFR-16). */
export function RetentionPage() {
  const { data, error, loading, reload } = useLoad(() => api<Overview>('/retention'));
  const [erasing, setErasing] = useState<User | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmHouseholds, setConfirmHouseholds] = useState(false);
  const anonymise = useAction();

  const runAnonymise = async () => {
    const res = await anonymise.run(() => api<{ anonymised: number }>('/retention/households/anonymise', { body: {} }));
    setConfirmHouseholds(false);
    if (res) {
      setMessage(`${res.anonymised} ${res.anonymised === 1 ? 'household was' : 'households were'} anonymised.`);
      reload();
    }
  };

  return (
    <>
      <PageHeader
        title="Data retention"
        lede="Personal information is kept only as long as it is needed (POPIA). This screen shows what is due for removal and removes it."
      />
      {message ? (
        <Notice tone="good">
          <p>{message}</p>
        </Notice>
      ) : null}
      <ErrorNotice error={error ?? anonymise.error} />
      {loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <section className="panel" aria-labelledby="ret-users-h">
            <div className="panel-head">
              <h2 id="ret-users-h">People who have left</h2>
              <span className="muted small">{data.erasedUserCount} erased so far</span>
            </div>
            <p className="small muted">
              Offboarded accounts are kept for {data.policy.userErasureGraceDays} days in case of a mistake, then their personal data should be
              erased.
            </p>
            {data.usersAwaitingErasure.length === 0 ? (
              <Empty title="Nobody is waiting to be erased" />
            ) : (
              <Table caption="Offboarded accounts">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Left</th>
                    <th>Erase by</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.usersAwaitingErasure.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.fullName}
                        <div className="small muted">{u.email}</div>
                      </td>
                      <td>{ROLE_LABELS[u.role]}</td>
                      <td>
                        {fmtDate(u.deactivatedAt)}
                        <div className="small muted">{u.deactivationReason ? DEACTIVATION_REASONS[u.deactivationReason] : ''}</div>
                      </td>
                      <td>{u.isDue ? <Pill tone="bad">Due now</Pill> : fmtDate(u.erasureDueOn)}</td>
                      <td>
                        <Button kind={u.isDue ? 'danger' : 'quiet'} className="btn-small" onClick={() => setErasing(u)}>
                          Erase personal data
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          <section className="panel" aria-labelledby="ret-hh-h">
            <div className="panel-head">
              <h2 id="ret-hh-h">Archived households</h2>
              <span className="muted small">{data.anonymisedHouseholdCount} anonymised so far</span>
            </div>
            <p className="small muted">
              Households archived more than {data.policy.householdRetentionMonths} months ago are anonymised (NFR-16): names, addresses,
              cellphone numbers and identity hashes are removed. Reference codes, suburbs, age groups and collection history stay so reports
              still add up.
            </p>
            {data.householdsDue.total === 0 ? (
              <Empty title="No households are due" />
            ) : (
              <>
                <p>
                  <strong>{data.householdsDue.total}</strong> {data.householdsDue.total === 1 ? 'household is' : 'households are'} due, the
                  oldest archived on {fmtDate(data.householdsDue.items[0]?.archivedAt)}.
                </p>
                <Table caption="Households due for anonymisation">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Suburb</th>
                      <th>Archived</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.householdsDue.items.map((x) => (
                      <tr key={x.id}>
                        <td className="nowrap">{x.referenceCode}</td>
                        <td>{x.suburb}</td>
                        <td>{fmtDate(x.archivedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Button kind="danger" onClick={() => setConfirmHouseholds(true)}>
                  Anonymise {data.householdsDue.total} {data.householdsDue.total === 1 ? 'household' : 'households'}
                </Button>
              </>
            )}
          </section>
        </>
      ) : null}

      <EraseDialog
        user={erasing}
        onClose={() => setErasing(null)}
        onDone={(outcome) => {
          setMessage(
            outcome === 'Deleted'
              ? `${erasing?.fullName}'s account was never used, so it was deleted completely.`
              : `${erasing?.fullName}'s personal data was erased. Their past work now shows as "Former user".`,
          );
          setErasing(null);
          reload();
        }}
      />
      <Dialog open={confirmHouseholds} title="Anonymise archived households?" onClose={() => setConfirmHouseholds(false)}>
        <p>This permanently removes the personal details of {data?.householdsDue.total} archived households. It cannot be undone.</p>
        <div className="form-actions">
          <Button kind="danger" busy={anonymise.busy} onClick={() => void runAnonymise()}>
            Anonymise now
          </Button>
          <Button kind="quiet" onClick={() => setConfirmHouseholds(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
