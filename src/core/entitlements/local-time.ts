import type { Instant, LocalDate } from '../shared/common';
import {
  addLocalDays as sharedAddLocalDays,
  localDateAt,
  parseLocalDate,
} from '../shared/local-date';

/**
 * IANA-timezone helpers for the daily-quota boundary (M8: "midnight in the user's
 * immutable IANA timezone"). Pure functions over an `Instant` — no `Date.now()` —
 * built on `Intl.DateTimeFormat`, which both Node 20+ (full ICU) and the Workers
 * runtime ship. No timezone library dependency.
 *
 * The plain calendar helpers this used to keep privately (`parseLocalDate`,
 * date formatting, `addLocalDays`) moved to `core/shared/local-date.ts` when M3/M4
 * needed the same arithmetic; what stays here is the genuinely DST-aware part.
 *
 * DST is handled honestly: "next local midnight" is the first instant of the next
 * local calendar date, which is 23 or 25 hours away on a transition day, and — for
 * the rare zones whose clocks jump *at* midnight — the first instant that date
 * exists at all.
 */

const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    // `en-US` + h23 gives stable numeric parts; the locale never leaks to users.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(instant: Instant, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`local-time: missing ${type} part for ${timeZone}`);
    return Number(p.value);
  };
  // Some ICU builds render midnight as "24" under h23 for certain locales — normalise.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Throws for an unknown IANA name — M2 validates on write, but fail loudly here too. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    partsFormatter(timeZone);
  } catch {
    throw new Error(`local-time: unknown IANA timezone '${timeZone}'`);
  }
}

/** The user-local calendar date at `instant`. Now `core/shared/local-date.ts`. */
export function localDateOf(instant: Instant, timeZone: string): LocalDate {
  return localDateAt(instant, timeZone);
}

/** UTC offset in milliseconds in force at `instant` (positive east of Greenwich). */
export function offsetMsAt(instant: Instant, timeZone: string): number {
  const w = wallClockAt(instant, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSecond = Math.floor(instant / 1000) * 1000;
  return asIfUtc - wholeSecond;
}

/** `localDate` + `days` as a calendar date (no timezone involved). Now shared. */
export function addLocalDays(localDate: LocalDate, days: number): LocalDate {
  return sharedAddLocalDays(localDate, days);
}

/**
 * The first instant of `localDate` in `timeZone` — normally local 00:00. If a DST
 * transition removes midnight itself, the first instant that date exists.
 */
export function localMidnightInstant(localDate: LocalDate, timeZone: string): Instant {
  const { year, month, day } = parseLocalDate(localDate);
  const guess = Date.UTC(year, month - 1, day); // wall-time 00:00 read as if UTC
  // The offset in force just before / just after midnight may differ (a transition
  // at or near midnight). Evaluate both candidates and keep the earliest one that
  // actually lands on the requested local date.
  const offsetA = offsetMsAt(guess, timeZone);
  const candidateA = guess - offsetA;
  const offsetB = offsetMsAt(candidateA, timeZone);
  const candidateB = guess - offsetB;
  const candidates = [candidateA, candidateB]
    .filter((c) => localDateOf(c, timeZone) === localDate)
    .sort((a, b) => a - b);
  const first = candidates[0];
  if (first !== undefined) return first;
  // Degenerate case (midnight sits inside a DST gap and neither candidate lands on
  // the date): scan forward from the earlier candidate in minute steps.
  const start = Math.min(candidateA, candidateB) - DAY_MS;
  for (let t = start; t < start + 3 * DAY_MS; t += 60_000) {
    if (localDateOf(t, timeZone) === localDate) return t;
  }
  throw new Error(`local-time: could not locate ${localDate} in ${timeZone}`);
}

/** The first instant of the local day *after* the one containing `instant`. */
export function nextLocalMidnight(instant: Instant, timeZone: string): Instant {
  const today = localDateOf(instant, timeZone);
  return localMidnightInstant(addLocalDays(today, 1), timeZone);
}

const timeLabelCache = new Map<string, Intl.DateTimeFormat>();

/** A short user-facing wall-clock label, e.g. `12:00 am`, in the user's timezone. */
export function formatLocalTime(instant: Instant, timeZone: string): string {
  let f = timeLabelCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    timeLabelCache.set(timeZone, f);
  }
  // Normalise the narrow no-break space some ICU versions insert before am/pm.
  return f.format(new Date(instant)).replace(/ | /g, ' ');
}
