import { addDays, parseLocalDate } from './api.js';

const intFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const gramFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const kcal = (n) => intFormat.format(Math.round(n || 0));
export const grams = (n) => `${gramFormat.format(n || 0)} g`;

export function dayLabel(date, today) {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return shortDate(date);
}

function shortDate(date) {
  return parseLocalDate(date).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Second line under the day title: the date for Today/Yesterday, otherwise
// how long ago it was (the title already shows the date).
export function daySubtitle(date, today) {
  const days = Math.round((parseLocalDate(today) - parseLocalDate(date)) / 86_400_000);
  if (days <= 1) return shortDate(date);
  if (days < 365) return `${days} days ago`;
  return String(parseLocalDate(date).getFullYear());
}

export function weekday(date) {
  return parseLocalDate(date).toLocaleDateString(undefined, { weekday: 'short' });
}

export function timeOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Form field parsing: both return null for blank and NaN for anything that is
// not clearly a number, never a guess.

// Whole numbers (kcal, daily goal). "1,200", "1.200" and "1 200" are thousands
// separators here, never decimals.
export function parseWhole(value) {
  const str = String(value ?? '').trim();
  if (str === '') return null;
  const digits = /^\d{1,3}([,.\s'’]\d{3})+$/.test(str) ? str.replace(/\D/g, '') : str;
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
}

// Decimals (grams). A comma is a decimal point only when one or two digits
// follow it ("12,5"); "1,200" could mean either, so it is rejected.
export function parseDecimal(value) {
  const str = String(value ?? '').trim();
  if (str === '') return null;
  const normalized = /^\d+,\d{1,2}$/.test(str) ? str.replace(',', '.') : str;
  return /^(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : NaN;
}
