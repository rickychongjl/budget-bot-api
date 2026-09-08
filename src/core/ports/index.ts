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
 * What's left is the one contract M2 proposed but doesn't own (the file's header says
 * why; build-log has the full note):
 *   ReminderSelectionService     M5-owned  which categories carry the 07:00 reminder
 * It stays here — not dropped into M5's still-`export {}` stub folder — until M5
 * claims it as part of its own PR.
 *
 * `CategoryService` was the other one. M3 claimed it in the Phase 2 PR, so it now
 * lives in `core/ledger/category-service.ts` with the module that owns the `category`
 * table; import it from `core/ledger`.
 */
export * from './reminder-selection-service';
