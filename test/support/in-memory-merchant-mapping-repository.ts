import type { Id, UserId } from '../../src/core/shared/common';
import type { ConfirmedMapping, MerchantMappingRepository } from '../../src/parsing/merchant-mapping-repository';
import type { MerchantMapping } from '../../src/parsing/types';
import { fakeId } from './fake-id';

/**
 * A test adapter for M6's merchant-memory port. It records every save so a test can
 * assert the pipeline's side effects (in particular: that no mapping is written
 * without an explicit confirmation) rather than trusting return values.
 *
 * It proves nothing about Drizzle or Postgres — the unique constraint and the
 * `source` check are verified in `test/integration/parse-event-fk.test.ts`.
 */
export class InMemoryMerchantMappingRepository implements MerchantMappingRepository {
  readonly rows = new Map<string, MerchantMapping>();
  readonly saves: ConfirmedMapping[] = [];

  private key(userId: UserId, merchant: string): string {
    return `${userId} ${merchant}`;
  }

  /** Test setup only — mirrors a mapping the user confirmed in the past. */
  seed(mapping: Omit<MerchantMapping, 'id' | 'timesUsed'> & { timesUsed?: number }): MerchantMapping {
    const row: MerchantMapping = { id: fakeId('map'), timesUsed: 0, ...mapping };
    this.rows.set(this.key(row.userId, row.normalizedMerchant), row);
    return row;
  }

  async find(userId: UserId, normalizedMerchant: string): Promise<MerchantMapping | null> {
    if (normalizedMerchant.length === 0) return null;
    return this.rows.get(this.key(userId, normalizedMerchant)) ?? null;
  }

  async saveConfirmed(mapping: ConfirmedMapping): Promise<MerchantMapping> {
    this.saves.push(mapping);
    const k = this.key(mapping.userId, mapping.normalizedMerchant);
    const existing = this.rows.get(k);
    const row: MerchantMapping = {
      id: existing?.id ?? fakeId('map'),
      userId: mapping.userId,
      normalizedMerchant: mapping.normalizedMerchant,
      displayMerchant: mapping.displayMerchant,
      categoryId: mapping.categoryId,
      source: mapping.source,
      timesUsed: existing?.timesUsed ?? 0,
    };
    this.rows.set(k, row);
    return row;
  }

  async markUsed(id: Id): Promise<void> {
    for (const row of this.rows.values()) if (row.id === id) row.timesUsed += 1;
  }

  async remove(userId: UserId, normalizedMerchant: string): Promise<void> {
    this.rows.delete(this.key(userId, normalizedMerchant));
  }
}
