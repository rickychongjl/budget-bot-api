/**
 * `core/ports` — the coordination mechanism for the whole agent team (M1 §3).
 *
 * Every other module implements against an interface that is fixed from the first
 * commit, instead of inventing its own and reconciling later. Stub bodies elsewhere
 * may `throw new Error('not implemented')`; the point is that the compiler enforces
 * every contract now.
 *
 * Interfaces are lifted from each module's own page:
 *   IdentityService        M2   docs/M2-identity-accounts.md
 *   LedgerService          M3   docs/M3-categories-ledger.md
 *   BudgetService          M4   docs/M4-budgets-periods.md
 *   DailyAllowanceService  M5   docs/M5-daily-allowance-scheduler.md (per-category revision)
 *   EntitlementService     M8   now owned by its module: core/entitlements/entitlement-service.ts
 *   MessageSender /        M7   docs/M7-telegram-gateway.md
 *     InboundMessage
 *   LlmParser              M6   provider-neutral, privacy-constrained
 *   Clock                  M1   injectable time source
 */
export * from './common';
export * from './clock';
export * from './identity-service';
export * from './ledger-service';
export * from './budget-service';
export * from './daily-allowance-service';
export * from './messaging';
export * from './llm-parser';
