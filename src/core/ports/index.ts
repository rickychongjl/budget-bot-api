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
 *   EntitlementService     M8   docs/M8-entitlements-limits.md
 *   MessageSender /        M7   docs/M7-telegram-gateway.md
 *     InboundMessage
 *   LlmParser              M6   provider-neutral, privacy-constrained
 *   Clock                  M1   injectable time source
 *
 * Added in Phase 1 by M2 (each file's header says why; build-log has the full note):
 *   CategoryService              M3-owned  category create/list/rename/archive — absent from LedgerService
 *   ReminderSelectionService     M5-owned  which categories carry the 07:00 reminder
 *   ChannelConnectionDirectory   M2-owned  fetch/deactivate a connection (M7's 403 path)
 */
export * from './common';
export * from './clock';
export * from './identity-service';
export * from './ledger-service';
export * from './budget-service';
export * from './daily-allowance-service';
export * from './entitlement-service';
export * from './messaging';
export * from './llm-parser';
export * from './category-service';
export * from './reminder-selection-service';
export * from './channel-connection-directory';
