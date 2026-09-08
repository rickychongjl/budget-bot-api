import type { Instant, LocalDate } from './common';

/**
 * Calendar arithmetic on a user-local `LocalDate` (`YYYY-MM-DD`), plus the one
 * timezone-aware operation everything else is built on: which local date an
 * `Instant` falls on.
 *
 * Lives in `core/shared` because it is a genuinely shared concept rather than one
 * feature's calculation (CLAUDE.md, "Shared domain code"): M2 derives an onboarding
 * date, M8 anchors the daily quota, M3 stamps `occurred_on`, M4 derives period
 * bounds, M5 counts days remaining. `core/identity/timezones.ts` anticipated exactly
 * this ("if more modules end up needing `localDateAt` … it is a candidate for
 * `core/shared`"); M3/M4 are those modules, so the implementation moved here and
 * M2's and M8's modules now delegate to it under their existing export names.
 *
 * Everything here is pure: same input, same output, no clock, no DB. The `Instant`
 * always arrives as an argument (master plan §6).
 *
 * Backed by the runtime's IANA database via `Intl`, available in both Workers (V8)
 * and Node ≥ 18 without a dependency.
 */

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

export function isLocalDate(value: string): value is LocalDate {
  const m = LOCAL_DATE_PATTERN.exec(value);
  if (!m) return false;
  // Round-trips only for a real date: `2026-02-31` normalises to March and fails here.
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Throws for anything that is not a real `YYYY-MM-DD` calendar date. */
export function parseLocalDate(localDate: LocalDate): CalendarDate {
  if (!isLocalDate(localDate)) throw new Error(`local-date: not a YYYY-MM-DD date: ${localDate}`);
  const m = LOCAL_DATE_PATTERN.exec(localDate) as RegExpExecArray;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatLocalDate(date: CalendarDate): LocalDate {
  return `${String(date.year).padStart(4, '0')}-${pad2(date.month)}-${pad2(date.day)}`;
}

/**
 * `localDate` + `days` as a calendar date. No timezone is involved — this is date
 * arithmetic, not instant arithmetic, so a DST transition inside the span is
 * irrelevant by construction.
 */
export function addLocalDays(localDate: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(localDate);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatLocalDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/**
 * `localDate` + `months`, keeping the day-of-month. The caller is responsible for a
 * day that does not exist in the target month (`Date.UTC` would roll it forward into
 * the next one) — M4 never hits this because its start day is capped at 28.
 */
export function addLocalMonths(localDate: LocalDate, months: number): LocalDate {
  const { year, month, day } = parseLocalDate(localDate);
  const d = new Date(Date.UTC(year, month - 1 + months, day));
  return formatLocalDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/** Negative when `a` is earlier, 0 when equal, positive when later. ISO dates sort lexically. */
export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `date` is within `[start, end]`, both inclusive. */
export function isWithin(date: LocalDate, start: LocalDate, end: LocalDate): boolean {
  return date >= start && date <= end;
}

const DAY_MS = 86_400_000;

/**
 * Whole days from `from` to `to`, counting both ends — `daysInclusive(d, d) === 1`.
 * This is what makes M5's "days left in the period" divide by 1 on the last day of a
 * period rather than by 0.
 */
export function daysInclusive(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  const spanMs = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(spanMs / DAY_MS) + 1;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The user-local calendar date at `instant`. `en-CA` renders ISO `YYYY-MM-DD`
 * directly, so no part reassembly is needed.
 */
export function localDateAt(instant: Instant, timeZone: string): LocalDate {
  let f = dateFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timeZone, f);
  }
  return f.format(new Date(instant));
}
