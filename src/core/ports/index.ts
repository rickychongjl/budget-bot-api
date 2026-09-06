/**
 * `core/ports` — a deliberately temporary holding pen, not the coordination
 * mechanism it once was (M1 §3).
 *
 * The platform-wide refactor that dissolved the global `core/ports`/`core/domain`
 * dumping grounds (see `docs/build-log.md`) moved every M1-committed port into its
 * owning module: `LedgerService` → `core/ledger`, `BudgetService` → `core/budgets`,
 * `DailyAllowanceService` → `core/allowance`, `EntitlementService` →
 * `core/entitlements`, `MessageSender`/`InboundMessage` → `core/shared/messaging`,
 * `LlmParser` → `parsing`, `Clock`/shared primitives → `core/shared`. `IdentityService`
 * / `ChannelConnectionDirectory` (M2's own) already live in `core/identity`.
 *
 * What's left is the two contracts M2 proposed but doesn't own (each file's header
 * says why; build-log has the full note):
 *   CategoryService              M3-owned  category create/list/rename/archive — absent from LedgerService
 *   ReminderSelectionService     M5-owned  which categories carry the 07:00 reminder
 * They stay here — not dropped into another module's still-`export {}` stub folder —
 * until M3/M5 claim them as part of their own PRs.
 */
export * from './category-service';
export * from './reminder-selection-service';
