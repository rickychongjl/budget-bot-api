import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { appUser } from './identity';

/**
 * M6 — NLP Parsing & Merchant Memory owns this file.
 *
 * Tables: `merchant_category_mapping`.
 *
 * Not in M1 §2's file list (M1 build-log, open question 1) — M6 adds it here plus the
 * one barrel line in `index.ts`.
 *
 * Conventions: see `identity.ts` header. Specifics from M6's plan ("Merchant memory"):
 *   - `unique (user_id, normalized_merchant)` — one mapping per user per merchant key.
 *   - `source text check (source in ('user_confirmed','user_corrected'))`. There is
 *     deliberately no `'llm_guess'` value: a row exists only after explicit user
 *     confirmation or correction (M6 invariant), enforced again in the pipeline.
 *   - `category_id` -> M3's `category(id)`. Declared here WITHOUT a Drizzle-level
 *     reference because `category` is M3's Phase 2 table and does not exist yet;
 *     M3 adds `on delete cascade` (a mapping to a removed category is meaningless)
 *     when its migration lands — flagged in the M6 build-log.
 *   - `times_used` / `last_used_at` are bumped on every mapping hit so the
 *     merchant-mapping hit rate is measurable later (M9, deferred metrics).
 *
 * MERGE ORDER: same `appUser` dependency as `observability.ts` — see that header.
 */
export const merchantCategoryMapping = pgTable(
  'merchant_category_mapping',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    normalizedMerchant: text('normalized_merchant').notNull(),
    displayMerchant: text('display_merchant').notNull(),
    categoryId: uuid('category_id').notNull(),
    source: text('source').notNull(),
    timesUsed: integer('times_used').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('merchant_category_mapping_user_merchant').on(t.userId, t.normalizedMerchant),
    check(
      'merchant_category_mapping_source_check',
      sql`${t.source} in ('user_confirmed','user_corrected')`,
    ),
    index('merchant_category_mapping_user').on(t.userId),
  ],
);

export type MerchantCategoryMappingRow = typeof merchantCategoryMapping.$inferSelect;
export type NewMerchantCategoryMappingRow = typeof merchantCategoryMapping.$inferInsert;
