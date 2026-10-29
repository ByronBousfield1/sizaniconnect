import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorNotice, Loading, Notice, PageHeader, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtPhone, ROLE_LABELS } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';

interface CodeStatus {
  remaining: number;
  generatedAt: string | null;
}

/** S24: the signed-in person's own account: details, password and recovery codes. */
export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <PageHeader title="My account" />
      <div className="grid-2">
        <section className="panel" aria-labelledby="details-h">
          <h2 id="details-h">Your details</h2>
          <dl className="def-list">
            <dt>Name</dt>
            <dd>{user.fullName}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>
              {ROLE_LABELS[user.role]}
              {user.siteName ? `, ${user.siteName}` : ''}
            </dd>
            <dt>Cellphone</dt>
            <dd>{fmtPhone(user.phoneNumber)}</dd>
          </dl>
          <p className="small muted">To change these, ask your administrator.</p>
        </section>
        <ChangePassword />
      </div>
      <RecoveryCodes />
    </>
  );
}

function ChangePassword() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const fe = error?.fieldErrors ?? {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    setMismatch(form.newPassword !== form.confirm);
    if (form.newPassword !== form.confirm) return;
    const ok = await run(() => api('/auth/change-password', { body: { currentPassword: form.currentPassword, newPassword: form.newPassword } }));
    if (ok) {
      setDone(true);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
    }
  };

  return (
    <form className="panel" onSubmit={submit} noValidate aria-labelledby="pw-h">
      <h2 id="pw-h">Change your password</h2>
      {done ? (
        <Notice tone="good">
          <p>Password changed. Any other phone or computer signed in as you has been signed out.</p>
        </Notice>
      ) : null}
      {error && !Object.keys(fe).length ? <ErrorNotice error={error} /> : null}
      <TextInput
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={form.currentPassword}
        onChange={(e) => {
              const value = e.target.value;
              setForm((p) => ({ ...p, currentPassword: value }));
            }}
        error={fe.currentPassword}
      />
      <TextInput
        label="New password"
        hint="At least 12 characters. A short phrase is easier to remember than a jumble."
        type="password"
        autoComplete="new-password"
        value={form.newPassword}
        onChange={(e) => {
              const value = e.target.value;
              setForm((p) => ({ ...p, newPassword: value }));
            }}
        error={fe.newPassword}
      />
      <TextInput
        label="Type the new password again"
        type="password"
        autoComplete="new-password"
        value={form.confirm}
        onChange={(e) => {
              const value = e.target.value;
              setForm((p) => ({ ...p, confirm: value }));
            }}
        error={mismatch ? 'The two passwords do not match.' : undefined}
      />
      <Button type="submit" busy={busy}>
        Change password
      </Button>
    </form>
  );
}

function RecoveryCodes() {
  const status = useLoad(() => api<CodeStatus>('/auth/recovery-codes'));
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState(false);
  const { busy, error, run } = useAction();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const res = await run(() => api<{ codes: string[] }>('/auth/recovery-codes', { body: { password } }));
    if (res) {
      setCodes(res.codes);
      setPassword('');
      setAsking(false);
      status.reload();
    }
  };

  const save = () => {
    const text = `SizaniConnect recovery codes\nCreated ${new Date().toLocaleString('en-ZA')}\n\nEach code works once. Keep this somewhere safe and private.\n\n${codes!.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sizaniconnect-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="panel" id="recovery" aria-labelledby="rc-h">
      <h2 id="rc-h">Recovery codes</h2>
      <p>
        If you forget your password, a recovery code lets you choose a new one on the{' '}
        <Link to="/recover">sign-in page</Link>, even when email is not working. Each code works once.
      </p>
      {status.loading && !status.data ? <Loading /> : null}
      <ErrorNotice error={status.error} />

      {codes ? (
        <>
          <Notice tone="warn">
            <p>
              <strong>Save these now.</strong> They are shown only once. Print them or download them and keep them somewhere private,
              not on the same phone you sign in with.
            </p>
          </Notice>
          <ol className="recovery-codes" aria-label="Your recovery codes">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <div className="form-actions">
            <Button onClick={save}>Download as a text file</Button>
            <Button kind="quiet" onClick={() => window.print()}>
              Print
            </Button>
            <Button kind="quiet" onClick={() => setCodes(null)}>
              I have saved them
            </Button>
          </div>
        </>
      ) : status.data ? (
        <>
          <p>
            {status.data.remaining === 0
              ? 'You have no recovery codes yet.'
              : `${status.data.remaining} of 10 codes left, created ${fmtDate(status.data.generatedAt)}.`}
          </p>
          {asking ? (
            <form onSubmit={create} noValidate className="inline-form">
              <TextInput
                label="Enter your password to continue"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={error?.fieldErrors.password}
              />
              {error && !error.fieldErrors.password ? <ErrorNotice error={error} /> : null}
              <div className="form-actions">
                <Button type="submit" busy={busy}>
                  {status.data.remaining ? 'Replace my codes' : 'Create my codes'}
                </Button>
                <Button kind="quiet" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button kind={status.data.remaining ? 'quiet' : 'primary'} onClick={() => setAsking(true)}>
              {status.data.remaining ? 'Create a new set (the old codes stop working)' : 'Create recovery codes'}
            </Button>
          )}
        </>
      ) : null}
    </section>
  );
}

/** Shown to administrators on their start page until they have recovery codes. */
export function RecoveryCodesReminder() {
  const { data } = useLoad(() => api<CodeStatus>('/auth/recovery-codes'));
  if (!data || data.remaining >= 3) return null;
  return (
    <Notice tone="warn">
      <p>
        {data.remaining === 0
          ? 'You have no recovery codes. If you forget your password while email is down, you could be locked out of the system.'
          : `Only ${data.remaining} recovery ${data.remaining === 1 ? 'code is' : 'codes are'} left.`}{' '}
        <Link to="/account#recovery">Set up recovery codes</Link>
      </p>
    </Notice>
  );
}
