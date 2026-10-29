import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ErrorNotice, Notice, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { homeFor, useAuth } from '../lib/auth';
import { useAction } from '../lib/hooks';

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div>
          <div className="auth-mark" />
          <h1>Food reaches the right households, every time.</h1>
          <p>Registration, distribution days, volunteer shifts and stock for Sizani Community Food Network.</p>
        </div>
        <p className="auth-foot small">Sizani Community Food Network NPC, Johannesburg</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}

/** S1 */
export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = await run(() => login(email.trim(), password));
    if (u) navigate(homeFor(u.role), { replace: true });
  };

  return (
    <AuthShell>
      <h2>Sign in</h2>
      <form onSubmit={submit} noValidate>
        <ErrorNotice error={error} />
        <TextInput label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextInput
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="form-actions">
          <Button type="submit" busy={busy}>
            Sign in
          </Button>
          <Link to="/forgot-password">Forgot your password?</Link>
        </div>
      </form>
    </AuthShell>
  );
}

/** S2 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api('/auth/forgot-password', { body: { email: email.trim() } }));
    if (ok !== undefined) setSent(true);
  };

  return (
    <AuthShell>
      <h2>Reset your password</h2>
      {sent ? (
        <Notice tone="good">
          <p>If that email belongs to an account, a reset link is on its way. It works once and expires in 30 minutes.</p>
        </Notice>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="muted">Enter the email you sign in with. We will send you a link to choose a new password.</p>
          <ErrorNotice error={error} />
          <TextInput label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Button type="submit" busy={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="small" style={{ marginTop: '1.5rem' }}>
        Email not arriving? <Link to="/recover">Use a recovery code instead</Link>.
      </p>
      <p className="small" style={{ marginTop: '1.5rem' }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}

/** Used for both password resets and first-time account activation. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const activating = params.get('activate') === '1';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const { busy, error, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMismatch(password !== confirm);
    if (password !== confirm) return;
    const ok = await run(() => api('/auth/reset-password', { body: { token, newPassword: password } }));
    if (ok !== undefined) setDone(true);
  };

  return (
    <AuthShell>
      <h2>{activating ? 'Choose your password' : 'Choose a new password'}</h2>
      {!token ? (
        <Notice tone="bad">
          <p>This link is incomplete. Open the link from your email again, or request a new one.</p>
        </Notice>
      ) : done ? (
        <Notice tone="good">
          <p>Password saved.</p>
          <p>
            <Link to="/login">Sign in now</Link>
          </p>
        </Notice>
      ) : (
        <form onSubmit={submit} noValidate>
          <ErrorNotice error={error} />
          <TextInput
            label="New password"
            hint="At least 12 characters. A short phrase is easier to remember than a jumble."
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextInput
            label="Type it again"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={mismatch ? 'The two passwords do not match.' : undefined}
          />
          <Button type="submit" busy={busy}>
            Save password
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

/** S2b: reset with a recovery code saved earlier. Needs no email, so an administrator is never stuck. */
export function RecoverPage() {
  const [form, setForm] = useState({ email: '', recoveryCode: '', newPassword: '', confirm: '' });
  const [mismatch, setMismatch] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const fe = error?.fieldErrors ?? {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMismatch(form.newPassword !== form.confirm);
    if (form.newPassword !== form.confirm) return;
    const res = await run(() =>
      api<{ remainingCodes: number }>('/auth/recover', {
        body: { email: form.email.trim(), recoveryCode: form.recoveryCode, newPassword: form.newPassword },
      }),
    );
    if (res) setRemaining(res.remainingCodes);
  };

  return (
    <AuthShell>
      <h2>Use a recovery code</h2>
      {remaining !== null ? (
        <Notice tone="good">
          <p>Password saved. That code cannot be used again.</p>
          <p>
            {remaining === 0
              ? 'That was your last code. After signing in, create a new set under My account.'
              : `You have ${remaining} ${remaining === 1 ? 'code' : 'codes'} left.`}
          </p>
          <p>
            <Link to="/login">Sign in now</Link>
          </p>
        </Notice>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="muted">Enter one of the recovery codes you saved when you set up your account, and choose a new password.</p>
          {error && !Object.keys(fe).length ? <ErrorNotice error={error} /> : null}
          <TextInput label="Email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={fe.email} />
          <TextInput
            label="Recovery code"
            hint="Ten letters and numbers, for example 7K2QX-9MDRA"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            value={form.recoveryCode}
            onChange={(e) => setForm({ ...form, recoveryCode: e.target.value })}
            error={fe.recoveryCode}
          />
          <TextInput
            label="New password"
            hint="At least 12 characters. A short phrase is easier to remember than a jumble."
            type="password"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
            error={fe.newPassword}
          />
          <TextInput
            label="Type it again"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            error={mismatch ? 'The two passwords do not match.' : undefined}
          />
          <Button type="submit" busy={busy}>
            Save new password
          </Button>
        </form>
      )}
      <p className="small" style={{ marginTop: '1.5rem' }}>
        No codes saved? Ask another administrator to send you a reset link. <Link to="/login">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}
