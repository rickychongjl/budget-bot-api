/**
 * M3 — Categories & Ledger (Phase 2, coordinated with M4). The module's public surface.
 *
 * `ledger-service.ts` and `category-service.ts` hold the incoming ports other modules
 * import; `default-ledger-service.ts` and `default-category-service.ts` implement them
 * against `infrastructure/database/schema/category.ts` +
 * `infrastructure/database/schema/transaction.ts`. `ledger-repository.ts` is the
 * outgoing port — its Drizzle implementation lives in
 * `infrastructure/database/repositories/drizzle-ledger-repository.ts` and is
 * deliberately **not** re-exported here; core must not depend on infrastructure.
 *
 * `exportCsv` is deferred this pass (round 5, Story 7): the signature stays on
 * `LedgerService` so M7 has something to stub `/export` against, and the
 * implementation refuses with `NOT_YET_AVAILABLE`.
 *
 * Wiring (composition root):
 *   const ledgerRepository = new DrizzleLedgerRepository(db);
 *   const settingsOf = (userId) => identity.getSettings(userId);
 *   const categories = new DefaultCategoryService({
 *     repository: ledgerRepository, entitlements, budgets, settingsOf, clock,
 *   });
 *   const ledger = new DefaultLedgerService({
 *     repository: ledgerRepository, periods: budgets, settingsOf, clock,
 *   });
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

export type { Category, CategoryService } from './category-service';

export type {
  AllowanceNotifier,
  CategoryCapacityGate,
  LedgerCorrectionNotifier,
  LedgerSettingsReader,
  LedgerUserSettings,
} from './collaborators';

export type {
  CategoryPatch,
  HistoryCursor,
  LedgerReads,
  LedgerRepository,
  LedgerWrites,
  NewCategoryInput,
  NewTransactionInput,
  StoredTransactionPatch,
} from './ledger-repository';
export { DuplicateCategoryNameError } from './ledger-repository';

export { DefaultLedgerService } from './default-ledger-service';
export type { LedgerServiceDeps } from './default-ledger-service';

export { DefaultCategoryService } from './default-category-service';
export type { CategoryServiceDeps } from './default-category-service';

export {
  MAX_CATEGORY_NAME_LENGTH,
  normalizeCategoryName,
  toCategoryDisplayName,
} from './category-name';

export {
  assertAmount,
  assertCurrency,
  assertOccurredOn,
  assertRecordable,
} from './transaction-validation';
export type { TransactionRules } from './transaction-validation';
