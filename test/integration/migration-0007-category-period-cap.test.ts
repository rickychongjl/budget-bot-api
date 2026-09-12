import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, applyMigrations } from '../support/pglite-migrations';

/**
 * The one migration in this repository that moves data. Every other suite applies
 * `0007` to empty tables, which proves it parses and nothing more; this one seeds the
 * *old* shape — caps on `budget` and `budget_period` — and checks what the backfill
 * makes of it before the columns are dropped. Forward-only means there is no second
 * chance in production (M1 §5), so the three INSERTs are pinned here row by row.
 *
 * Anchor day 5, Sydney. Cycles are labelled by start month: 2026-08-20 sits in
 * `2026-08`; 2026-09-03 sits in `2026-08` too (before the 5th); 2026-09-10 in `2026-09`.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const FOOD = '22222222-2222-4222-8222-222222222222';
const FUN = '33333333-3333-4333-8333-333333333333';
const RENT = '44444444-4444-4444-8444-444444444444';
const FOOD_BUDGET = '55555555-5555-4555-8555-555555555555';
const FOOD_OLD_BUDGET = '66666666-6666-4666-8666-666666666666';
const FUN_BUDGET = '77777777-7777-4777-8777-777777777777';
const RENT_BUDGET = '88888888-8888-4888-8888-888888888888';

let pg: PGlite;

async function caps(): Promise<{ category_id: string; period_key: string; cap: string | null }[]> {
  const result = await pg.query<{ category_id: string; period_key: string; cap: string | null }>(
    `select category_id, period_key, cap_minor_units::text as cap
     from category_period_cap order by category_id, period_key`,
  );
  return result.rows;
}

beforeAll(async () => {
  pg = new PGlite();
  // Everything before 0007, so the seed below lands in the shape 0007 expects to find.
  await applyMigrations(pg, { through: '0006_regular_rawhide_kid' });

  await pg.exec(`
    insert into app_user (id, timezone, currency_code, period_anchor_date, onboarding_step)
    values ('${USER}', 'Australia/Sydney', 'AUD', '2026-01-05', 'done');
    insert into category (id, user_id, name, normalized_name) values
      ('${FOOD}', '${USER}', 'Food', 'food'),
      ('${FUN}', '${USER}', 'Fun', 'fun'),
      ('${RENT}', '${USER}', 'Rent', 'rent');

    -- Food: an old budget removed in August, replaced by one whose cap was last set
    -- on 10 Sep. July and August were materialised under the old budget at 1000;
    -- September under the new one at 1100 before the cap was raised to 1200.
    insert into budget (id, user_id, category_id, cap_minor_units, currency_code, is_active, created_at, updated_at) values
      ('${FOOD_OLD_BUDGET}', '${USER}', '${FOOD}', 100000, 'AUD', false, '2026-07-01T00:00:00Z', '2026-08-20T02:00:00Z'),
      ('${FOOD_BUDGET}',     '${USER}', '${FOOD}', 120000, 'AUD', true,  '2026-08-25T00:00:00Z', '2026-09-10T02:00:00Z');
    insert into budget_period (user_id, budget_id, period_key, period_start, period_end, cap_minor_units, created_at) values
      ('${USER}', '${FOOD_OLD_BUDGET}', '2026-07', '2026-07-05', '2026-08-04', 100000, '2026-07-10T00:00:00Z'),
      ('${USER}', '${FOOD_OLD_BUDGET}', '2026-08', '2026-08-05', '2026-09-04', 100000, '2026-08-10T00:00:00Z'),
      ('${USER}', '${FOOD_BUDGET}',     '2026-08', '2026-08-05', '2026-09-04', 110000, '2026-08-26T00:00:00Z'),
      ('${USER}', '${FOOD_BUDGET}',     '2026-09', '2026-09-05', '2026-10-04', 110000, '2026-09-06T00:00:00Z');

    -- Fun: removed on 3 Sep (still cycle 2026-08), never replaced. One snapshot.
    insert into budget (id, user_id, category_id, cap_minor_units, currency_code, is_active, created_at, updated_at) values
      ('${FUN_BUDGET}', '${USER}', '${FUN}', 25000, 'AUD', false, '2026-07-01T00:00:00Z', '2026-09-03T02:00:00Z');
    insert into budget_period (user_id, budget_id, period_key, period_start, period_end, cap_minor_units, created_at) values
      ('${USER}', '${FUN_BUDGET}', '2026-07', '2026-07-05', '2026-08-04', 25000, '2026-07-10T00:00:00Z');

    -- Rent: a standing cap set on 20 Aug and never materialised at all.
    insert into budget (id, user_id, category_id, cap_minor_units, currency_code, is_active, created_at, updated_at) values
      ('${RENT_BUDGET}', '${USER}', '${RENT}', 200000, 'AUD', true, '2026-08-20T02:00:00Z', '2026-08-20T02:00:00Z');
  `);

  await applyMigration(pg, '0007_category_period_cap');
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe('0007 backfills the cap history from the old columns, then drops them', () => {
  it('turns every snapshot into that cycle\'s row, the later budget winning a shared cycle', async () => {
    const rows = await caps();
    expect(rows.filter((r) => r.category_id === FOOD)).toEqual([
      { category_id: FOOD, period_key: '2026-07', cap: '100000' },
      { category_id: FOOD, period_key: '2026-08', cap: '110000' }, // the replacement's, not the removed one's
      { category_id: FOOD, period_key: '2026-09', cap: '120000' }, // standing cap overrides the 1100 snapshot
    ]);
  });

  it('writes a null row for a removed budget in the cycle it was removed', async () => {
    const rows = await caps();
    expect(rows.filter((r) => r.category_id === FUN)).toEqual([
      { category_id: FUN, period_key: '2026-07', cap: '25000' },
      { category_id: FUN, period_key: '2026-08', cap: null }, // 3 Sep is before the 5th: still 2026-08
    ]);
  });

  it('places a never-materialised standing cap on the cycle it was last set in', async () => {
    const rows = await caps();
    expect(rows.filter((r) => r.category_id === RENT)).toEqual([
      { category_id: RENT, period_key: '2026-08', cap: '200000' },
    ]);
  });

  it('drops the old columns and their checks only after the backfill', async () => {
    const columns = await pg.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_name in ('budget', 'budget_period') and column_name = 'cap_minor_units'`,
    );
    expect(columns.rows).toEqual([]);
    const checks = await pg.query<{ conname: string }>(
      `select conname from pg_constraint where conname in ('budget_cap_positive', 'budget_period_cap_positive')`,
    );
    expect(checks.rows).toEqual([]);
  });
});
