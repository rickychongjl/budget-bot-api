import type { Clock } from '../core/shared/clock';
import type { LogFields, Logger } from './log';

/**
 * Stage timing for the inbound request lifecycle — the "where did the 6–12 seconds
 * go?" instrumentation (M9's observability surface, kept to what M9 permits).
 *
 * It is deliberately built on the two things every layer already has: the injected
 * `Clock` (CLAUDE.md — never `Date.now()` in business code, so a `TestClock` makes the
 * numbers deterministic) and the `Logger` port. It adds no new logging mechanism and
 * no state that outlives one call.
 *
 * **What may be measured is not the same as what may be logged.** A timing field is a
 * number; the fields accompanying it must stay to stage names and booleans. Message
 * text, category or merchant names, chat ids and secrets are forbidden here exactly as
 * everywhere else (M9 "Logs never contain…"), and the `ms` field is the only thing
 * these helpers add on their own.
 *
 * Every line is one event name plus a handful of primitives, because this runs on
 * every message in production, permanently.
 */

/** The field name every timing line uses, so a tail can be grepped on one token. */
export const DURATION_FIELD = 'ms';

/**
 * Starts a stopwatch against an injected clock and returns "how long since then, in
 * whole milliseconds". Never negative — a clock that steps backwards (or a `TestClock`
 * a test rewinds) reports 0 rather than a nonsense duration.
 */
export function startTimer(clock: Clock): () => number {
  const startedAt = clock.now();
  return () => Math.max(0, clock.now() - startedAt);
}

/**
 * Runs `work`, then logs `event` with its duration. The timing is recorded in a
 * `finally`, so a stage that throws is still measured — a slow failure is exactly the
 * kind this exists to find — and the error itself propagates untouched.
 *
 * `fields` is merged first so `ms` is always present and always a number, whatever the
 * caller passes.
 */
export async function timed<T>(
  logger: Logger,
  clock: Clock,
  event: string,
  work: () => Promise<T>,
  fields: LogFields = {},
): Promise<T> {
  const elapsed = startTimer(clock);
  try {
    return await work();
  } finally {
    logger.log('info', event, { ...fields, [DURATION_FIELD]: elapsed() });
  }
}
