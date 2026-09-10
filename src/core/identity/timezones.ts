import type { Instant, LocalDate, LocalTime } from '../shared/common';
import { isLocalDate as isSharedLocalDate, localDateAt as sharedLocalDateAt } from '../shared/local-date';

/**
 * Pure timezone helpers owned by M2 (onboarding step 1, and the "local date derived at
 * write time" rule every module follows — master plan §6). No `Date.now()`, no DB;
 * callers pass an `Instant` from an injected `Clock`.
 *
 * Other modules should import these through the `core/identity` barrel. `localDateAt`
 * and `isLocalDate` were the candidates this file flagged for `core/shared` — M3 and
 * M4 are the modules that needed them, so they now live in
 * `core/shared/local-date.ts` and are re-exported here under their original names so
 * M2's public surface is unchanged.
 *
 * Backed by the runtime's IANA database via `Intl` — available in both Workers (V8)
 * and Node ≥ 18 without a dependency.
 */

/**
 * The curated short list offered as buttons at onboarding step 1 (M2 §Onboarding,
 * "curated AU list + IANA search"). Order is roughly by population so the common
 * answer is near the top.
 */
export const CURATED_AU_TIMEZONES: readonly string[] = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Perth',
  'Australia/Adelaide',
  'Australia/Hobart',
  'Australia/Darwin',
];

let cachedZones: readonly string[] | undefined;

/** Every canonical IANA zone the runtime knows. Cached — the list is static per process. */
export function allTimezones(): readonly string[] {
  if (!cachedZones) {
    // `Intl.supportedValuesOf` returns canonical names only; 'UTC' is included.
    const zones = new Set<string>(Intl.supportedValuesOf('timeZone'));
    zones.add('UTC');
    cachedZones = [...zones].sort();
  }
  return cachedZones;
}

/**
 * Returns the canonical spelling of `input` if it names a zone the runtime supports,
 * else `null`. Case-insensitive so a typed `australia/perth` still resolves; the
 * stored value is always canonical.
 */
export function canonicalTimezone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  for (const zone of allTimezones()) {
    if (zone.toLowerCase() === lower) return zone;
  }
  return null;
}

export function isValidTimezone(input: string): boolean {
  return canonicalTimezone(input) !== null;
}

/**
 * IANA search for onboarding step 1 — "an actual search, not just a fallback".
 * Case-insensitive substring match on the zone name with `_`/`/` treated as spaces, so
 * `new york`, `New_York` and `america/new` all find `America/New_York`. Results are
 * ordered: exact city match first, then prefix matches, then the rest, alphabetical
 * within each band. Capped at `limit` so the caller can render buttons.
 */
export function searchTimezones(query: string, limit = 8): readonly string[] {
  const q = normalise(query);
  if (q === '') return [];
  const exact: string[] = [];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const zone of allTimezones()) {
    const full = normalise(zone);
    const city = full.slice(full.lastIndexOf('/') + 1);
    if (city === q) exact.push(zone);
    else if (city.startsWith(q) || full.startsWith(q)) prefix.push(zone);
    else if (full.includes(q)) contains.push(zone);
  }
  return [...exact, ...prefix, ...contains].slice(0, Math.max(0, limit));
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, ' ');
}

/**
 * The user-local calendar date (`YYYY-MM-DD`) at `instant` in `timeZone`. This is the
 * one derivation every module uses to fill a `date` column at write time (M1 §4).
 * Now `core/shared/local-date.ts`; kept here so M2's callers are unaffected.
 */
export function localDateAt(instant: Instant, timeZone: string): LocalDate {
  return sharedLocalDateAt(instant, timeZone);
}

/** The user-local wall-clock time (`HH:MM`, 24h) at `instant` in `timeZone`. */
export function localTimeAt(instant: Instant, timeZone: string): LocalTime {
  const parts = partsAt(instant, timeZone);
  // `hourCycle: 'h23'` — Intl would otherwise render midnight as '24' in some locales.
  return `${parts.hour}:${parts.minute}`;
}

function partsAt(instant: Instant, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: out['year'] ?? '0000',
    month: out['month'] ?? '00',
    day: out['day'] ?? '00',
    hour: out['hour'] ?? '00',
    minute: out['minute'] ?? '00',
  };
}

/**
 * True when `value` is a real calendar date in `YYYY-MM-DD` form (so `2026-02-30` is
 * rejected, not silently rolled into March). Now `core/shared/local-date.ts`.
 */
export function isLocalDate(value: string): value is LocalDate {
  return isSharedLocalDate(value);
}

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isLocalTime(value: string): value is LocalTime {
  return LOCAL_TIME_RE.test(value);
}
