/**
 * M3 — Categories & Ledger (Phase 2, coordinated with M4).
 *
 * Implements `LedgerService` (`./ledger-service.ts`) against
 * `infrastructure/database/schema/category.ts` +
 * `infrastructure/database/schema/transaction.ts`. Owns recording/correcting/
 * deleting transactions, category archive (gated on no-transactions-this-cycle),
 * money representation, history. `exportCsv` is deferred this pass.
 *
 * The contract below is fixed; `DefaultLedgerService` and the repository
 * implementation are empty until the M3 agent's PR.
 */
export type {
  LedgerService,
  Page,
  PageRequest,
  ParseRoute,
  Transaction,
  TransactionDirection,
  TransactionPatch,
  TransactionStatus,
  ValidatedCandidate,
} from './ledger-service';
