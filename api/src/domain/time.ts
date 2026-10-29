export const SA_TIMEZONE = 'Africa/Johannesburg';

/** Today's date in South Africa as yyyy-mm-dd, regardless of the server's own timezone. */
export function saDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** South Africa has no daylight saving, so SAST is a fixed UTC+02:00. */
export function saDateTime(date: string, time: string): Date {
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  return new Date(`${date}T${hhmmss}+02:00`);
}

export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start, end };
}

/** The same instant `months` calendar months later (negative for earlier), clamped to the month's last day. */
export function addMonthsUtc(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
