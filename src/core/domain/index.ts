/**
 * `core/domain` — pure logic only (M1 §2, master plan §6 rule 3). An injected `Clock`,
 * no `Date.now()`, no DB handle. This is what makes period/allowance maths
 * unit-testable at arbitrary instants and across DST transitions.
 *
 * All stubs this pass; M3/M4/M5 fill them in.
 *
 * `money.ts` moved to `core/shared/` — it is genuinely shared, not feature-specific
 * (CLAUDE.md, "Shared domain code"). Import it from `../shared/money`.
 */
export * from './period';
export * from './allowance';
