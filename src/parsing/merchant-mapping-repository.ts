import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Id, Instant, UserId } from '../core/ports/common';
import { merchantCategoryMapping } from '../db/schema/merchant';
import type { MerchantMapping, MerchantMappingSource } from './types';

/**
 * Stage 4 (M6 "End-to-end flow"): merchant memory. The repository is the ONLY
 * writer of `merchant_category_mapping`, and its write method is named for the one
 * situation that may call it — after the user explicitly confirmed or corrected a
 * category. There is no `upsertFromLlm`; the pipeline cannot express that intent.
 */
export interface ConfirmedMapping {
  userId: UserId;
  normalizedMerchant: string;
  displayMerchant: string;
  categoryId: Id;
  source: MerchantMappingSource;
}

export interface IMerchantMappingRepository {
  /** Exact match on `(user_id, normalized_merchant)` — no fuzzy matching in v1. */
  find(userId: UserId, normalizedMerchant: string): Promise<MerchantMapping | null>;

  /**
   * Insert or update a mapping the user has explicitly confirmed/corrected.
   * On conflict the category, display name and source are replaced (`user_corrected`
   * wins over an older `user_confirmed`), `times_used` is kept.
   */
  saveConfirmed(mapping: ConfirmedMapping, now: Instant): Promise<MerchantMapping>;

  /** Bump `times_used` / `last_used_at` after a mapping hit was used to record. */
  touch(id: Id, now: Instant): Promise<void>;

  remove(userId: UserId, normalizedMerchant: string): Promise<void>;
}

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export class DrizzleMerchantMappingRepository implements IMerchantMappingRepository {
  constructor(private readonly db: Db) {}

  async find(userId: UserId, normalizedMerchant: string): Promise<MerchantMapping | null> {
    if (normalizedMerchant.length === 0) return null;
    const rows = await this.db
      .select()
      .from(merchantCategoryMapping)
      .where(
        and(
          eq(merchantCategoryMapping.userId, userId),
          eq(merchantCategoryMapping.normalizedMerchant, normalizedMerchant),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toMapping(row);
  }

  async saveConfirmed(mapping: ConfirmedMapping, now: Instant): Promise<MerchantMapping> {
    const at = new Date(now);
    const rows = await this.db
      .insert(merchantCategoryMapping)
      .values({
        userId: mapping.userId,
        normalizedMerchant: mapping.normalizedMerchant,
        displayMerchant: mapping.displayMerchant,
        categoryId: mapping.categoryId,
        source: mapping.source,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [merchantCategoryMapping.userId, merchantCategoryMapping.normalizedMerchant],
        set: {
          displayMerchant: mapping.displayMerchant,
          categoryId: mapping.categoryId,
          source: mapping.source,
          updatedAt: at,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('merchant mapping upsert returned no row');
    return toMapping(row);
  }

  async touch(id: Id, now: Instant): Promise<void> {
    await this.db
      .update(merchantCategoryMapping)
      .set({ timesUsed: sql`${merchantCategoryMapping.timesUsed} + 1`, lastUsedAt: new Date(now) })
      .where(eq(merchantCategoryMapping.id, id));
  }

  async remove(userId: UserId, normalizedMerchant: string): Promise<void> {
    await this.db
      .delete(merchantCategoryMapping)
      .where(
        and(
          eq(merchantCategoryMapping.userId, userId),
          eq(merchantCategoryMapping.normalizedMerchant, normalizedMerchant),
        ),
      );
  }
}

function toMapping(row: typeof merchantCategoryMapping.$inferSelect): MerchantMapping {
  return {
    id: row.id,
    userId: row.userId,
    normalizedMerchant: row.normalizedMerchant,
    displayMerchant: row.displayMerchant,
    categoryId: row.categoryId,
    source: row.source as MerchantMappingSource,
    timesUsed: row.timesUsed,
  };
}
