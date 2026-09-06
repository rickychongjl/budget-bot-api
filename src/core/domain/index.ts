/**
 * `core/domain` — pure logic only (M1 §2, master plan §6 rule 3). An injected `Clock`,
 * no `Date.now()`, no DB handle. This is what makes period/allowance maths
 * unit-testable at arbitrary instants and across DST transitions.
 *
 * All stubs this pass; M3/M4/M5 fill them in.
 */
export * from './money';
export * from './period';
export * from './allowance';
