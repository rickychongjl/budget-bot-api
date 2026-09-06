import type { CurrencyCode, Instant, LocalDate, LocalTime } from '../ports/common';
import { IdentityError } from './errors';

/**
 * Input validation for the four settings M2 owns. Pure — no clock, no DB.
 * Every rejection is `INVALID_ARGUMENT` so M7 can render "a precise correction with
 * no partial write" (M11 shared contract).
 */

const CURRENCY_RE = /^[A-Z]{3}$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** ISO 4217 alpha-3, upper-case. Well-formedness only — no allow-list in v1. */
export function validateCurrencyCode(value: unknown): CurrencyCode {
  if (typeof value !== 'string' || !CURRENCY_RE.test(value)) {
    throw new IdentityError(
      'INVALID_ARGUMENT',
      `currency must be a 3-letter ISO 4217 code like AUD, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** `YYYY-MM-DD`, and a real calendar date (no 2026-02-30). */
export function validateLocalDate(value: unknown): LocalDate {
  if (typeof value === 'string') {
    const match = LOCAL_DATE_RE.exec(value);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const probe = new Date(Date.UTC(year, month - 1, day));
      if (
        probe.getUTCFullYear() === year &&
        probe.getUTCMonth() === month - 1 &&
        probe.getUTCDate() === day
      ) {
        return value;
      }
    }
  }
  throw new IdentityError(
    'INVALID_ARGUMENT',
    `date must be a real calendar date formatted YYYY-MM-DD, got ${JSON.stringify(value)}`,
  );
}

/** `HH:MM`, 24-hour. Accepts Postgres' `HH:MM:SS` on read and normalises it. */
export function validateLocalTime(value: unknown): LocalTime {
  if (typeof value === 'string') {
    const candidate = value.length === 8 && value.endsWith(':00') ? value.slice(0, 5) : value;
    if (LOCAL_TIME_RE.test(candidate)) return candidate;
  }
  throw new IdentityError(
    'INVALID_ARGUMENT',
    `time must be HH:MM (24h), got ${JSON.stringify(value)}`,
  );
}

/**
 * Validates an IANA zone and returns its canonical spelling (`australia/brisbane` →
 * `Australia/Brisbane`) so the stored value — and the idempotent-replay comparison —
 * is always the canonical form. Uses the runtime's `Intl` tz database, which Workers
 * ship; there is no bundled zone list to go stale.
 */
export function validateTimezone(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    } catch {
      // fall through to the refusal
    }
  }
  throw new IdentityError(
    'INVALID_ARGUMENT',
    `timezone must be an IANA zone like Australia/Brisbane, got ${JSON.stringify(value)}`,
  );
}

/**
 * The user-local calendar date at `instant` in `timezone` — a `date` column value,
 * computed at write time from the injected clock (master plan §6). Not period maths
 * (that stays in M4's `periodFor`); this is only "what day is it for this user".
 */
export function localDateAt(instant: Instant, timezone: string): LocalDate {
  // en-CA renders as YYYY-MM-DD; parts are read explicitly so a locale change can't
  // silently reorder them.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
