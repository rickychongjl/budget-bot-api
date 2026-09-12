import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, applyMigrations } from '../support/pglite-migrations';

/**
 * `0008` moves `currency_code` from `budget` to `category_period_cap`. Every other
 * suite applies it to empty tables; this one seeds the `0007` shape — currency on
 * `budget`, none on the cap rows — and pins what the backfill writes before the old
 * column is dropped. Forward-only means there is no second chance (M1 §5).
 *
 * The seed exercises each branch of the `COALESCE`: a category with a removed budget
 * *and* a live one (the live one's currency wins, whatever was updated last), one with
 * only a removed budget (its currency), and a cap row with no budget at all (the
 * account's). The last cannot happen through the service — it is the backfill's
 * safety net — so it is seeded by hand.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const FOOD = '22222222-2222-4222-8222-222222222222';
const FUN = '33333333-3333-4333-8333-333333333333';
const RENT = '44444444-4444-4444-8444-444444444444';

let pg: PGlite;

async function caps(): Promise<{ category_id: string; period_key: string; currency_code: string | null }[]> {
  const result = await pg.query<{ category_id: string; period_key: string; currency_code: string | null }>(
    `select category_id, period_key, currency_code from category_period_cap order by category_id, period_key`,
  );
  return result.rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg, { through: '0007_category_period_cap' });

  await pg.exec(`
    insert into app_user (id, timezone, currency_code, period_anchor_date, onboarding_step)
    values ('${USER}', 'Australia/Sydney', 'AUD', '2026-01-05', 'done');
    insert into category (id, user_id, name, normalized_name) values
      ('${FOOD}', '${USER}', 'Food', 'food'),
      ('${FUN}', '${USER}', 'Fun', 'fun'),
      ('${RENT}', '${USER}', 'Rent', 'rent');

    -- Food: a budget removed while the account was still in NZD, then re-added in AUD.
    -- The removed row is the more recently *updated* one, to prove the live budget wins
    -- on activity rather than recency.
    insert into budget (user_id, category_id, currency_code, is_active, created_at, updated_at) values
      ('${USER}', '${FOOD}', 'NZD', false, '2026-07-01T00:00:00Z', '2026-09-11T00:00:00Z'),
      ('${USER}', '${FOOD}', 'AUD', true,  '2026-08-25T00:00:00Z', '2026-09-10T00:00:00Z');
    insert into category_period_cap (user_id, category_id, period_key, cap_minor_units) values
      ('${USER}', '${FOOD}', '2026-07', 100000),
      ('${USER}', '${FOOD}', '2026-08', null),
      ('${USER}', '${FOOD}', '2026-09', 120000);

    -- Fun: removed in NZD, never replaced.
    insert into budget (user_id, category_id, currency_code, is_active, created_at, updated_at) values
      ('${USER}', '${FUN}', 'NZD', false, '2026-07-01T00:00:00Z', '2026-08-03T00:00:00Z');
    insert into category_period_cap (user_id, category_id, period_key, cap_minor_units) values
      ('${USER}', '${FUN}', '2026-07', 25000),
      ('${USER}', '${FUN}', '2026-08', null);

    -- Rent: a cap row with no budget row at all — only reachable by hand.
    insert into category_period_cap (user_id, category_id, period_key, cap_minor_units) values
      ('${USER}', '${RENT}', '2026-08', 200000);
  `);

  await applyMigration(pg, '0008_currency_on_cap');
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe('0008 backfills currency_code onto the cap history, then drops it from budget', () => {
  it('takes the live budget"s currency for every row of its category, removal rows included', async () => {
    expect((await caps()).filter((r) => r.category_id === FOOD)).toEqual([
      { category_id: FOOD, period_key: '2026-07', currency_code: 'AUD' },
      { category_id: FOOD, period_key: '2026-08', currency_code: 'AUD' },
      { category_id: FOOD, period_key: '2026-09', currency_code: 'AUD' },
    ]);
  });

  it('falls back to a removed budget"s currency when no live one exists', async () => {
    expect((await caps()).filter((r) => r.category_id === FUN)).toEqual([
      { category_id: FUN, period_key: '2026-07', currency_code: 'NZD' },
      { category_id: FUN, period_key: '2026-08', currency_code: 'NZD' },
    ]);
  });

  it('falls back to the account currency for a row with no budget at all', async () => {
    expect((await caps()).filter((r) => r.category_id === RENT)).toEqual([
      { category_id: RENT, period_key: '2026-08', currency_code: 'AUD' },
    ]);
  });

  it('leaves the column NOT NULL and gone from budget', async () => {
    const columns = await pg.query<{ table_name: string; is_nullable: string }>(
      `select table_name, is_nullable from information_schema.columns
       where column_name = 'currency_code' and table_name in ('budget', 'category_period_cap')`,
    );
    expect(columns.rows).toEqual([{ table_name: 'category_period_cap', is_nullable: 'NO' }]);
  });
});
