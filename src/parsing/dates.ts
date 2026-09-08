import type { Instant, LocalDate } from '../core/shared/common';

/**
 * Small, pure calendar helpers for the parser. No `Date.now()` anywhere — every
 * function takes the instant or date it needs. Timezone maths goes through `Intl`
 * (available in Workers with `nodejs_compat` off or on) rather than a library.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidLocalDate(value: string): value is LocalDate {
  const m = ISO_DATE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function toLocalDate(year: number, month1: number, day: number): LocalDate {
  return `${String(year).padStart(4, '0')}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function splitLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(date);
  if (m === null) throw new Error(`not a LocalDate: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Days since the Unix epoch for a calendar date (timezone-free arithmetic). */
export function dayNumber(date: LocalDate): number {
  const { year, month, day } = splitLocalDate(date);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date((dayNumber(date) + days) * 86_400_000);
  return toLocalDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: LocalDate): number {
  return new Date(dayNumber(date) * 86_400_000).getUTCDay();
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return dayNumber(a) - dayNumber(b);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockIn(instant: Instant, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The user-local calendar date at `instant`. */
export function localDateAt(instant: Instant, timezone: string): LocalDate {
  const w = wallClockIn(instant, timezone);
  return toLocalDate(w.year, w.month, w.day);
}

/**
 * The instant at local noon on `date` in `timezone`. Used as `occurred_at` for a
 * backdated transaction, where the user gave a day but not a time — noon keeps the
 * `occurred_on` derivation stable across any DST shift that day.
 */
export function instantAtLocalNoon(date: LocalDate, timezone: string): Instant {
  const { year, month, day } = splitLocalDate(date);
  // First guess: treat local noon as UTC noon, then correct by the offset Intl reports.
  const guess = Date.UTC(year, month - 1, day, 12, 0, 0);
  const w = wallClockIn(guess, timezone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offsetMs = asIfUtc - guess;
  return guess - offsetMs;
}
