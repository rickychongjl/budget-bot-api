import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleMerchantMappingRepository } from '../../src/infrastructure/database/repositories/drizzle-merchant-mapping-repository';
import { DrizzleParseEventRepository } from '../../src/infrastructure/database/repositories/drizzle-parse-event-repository';
import { applyMigrations } from '../support/pglite-migrations';

/**
 * M9 checklist 3: "Confirm `parse_event.user_id`'s `on delete set null` actually
 * fires correctly against M2's cascade delete — it's the one row that's supposed
 * to survive account deletion." Also exercises the real Drizzle repositories
 * (insert/returning, upsert, markUsed) against real constraints.
 *
 * Runs in-process on PGlite (real Postgres, WASM) so it needs no Neon branch. The
 * schema is the **committed migrations, applied in journal order** — including M2's
 * real `app_user`, whose `on delete` behaviour is the thing under test. (Until 12 Sep
 * this file carried a hand-copied DDL block with a stub `app_user`, verified against
 * `drizzle-kit generate` on 6 Sep and never again.)
 */

describe('parse_event / merchant_category_mapping against a real Postgres (PGlite)', () => {
  const pg = new PGlite();
  const db = drizzle(pg);
  const parseEvents = new DrizzleParseEventRepository(db);
  const mappings = new DrizzleMerchantMappingRepository(db);
  const NOW = Date.parse('2026-09-06T02:00:00Z');
  const CATEGORY = '00000000-0000-4000-8000-0000000000c1';
  let userId: string;

  beforeAll(async () => {
    await applyMigrations(pg);
    const rows = await db.execute(sql`insert into app_user (timezone) values ('Australia/Brisbane') returning id`);
    userId = (rows.rows[0] as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  it('parse_event survives account deletion with user_id nulled; the mapping cascades away', async () => {
    const parseEventId = await parseEvents.record(
      { userId, route: 'llm', model: 'gpt-5.4-nano', inputTokens: 480, outputTokens: 52, latencyMs: 210, neededClarification: false },
      NOW,
    );
    await mappings.saveConfirmed({ userId, normalizedMerchant: 'woolies', displayMerchant: 'Woolworths', categoryId: CATEGORY, source: 'user_confirmed' }, NOW);
    expect(await mappings.find(userId, 'woolies')).toMatchObject({ categoryId: CATEGORY, source: 'user_confirmed', timesUsed: 0 });

    await db.execute(sql`delete from app_user where id = ${userId}`);

    const survivors = await db.execute(sql`select id, user_id, route, model, input_tokens from parse_event`);
    expect(survivors.rows).toEqual([{ id: parseEventId, user_id: null, route: 'llm', model: 'gpt-5.4-nano', input_tokens: 480 }]);
    const gone = await db.execute(sql`select count(*)::int as n from merchant_category_mapping`);
    expect((gone.rows[0] as { n: number }).n).toBe(0);
  });

  it('markCorrected flips was_corrected (the M3 → M9 callback)', async () => {
    const id = await parseEvents.record({ userId: null, route: 'mapping', model: null, inputTokens: null, outputTokens: null, latencyMs: null, neededClarification: false }, NOW);
    await parseEvents.markCorrected(id);
    const row = await db.execute(sql`select was_corrected from parse_event where id = ${id}`);
    expect(row.rows[0]).toEqual({ was_corrected: true });
  });

  it('the route check constraint rejects anything outside the four routes', async () => {
    await expect(pg.query(`insert into parse_event (route) values ('guess')`)).rejects.toThrow(/parse_event_route_check/);
  });

  it('mapping upsert keeps one row per (user, merchant), source check holds, markUsed bumps usage', async () => {
    const rows = await db.execute(sql`insert into app_user (timezone) values ('Australia/Sydney') returning id`);
    const uid = (rows.rows[0] as { id: string }).id;
    const first = await mappings.saveConfirmed({ userId: uid, normalizedMerchant: 'coles', displayMerchant: 'Coles', categoryId: CATEGORY, source: 'user_confirmed' }, NOW);
    await mappings.markUsed(first.id, NOW + 1000);
    const second = await mappings.saveConfirmed({ userId: uid, normalizedMerchant: 'coles', displayMerchant: 'Coles Express', categoryId: CATEGORY, source: 'user_corrected' }, NOW + 2000);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ displayMerchant: 'Coles Express', source: 'user_corrected', timesUsed: 1 });
    await expect(
      pg.query(
        `insert into merchant_category_mapping (user_id, normalized_merchant, display_merchant, category_id, source) values ($1, 'x', 'X', $2, 'llm_guess')`,
        [uid, CATEGORY],
      ),
    ).rejects.toThrow(/merchant_category_mapping_source_check/);
    await mappings.remove(uid, 'coles');
    expect(await mappings.find(uid, 'coles')).toBeNull();
  });
});
