import type { PeriodMaterialiser } from '../budgets';
import type { Clock } from '../shared/clock';
import type { Id, LocalDate, MinorUnits, UserId } from '../shared/common';
import { RefusalError } from '../shared/errors';
import { localDateAt } from '../shared/local-date';
import type { AllowanceNotifier, LedgerSettingsReader } from './collaborators';
import type { HistoryCursor, LedgerRepository, StoredTransactionPatch } from './ledger-repository';
import type {
  LedgerService,
  Page,
  PageRequest,
  Transaction,
  TransactionPatch,
  ValidatedCandidate,
} from './ledger-service';
import { assertRecordable } from './transaction-validation';

export interface LedgerServiceDeps<X> {
  repository: LedgerRepository<X>;
  /** M4 — materialises the transaction's period inside M3's own write transaction. */
  periods: PeriodMaterialiser<X>;
  /** M2's `IdentityService.getSettings`. */
  settingsOf: LedgerSettingsReader;
  clock: Clock;
  /** M5 — omitted until Phase 3 lands. */
  allowance?: AllowanceNotifier;
}

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;

/**
 * M3 — the system of record for what the user spent. Every confirmed transaction
 * enters through here; nothing else writes the ledger.
 *
 * The two reads M5 depends on, `spendInPeriod` and `spentOn`, return
 * `expenses - refunds` and exclude `income` **by construction** rather than by the
 * caller remembering to filter. Salary landing on payday must never inflate a
 * groceries cap on exactly the day the allowance figure matters most, and a caller
 * cannot opt out of that here.
 *
 * `X` is the repository's executor type — the seam that lets a ledger insert and M4's
 * period materialisation commit as one database transaction.
 */
export class DefaultLedgerService<X> implements LedgerService {
  private readonly repository: LedgerRepository<X>;
  private readonly periods: PeriodMaterialiser<X>;
  private readonly settingsOf: LedgerSettingsReader;
  private readonly clock: Clock;
  private readonly allowance: AllowanceNotifier | undefined;

  constructor(deps: LedgerServiceDeps<X>) {
    this.repository = deps.repository;
    this.periods = deps.periods;
    this.settingsOf = deps.settingsOf;
    this.clock = deps.clock;
    this.allowance = deps.allowance;
  }

  // ---- write ---------------------------------------------------------------------

  /**
   * M3 checklist step 2, in order:
   *   a. `occurred_on` is derived from `occurred_at` and the user's timezone, once,
   *      here at write time. The candidate carries its own copy (M6 computed it from
   *      a date expression like "yesterday"), but this module re-derives rather than
   *      trusts — M6 sets `occurred_at` to local noon of the date it resolved, so the
   *      two agree, and if they ever stop agreeing the timezone is the authority.
   *   b–d. Period resolution and the insert happen in **one** database transaction, so
   *      a ledger row that no period owns is never visible to a budget query.
   *   e. M5 is told to recalculate `available_today` — after the commit, and never in
   *      a way that can fail the user's write.
   *
   * The category must already exist: a new one is created only through
   * `CategoryService.create` after the user explicitly confirmed the name, never
   * invented silently here (M3 checklist step 2c).
   */
  async record(userId: UserId, candidate: ValidatedCandidate): Promise<Transaction> {
    const settings = await this.settingsOf(userId);
    const now = this.clock.now();
    const occurredOn = localDateAt(candidate.occurredAt, settings.timezone);

    assertRecordable(candidate.amountMinorUnits, candidate.currencyCode, occurredOn, {
      currencyCode: settings.currencyCode,
      accountCreatedOn: settings.accountCreatedOn,
      today: localDateAt(now, settings.timezone),
    });

    if (candidate.categoryId === null && candidate.newCategoryName !== undefined) {
      throw new RefusalError(
        'CATEGORY_NOT_FOUND',
        'That category needs to be created first — confirm the new name and I will add it.',
      );
    }
    const categoryId = candidate.categoryId;
    if (categoryId !== null && (await this.repository.findCategory(userId, categoryId)) === null) {
      throw new RefusalError('CATEGORY_NOT_FOUND', "You don't have a category like that.");
    }

    const recorded = await this.repository.runInTransaction(async (tx) => {
      const period =
        categoryId === null
          ? null
          : await this.periods.ensurePeriodForCategory(userId, categoryId, occurredOn, tx.executor);

      return tx.insertTransaction({
        userId,
        categoryId,
        budgetPeriodId: period?.id ?? null,
        direction: candidate.direction,
        amountMinorUnits: candidate.amountMinorUnits,
        currencyCode: candidate.currencyCode.toUpperCase(),
        occurredOn,
        occurredAt: candidate.occurredAt,
        merchantDisplay: candidate.merchantDisplay ?? null,
        normalizedMerchant: candidate.normalizedMerchant ?? null,
        note: candidate.note ?? null,
        rawText: candidate.rawText,
        parseRoute: candidate.parseRoute,
        parseConfidence: candidate.parseConfidence ?? null,
        now,
      });
    });

    await this.notifyAllowance(userId, recorded.occurredOn);
    return recorded;
  }

  /**
   * A correction can move the transaction's date or category, either of which changes
   * which period it belongs to — so the period is re-resolved in the same transaction
   * as the update, exactly like `record` does.
   */
  async correct(userId: UserId, transactionId: Id, patch: TransactionPatch): Promise<Transaction> {
    const existing = await this.requireTransaction(userId, transactionId);
    const settings = await this.settingsOf(userId);
    const now = this.clock.now();

    const occurredOn = patch.occurredOn ?? existing.occurredOn;
    const amount = patch.amountMinorUnits ?? existing.amountMinorUnits;
    assertRecordable(amount, existing.currencyCode, occurredOn, {
      currencyCode: settings.currencyCode,
      accountCreatedOn: settings.accountCreatedOn,
      today: localDateAt(now, settings.timezone),
    });

    const categoryId = patch.categoryId === undefined ? existing.categoryId : patch.categoryId;
    if (categoryId !== null && (await this.repository.findCategory(userId, categoryId)) === null) {
      throw new RefusalError('CATEGORY_NOT_FOUND', "You don't have a category like that.");
    }

    const stored: StoredTransactionPatch = { ...patch, occurredOn };
    // `occurred_at` follows a moved date so the two never disagree; local noon is the
    // same convention M6 uses when it resolves a backdated date expression.
    if (patch.occurredOn !== undefined && patch.occurredOn !== existing.occurredOn) {
      stored.occurredAt = localNoonInstant(patch.occurredOn, settings.timezone);
    }

    const updated = await this.repository.runInTransaction(async (tx) => {
      const period =
        categoryId === null
          ? null
          : await this.periods.ensurePeriodForCategory(userId, categoryId, occurredOn, tx.executor);
      return tx.updateTransaction(userId, transactionId, { ...stored, budgetPeriodId: period?.id ?? null }, now);
    });
    if (!updated) throw transactionNotFound();

    // Both the old and the new date need recomputing when a correction moves one.
    await this.notifyAllowance(userId, existing.occurredOn);
    if (updated.occurredOn !== existing.occurredOn) await this.notifyAllowance(userId, updated.occurredOn);
    return updated;
  }

  /** Soft delete — the row is kept forever for now (M3 open decisions, retention is M9's). */
  async softDelete(userId: UserId, transactionId: Id): Promise<void> {
    const existing = await this.requireTransaction(userId, transactionId);
    const deleted = await this.repository.markTransactionDeleted(userId, transactionId, this.clock.now());
    if (!deleted) throw transactionNotFound();
    await this.notifyAllowance(userId, existing.occurredOn);
  }

  /**
   * `/delete` means "the one I just typed", so this picks by `created_at` — the most
   * recent *action* — not by `occurred_on`, the most recent date. Backdating an entry
   * makes those two disagree, and the user means the former.
   */
  async deleteLast(userId: UserId): Promise<Transaction | null> {
    const last = await this.repository.findLastTransaction(userId);
    if (!last) return null;
    await this.repository.markTransactionDeleted(userId, last.id, this.clock.now());
    await this.notifyAllowance(userId, last.occurredOn);
    return last;
  }

  // ---- read ----------------------------------------------------------------------

  /**
   * Newest first. Every query behind this is scoped to `userId` in the repository —
   * no code path can return another user's rows, which is the invariant M3 calls out
   * explicitly and the one `exportCsv` will inherit when it is eventually built.
   */
  async history(userId: UserId, page: PageRequest): Promise<Page<Transaction>> {
    const limit = Math.min(Math.max(1, page.limit || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const cursor = page.cursor === undefined ? null : decodeCursor(page.cursor);
    // One extra row is the cheapest way to know whether another page exists.
    const rows = await this.repository.listTransactions(userId, limit + 1, cursor);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * Deferred this pass (round 5, Story 7). The signature stays on the port so M7 has
   * something to stub `/export` against; when it is built it must stream (a Worker has
   * 128 MB), omit internal ids and `raw_text`, and scope strictly to `userId`.
   */
  exportCsv(_userId: UserId): Promise<ReadableStream> {
    return Promise.reject(
      new RefusalError('NOT_YET_AVAILABLE', 'CSV export is not available yet.'),
    );
  }

  spendInPeriod(userId: UserId, budgetPeriodId: Id, upTo?: LocalDate): Promise<MinorUnits> {
    return this.repository.sumInPeriod(userId, budgetPeriodId, upTo ?? null);
  }

  spentOn(userId: UserId, localDate: LocalDate): Promise<MinorUnits> {
    return this.repository.sumOnLocalDate(userId, localDate);
  }

  // ---- helpers -------------------------------------------------------------------

  private async requireTransaction(userId: UserId, transactionId: Id): Promise<Transaction> {
    const found = await this.repository.findTransaction(userId, transactionId);
    if (!found) throw transactionNotFound();
    return found;
  }

  /**
   * The ledger is the system of record; a reminder is a downstream effect. A failing
   * M5 must not roll back a transaction the user has already been told about, so this
   * never throws.
   */
  private async notifyAllowance(userId: UserId, localDate: LocalDate): Promise<void> {
    if (!this.allowance) return;
    try {
      await this.allowance.ledgerChanged(userId, localDate);
    } catch {
      // Swallowed deliberately — M5 recomputes on its own next read regardless.
    }
  }
}

function transactionNotFound(): RefusalError {
  return new RefusalError('RESOURCE_NOT_FOUND', "I can't find that transaction.");
}

/**
 * Noon rather than midnight: it is the furthest point from either DST boundary, so a
 * backdated date survives any transition without landing on the previous or next day.
 * Same convention as M6's `instantAtLocalNoon`.
 */
function localNoonInstant(localDate: LocalDate, timeZone: string): number {
  const guess = Date.parse(`${localDate}T12:00:00Z`);
  // Correct the guess by the offset actually in force there, then once more in case
  // the first correction crossed a transition.
  let instant = guess;
  for (let i = 0; i < 2; i++) {
    const seen = localDateAt(instant, timeZone);
    const drift = Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${seen}T00:00:00Z`);
    if (drift === 0) break;
    instant += drift;
  }
  return instant;
}

/**
 * Keyset pagination over `(occurred_on desc, created_at desc, id desc)` — the same
 * ordering `transaction_user_date` indexes. Opaque to callers; only M3 reads it.
 */
function encodeCursor(row: Transaction): string {
  return `${row.occurredOn}|${row.createdAt}|${row.id}`;
}

function decodeCursor(cursor: string): HistoryCursor {
  const [occurredOn, createdAt, id] = cursor.split('|');
  if (!occurredOn || !createdAt || !id || Number.isNaN(Number(createdAt))) {
    throw new RefusalError('INVALID_ARGUMENT', 'That page link is no longer valid.');
  }
  return { occurredOn, createdAt: Number(createdAt), id };
}
