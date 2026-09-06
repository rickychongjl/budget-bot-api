/**
 * M3 — Categories & Ledger (Phase 2, coordinated with M4).
 *
 * Implements `LedgerService` (`core/ports/ledger-service.ts`) against
 * `db/schema/category.ts` + `db/schema/transaction.ts`. Owns recording/correcting/
 * deleting transactions, category archive (gated on no-transactions-this-cycle),
 * money representation, history. `exportCsv` is deferred this pass.
 *
 * Empty until the M3 agent's PR.
 */
export {};
