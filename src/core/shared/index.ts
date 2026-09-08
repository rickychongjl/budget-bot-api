/**
 * `core/shared` — genuinely shared domain concepts, not a second dumping ground
 * (CLAUDE.md, "Shared domain code"). Feature-specific calculations belong with
 * their owning feature.
 *
 * `money.ts` qualifies: money is `bigint` minor units everywhere, and every module
 * that touches an amount needs the same conversion and the same scale rules.
 *
 * `local-date.ts` qualifies for the same reason: M2 derives an onboarding date, M8
 * anchors the daily quota, M3 stamps `occurred_on`, M4 derives period bounds. It
 * absorbed the copies M2's `timezones.ts` and M8's `local-time.ts` each kept
 * privately; both now delegate to it under their existing export names.
 *
 * `common.ts` and `clock.ts` are imported directly by path from every module rather
 * than through this barrel — see `docs/build-log.md`.
 */
export * from './money';
export * from './local-date';
export * from './errors';
