import type { Id, Instant, LocalDate, MinorUnits, UserId } from '../../src/core/ports/common';
import type {
  LedgerService,
  Page,
  PageRequest,
  Transaction,
  TransactionPatch,
  ValidatedCandidate,
} from '../../src/core/ports/ledger-service';
import { fakeId } from './fake-id';

/** Records what M6 hands M3; `record` returns a plausible `Transaction`. */
export class RecordingLedgerService implements LedgerService {
  readonly recorded: { userId: UserId; candidate: ValidatedCandidate }[] = [];
  constructor(private readonly now: () => Instant) {}

  async record(userId: UserId, candidate: ValidatedCandidate): Promise<Transaction> {
    this.recorded.push({ userId, candidate });
    const at = this.now();
    return {
      id: fakeId('tx'),
      userId,
      categoryId: candidate.categoryId,
      budgetPeriodId: null,
      direction: candidate.direction,
      amountMinorUnits: candidate.amountMinorUnits,
      currencyCode: candidate.currencyCode,
      occurredOn: candidate.occurredOn,
      occurredAt: candidate.occurredAt,
      merchantDisplay: candidate.merchantDisplay ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      note: candidate.note ?? null,
      rawText: candidate.rawText,
      parseRoute: candidate.parseRoute,
      parseConfidence: candidate.parseConfidence ?? null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
  }
  correct(_userId: UserId, _transactionId: Id, _patch: TransactionPatch): Promise<Transaction> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
  softDelete(): Promise<void> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
  deleteLast(): Promise<Transaction | null> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
  history(_userId: UserId, _page: PageRequest): Promise<Page<Transaction>> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
  exportCsv(): Promise<ReadableStream> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
  spendInPeriod(): Promise<MinorUnits> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
  spentOn(_userId: UserId, _localDate: LocalDate): Promise<MinorUnits> {
    return Promise.reject(new Error('not implemented (M3)'));
  }
}
