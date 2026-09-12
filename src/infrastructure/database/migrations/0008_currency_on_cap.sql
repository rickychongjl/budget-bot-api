-- M4 (12 Sep 2026): `currency_code` moves from `budget` to `category_period_cap`, beside
-- the amount it denominates — the precedent M3 set with `transaction.currency_code`.
-- `budget` now says only "this category is budgeted". See `schema/budget.ts`.
--
-- drizzle-kit's output is `ADD COLUMN … NOT NULL` then `DROP COLUMN`, which fails on a
-- table with rows in it. Reordered by hand: add the column nullable, backfill it from
-- the column being dropped while that still exists, then tighten and drop.
--
-- Backfill: each cap row takes its category's budget currency — the active budget's
-- where there is one (`setCap` refreshed it on every write), otherwise the most
-- recently updated removed one's — and the account currency as a last resort for a
-- row with no budget at all. None should exist: every cap row is written after an
-- upsert of its budget, and both cascade when the category goes.
ALTER TABLE "category_period_cap" ADD COLUMN "currency_code" char(3);--> statement-breakpoint
UPDATE "category_period_cap" c
SET "currency_code" = COALESCE(
  (SELECT b."currency_code" FROM "budget" b
   WHERE b."category_id" = c."category_id"
   ORDER BY b."is_active" DESC, b."updated_at" DESC
   LIMIT 1),
  (SELECT u."currency_code" FROM "app_user" u WHERE u."id" = c."user_id")
);--> statement-breakpoint
ALTER TABLE "category_period_cap" ALTER COLUMN "currency_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "budget" DROP COLUMN "currency_code";
