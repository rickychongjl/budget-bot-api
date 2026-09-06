import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleMerchantMappingRepository } from '../../src/parsing/merchant-mapping-repository';
import { DrizzleParseEventRepository } from '../../src/parsing/parse-event-repository';

/**
 * M9 checklist 3: "Confirm `parse_event.user_id`'s `on delete set null` actually
 * fires correctly against M2's cascade delete — it's the one row that's supposed
 * to survive account deletion." Also exercises the real Drizzle repositories
 * (insert/returning, upsert, touch) against real constraints.
 *
 * Runs in-process on PGlite (real Postgres, WASM) so it needs no Neon branch. The
 * DDL below is what `drizzle-kit generate` produces from `src/db/schema/
 * {observability,merchant}.ts` (verified 2026-09-06 with a local `app_user` stub —
 * see the M6 build-log); `app_user` is a minimal stand-in for M2's table with only
 * the columns this test touches. The committed migration itself is generated after
 * M2 merges (merge order — build-log open question 1).
 */
const DDL = `
create table app_user (
  id uuid primary key default gen_random_uuid(),
  timezone text not null,
  created_at timestamptz not null default now()
);
create table "parse_event" (
  "id" uuid primary key default gen_random_uuid() not null,
  "user_id" uuid,
  "route" text not null,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "latency_ms" integer,
  "needed_clarification" boolean default false not null,
  "was_corrected" boolean default false not null,
  "created_at" timestamp with time zone default now() not null,
  constraint "parse_event_route_check" check ("parse_event"."route" in ('command','mechanical','mapping','llm'))
);
create table "merchant_category_mapping" (
  "id" uuid primary key default gen_random_uuid() not null,
  "user_id" uuid not null,
  "normalized_merchant" text not null,
  "display_merchant" text not null,
  "category_id" uuid not null,
  "source" text not null,
  "times_used" integer default 0 not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "last_used_at" timestamp with time zone,
  constraint "merchant_category_mapping_user_merchant" unique("user_id","normalized_merchant"),
  constraint "merchant_category_mapping_source_check" check ("merchant_category_mapping"."source" in ('user_confirmed','user_corrected'))
);
alter table "parse_event" add constraint "parse_event_user_id_app_user_id_fk"
  foreign key ("user_id") references "app_user"("id") on delete set null on update no action;
alter table "merchant_category_mapping" add constraint "merchant_category_mapping_user_id_app_user_id_fk"
  foreign key ("user_id") references "app_user"("id") on delete cascade on update no action;
create index "parse_event_created" on "parse_event" using btree ("created_at");
create index "merchant_category_mapping_user" on "merchant_category_mapping" using btree ("user_id");
`;

describe('parse_event / merchant_category_mapping against a real Postgres (PGlite)', () => {
  const pg = new PGlite();
  const db = drizzle(pg);
  const parseEvents = new DrizzleParseEventRepository(db);
  const mappings = new DrizzleMerchantMappingRepository(db);
  const NOW = Date.parse('2026-09-06T02:00:00Z');
  const CATEGORY = '00000000-0000-4000-8000-0000000000c1';
  let userId: string;

  beforeAll(async () => {
    await pg.exec(DDL);
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

  it('mapping upsert keeps one row per (user, merchant), source check holds, touch bumps usage', async () => {
    const rows = await db.execute(sql`insert into app_user (timezone) values ('Australia/Sydney') returning id`);
    const uid = (rows.rows[0] as { id: string }).id;
    const first = await mappings.saveConfirmed({ userId: uid, normalizedMerchant: 'coles', displayMerchant: 'Coles', categoryId: CATEGORY, source: 'user_confirmed' }, NOW);
    await mappings.touch(first.id, NOW + 1000);
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
