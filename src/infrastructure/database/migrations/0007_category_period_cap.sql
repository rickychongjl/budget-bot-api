-- M4 (12 Sep 2026): the cap moves out of `budget` and `budget_period` into a history
-- table keyed by category and cycle. A cycle's cap is the row with the greatest
-- `period_key` at or before it. See `schema/budget.ts` and `docs/M4-budgets-periods.md`.
--
-- The CREATE / ALTER statements are drizzle-kit's output, reordered so the three
-- hand-written backfill INSERTs run while the old columns still exist. The backfill
-- is what makes this forward-only migration safe on a database with rows in it:
--   1. every materialised cycle's snapshot becomes that cycle's row (exact history);
--   2. a removed budget writes a null row for the cycle it was removed in;
--   3. an active budget's standing cap becomes the row for the cycle it was last set
--      in, overriding that cycle's snapshot — the same thing `setCap` does live.
-- Period keys are derived exactly as `core/budgets/period.ts` derives them: the
-- anchor day capped at 28, the cycle labelled by its start month, in the user's zone.
CREATE TABLE "category_period_cap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"cap_minor_units" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_period_cap_category_key_unique" UNIQUE("category_id","period_key"),
	CONSTRAINT "category_period_cap_positive" CHECK ("category_period_cap"."cap_minor_units" is null or "category_period_cap"."cap_minor_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "category_period_cap" ADD CONSTRAINT "category_period_cap_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_period_cap" ADD CONSTRAINT "category_period_cap_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_period_cap_user_key" ON "category_period_cap" USING btree ("user_id","period_key");--> statement-breakpoint
-- Backfill 1: snapshots. Where two budgets for one category (a removed one and its
-- replacement) both hold a row for the same cycle, the later-materialised wins.
INSERT INTO "category_period_cap" ("user_id", "category_id", "period_key", "cap_minor_units", "created_at", "updated_at")
SELECT DISTINCT ON (b."category_id", bp."period_key")
       bp."user_id", b."category_id", bp."period_key", bp."cap_minor_units", bp."created_at", bp."created_at"
FROM "budget_period" bp
JOIN "budget" b ON b."id" = bp."budget_id"
WHERE b."category_id" IS NOT NULL
ORDER BY b."category_id", bp."period_key", bp."created_at" DESC;--> statement-breakpoint
-- Backfill 2: removals. `updated_at` on an inactive budget is when it was deactivated.
-- Never overrides a snapshot for the same cycle — the budget was live for part of it.
INSERT INTO "category_period_cap" ("user_id", "category_id", "period_key", "cap_minor_units", "created_at", "updated_at")
SELECT DISTINCT ON (b."category_id")
       b."user_id", b."category_id",
       to_char(
        CASE
          WHEN extract(day from (b."updated_at" at time zone u."timezone")::date) >= least(extract(day from u."period_anchor_date")::int, 28)
            THEN (b."updated_at" at time zone u."timezone")::date
          ELSE ((b."updated_at" at time zone u."timezone")::date - interval '1 month')::date
        END,
        'YYYY-MM'),
       NULL, b."updated_at", b."updated_at"
FROM "budget" b
JOIN "app_user" u ON u."id" = b."user_id"
WHERE NOT b."is_active" AND b."category_id" IS NOT NULL
  AND u."period_anchor_date" IS NOT NULL AND u."timezone" <> ''
  AND NOT EXISTS (SELECT 1 FROM "budget" live WHERE live."category_id" = b."category_id" AND live."is_active")
ORDER BY b."category_id", b."updated_at" DESC
ON CONFLICT ("category_id", "period_key") DO NOTHING;--> statement-breakpoint
-- Backfill 3: standing caps. `updated_at` on an active budget is when its cap was last
-- set; the row goes on that cycle and overrides that cycle's snapshot, as `setCap` does.
INSERT INTO "category_period_cap" ("user_id", "category_id", "period_key", "cap_minor_units", "created_at", "updated_at")
SELECT b."user_id", b."category_id",
       to_char(
        CASE
          WHEN extract(day from (b."updated_at" at time zone u."timezone")::date) >= least(extract(day from u."period_anchor_date")::int, 28)
            THEN (b."updated_at" at time zone u."timezone")::date
          ELSE ((b."updated_at" at time zone u."timezone")::date - interval '1 month')::date
        END,
        'YYYY-MM'),
       b."cap_minor_units", b."updated_at", b."updated_at"
FROM "budget" b
JOIN "app_user" u ON u."id" = b."user_id"
WHERE b."is_active" AND b."category_id" IS NOT NULL
  AND u."period_anchor_date" IS NOT NULL AND u."timezone" <> ''
ON CONFLICT ("category_id", "period_key") DO UPDATE
  SET "cap_minor_units" = EXCLUDED."cap_minor_units", "updated_at" = EXCLUDED."updated_at";--> statement-breakpoint
ALTER TABLE "budget" DROP CONSTRAINT "budget_cap_positive";--> statement-breakpoint
ALTER TABLE "budget_period" DROP CONSTRAINT "budget_period_cap_positive";--> statement-breakpoint
ALTER TABLE "budget" DROP COLUMN "cap_minor_units";--> statement-breakpoint
ALTER TABLE "budget_period" DROP COLUMN "cap_minor_units";
