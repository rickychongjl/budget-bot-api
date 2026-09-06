/**
 * `core/domain` — pure logic only (M1 §2, master plan §6 rule 3). An injected `Clock`,
 * no `Date.now()`, no DB handle. This is what makes period/allowance maths
 * unit-testable at arbitrary instants and across DST transitions.
 *
 * `money`/`period`/`allowance` are stubs until M3/M4/M5 land.
 *
 * M2's former residents here (`timezone.ts`, `refusal.ts`) moved to their owning
 * feature — `core/identity/timezones.ts` and `core/identity/errors.ts` — per
 * CLAUDE.md ("Do not use `core/domain` as a general dumping ground"). The remaining
 * files belong to M3/M4/M5 and should follow the same way when those modules land.
 */
export * from './money';
export * from './period';
export * from './allowance';
