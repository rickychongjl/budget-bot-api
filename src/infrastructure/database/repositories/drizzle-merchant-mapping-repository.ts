import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Id, Instant, UserId } from '../../../core/ports/common';
import { merchantCategoryMapping } from '../../../db/schema/merchant';
import type { ConfirmedMapping, MerchantMappingRepository } from '../../../parsing/merchant-mapping-repository';
import type { MerchantMapping, MerchantMappingSource } from '../../../parsing/types';

/**
 * The Drizzle implementation of M6's merchant-memory port (CLAUDE.md: concrete
 * Drizzle repositories live under `infrastructure/database/repositories/`).
 *
 * Queries, conflict handling and row → domain mapping only. The business rule that
 * a mapping may exist only after an explicit user confirmation is enforced by the
 * pipeline and by the port's shape, not here.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export class DrizzleMerchantMappingRepository implements MerchantMappingRepository {
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

  async markUsed(id: Id, now: Instant): Promise<void> {
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
