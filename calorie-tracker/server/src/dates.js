// Calendar dates are plain `YYYY-MM-DD` strings. Arithmetic is done in UTC so
// that DST changes can never skip or repeat a day.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar date such as 2024-02-29; false for 2026-02-30. */
export function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** The server's local date (not UTC) as `YYYY-MM-DD`. */
export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `addDays('2026-03-01', -1)` -> `'2026-02-28'`. */
export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The `days` dates ending on (and including) `end`, oldest first. */
export function dateRange(end, days) {
  return Array.from({ length: days }, (_, i) => addDays(end, i - days + 1));
}
