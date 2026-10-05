import { useState } from 'react';
import { Button, Empty, ErrorNotice, Loading, Notice, PageHeader, Pill } from '../components/ui';
import { api } from '../lib/api';
import { fmtDate, fmtTime } from '../lib/format';
import { useAction, useLoad } from '../lib/hooks';
import type { Shift } from '../lib/types';

const CHECKIN_WINDOW_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** S14 (shift board), S15 (my shifts) and S16 (check-in) */
export function ShiftsPage() {
  const [tab, setTab] = useState<'board' | 'mine'>('board');
  const board = useLoad(() => api<Shift[]>('/shifts', { query: { days: 21 } }));
  const mine = useLoad(() => api<Shift[]>('/shifts/mine'));
  const action = useAction();
  const [message, setMessage] = useState<string | null>(null);

  const act = async (shift: Shift, verb: 'signup' | 'withdraw' | 'checkin') => {
    setMessage(null);
    const ok = await action.run(() => api(`/shifts/${shift.id}/${verb}`, { method: 'POST' }));
    if (ok) {
      setMessage(
        verb === 'signup'
          ? `You are signed up for ${shift.siteName} on ${fmtDate(shift.eventDate)}.`
          : verb === 'withdraw'
            ? 'You have withdrawn. The coordinator has been told.'
            : 'Checked in. Thank you for coming.',
      );
      board.reload();
      mine.reload();
    }
  };

  const now = Date.now();
  const upcomingMine = (mine.data ?? []).filter((s) => s.myStatus !== 'Withdrawn' && new Date(s.endsAt).getTime() > now);
  const pastMine = (mine.data ?? []).filter((s) => s.myStatus === 'CheckedIn' && new Date(s.endsAt).getTime() <= now);
  const checkinNow = upcomingMine.filter(
    (s) => s.myStatus === 'Assigned' && new Date(s.startsAt).getTime() - CHECKIN_WINDOW_MS <= now && new Date(s.endsAt).getTime() >= now,
  );

  return (
    <>
      <PageHeader title="Volunteer shifts" lede="Choose the shifts that suit you. Check in when you arrive so your hours are counted." />

      {checkinNow.map((s) => (
        <div key={s.id} className="desk-scan" style={{ marginBottom: 'var(--s-5)' }}>
          <p style={{ fontWeight: 700, fontSize: '1.25rem', margin: 0 }}>Your shift at {s.siteName} has started</p>
          <p style={{ color: '#d8d6f0' }}>
            {fmtTime(s.startsAt)} to {fmtTime(s.endsAt)}
          </p>
          <Button kind="action" className="btn-record" busy={action.busy} onClick={() => void act(s, 'checkin')}>
            Check in now
          </Button>
        </div>
      ))}

      {message ? (
        <Notice tone="good">
          <p>{message}</p>
        </Notice>
      ) : null}
      <ErrorNotice error={action.error} />

      <div className="segmented" role="group" aria-label="Which shifts">
        <button type="button" aria-pressed={tab === 'board'} onClick={() => setTab('board')}>
          Open shifts
        </button>
        <button type="button" aria-pressed={tab === 'mine'} onClick={() => setTab('mine')}>
          My shifts ({upcomingMine.length})
        </button>
      </div>

      {tab === 'board' ? (
        board.loading && !board.data ? (
          <Loading />
        ) : board.data?.length ? (
          <ul className="list-plain panel">
            {board.data.map((s) => {
              const left = s.volunteersNeeded - s.filled;
              const started = new Date(s.startsAt).getTime() <= now;
              return (
                <li key={s.id} className="row-between">
                  <div>
                    <strong>{s.siteName}</strong>
                    <div className="small muted">
                      {fmtDate(s.eventDate)}, {fmtTime(s.startsAt)} to {fmtTime(s.endsAt)}
                      {s.notes ? `. ${s.notes}` : ''}
                    </div>
                  </div>
                  <div className="row-between" style={{ gap: 'var(--s-3)' }}>
                    {s.myStatus === 'Assigned' || s.myStatus === 'CheckedIn' ? (
                      <Pill tone="good">{s.myStatus === 'CheckedIn' ? 'Checked in' : 'You are on this shift'}</Pill>
                    ) : left > 0 && !started ? (
                      <>
                        <span className="small muted">{left} {left === 1 ? 'place' : 'places'} left</span>
                        <Button className="btn-small" busy={action.busy} onClick={() => void act(s, 'signup')}>
                          Sign up
                        </Button>
                      </>
                    ) : (
                      <Pill tone="neutral">{started ? 'Started' : 'Full'}</Pill>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title="No shifts in the next three weeks">
            <p>New shifts appear here as soon as coordinators publish them.</p>
          </Empty>
        )
      ) : (
        <>
          {upcomingMine.length === 0 ? (
            <Empty title="You have no upcoming shifts">
              <p>Choose one from the open shifts.</p>
            </Empty>
          ) : (
            <ul className="list-plain panel">
              {upcomingMine.map((s) => {
                const lateToWithdraw = new Date(s.startsAt).getTime() - now < DAY_MS;
                return (
                  <li key={s.id} className="row-between">
                    <div>
                      <strong>{s.siteName}</strong>
                      <div className="small muted">
                        {fmtDate(s.eventDate)}, {fmtTime(s.startsAt)} to {fmtTime(s.endsAt)}
                      </div>
                    </div>
                    {s.myStatus === 'CheckedIn' ? (
                      <Pill tone="good">Checked in</Pill>
                    ) : lateToWithdraw ? (
                      <span className="small muted">Can&rsquo;t make it? Phone your coordinator.</span>
                    ) : (
                      <Button kind="quiet" className="btn-small" busy={action.busy} onClick={() => void act(s, 'withdraw')}>
                        Withdraw
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {pastMine.length > 0 ? (
            <section className="panel">
              <h2>Recently served</h2>
              <ul className="list-plain">
                {pastMine.map((s) => (
                  <li key={s.id} className="row-between">
                    <span>
                      {s.siteName}, {fmtDate(s.eventDate)}
                    </span>
                    <Pill tone="good">Served</Pill>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
