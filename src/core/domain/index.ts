/**
 * `core/domain` — pure logic only (M1 §2, master plan §6 rule 3). An injected `Clock`,
 * no `Date.now()`, no DB handle. This is what makes period/allowance maths
 * unit-testable at arbitrary instants and across DST transitions.
 *
 * `money`/`period`/`allowance` are stubs until M3/M4/M5 land. `timezone` and `refusal`
 * are real (M2).
 */
export * from './money';
export * from './period';
export * from './allowance';
export * from './timezone';
export * from './refusal';
