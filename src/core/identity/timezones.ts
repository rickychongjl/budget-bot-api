/**
 * Onboarding step 1's picker data (M2 "Onboarding", resolved round 3): a curated short
 * list of Australian IANA zones as buttons, **plus a full IANA search** for everything
 * else. Channel-agnostic — M7 turns options into inline buttons. Pure, no clock.
 */

export interface TimezoneOption {
  /** Canonical IANA id, e.g. `'Australia/Brisbane'`. */
  id: string;
  /** Human label, e.g. `'Brisbane'`. */
  label: string;
}

/**
 * The curated AU list. Canonical zone ids only (no backward links like
 * `Australia/Canberra`) so every id here also appears in `Intl.supportedValuesOf`.
 */
export const CURATED_AU_TIMEZONES: readonly TimezoneOption[] = [
  { id: 'Australia/Sydney', label: 'Sydney' },
  { id: 'Australia/Melbourne', label: 'Melbourne' },
  { id: 'Australia/Brisbane', label: 'Brisbane' },
  { id: 'Australia/Perth', label: 'Perth' },
  { id: 'Australia/Adelaide', label: 'Adelaide' },
  { id: 'Australia/Hobart', label: 'Hobart' },
  { id: 'Australia/Darwin', label: 'Darwin' },
];

export const TIMEZONE_SEARCH_LIMIT = 8;

/** Every zone the runtime knows; falls back to the curated list if `Intl` lacks the API. */
export function allTimezones(): readonly string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      return intl.supportedValuesOf('timeZone');
    } catch {
      // fall through
    }
  }
  return CURATED_AU_TIMEZONES.map((z) => z.id);
}

export function labelFor(zoneId: string): string {
  const city = zoneId.split('/').pop() ?? zoneId;
  return city.replace(/_/g, ' ');
}

/**
 * Case-insensitive substring search over the full IANA list. Matches on the city part
 * rank above matches on the region part (`"syd"` → Sydney before anything under
 * `Asia/`), then alphabetical. Returns at most `limit` options; empty query → none.
 */
export function searchTimezones(
  query: string,
  limit: number = TIMEZONE_SEARCH_LIMIT,
): readonly TimezoneOption[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_');
  if (needle === '') return [];

  const ranked: { id: string; rank: number }[] = [];
  for (const id of allTimezones()) {
    const lower = id.toLowerCase();
    const city = lower.split('/').pop() ?? lower;
    let rank: number;
    if (city.startsWith(needle)) rank = 0;
    else if (city.includes(needle)) rank = 1;
    else if (lower.includes(needle)) rank = 2;
    else continue;
    ranked.push({ id, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return ranked.slice(0, limit).map(({ id }) => ({ id, label: labelFor(id) }));
}
