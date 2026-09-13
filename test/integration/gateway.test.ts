import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/infrastructure/database/client';
import { DrizzleGatewayRepository } from '../../src/infrastructure/database/repositories/drizzle-gateway-repository';
import { applyMigrations } from '../support/pglite-migrations';

/**
 * M7's two tables against real Postgres.
 *
 * The unit suite proves the routing over an in-memory adapter; it cannot prove the
 * things that actually make the routing safe — that `inbound_update`'s primary key
 * rejects a second claim, that two concurrent claims produce exactly one winner
 * (Telegram delivers retries into different isolates, which is the entire reason dedup
 * is a constraint and not a cache), that `pending_prompt` holds one row per user, or
 * that deleting an account takes the prompt with it.
 *
 * Runs on PGlite (real Postgres, WASM) so it needs no Neon branch, and builds the
 * schema by applying the **committed migrations in journal order** — this suite
 * cannot drift from what a deploy would apply.
 */

const USER = '11111111-1111-4111-8111-111111111111';

let pg: PGlite;
let db: Database;
let repository: DrizzleGatewayRepository;

const NOW = Date.parse('2026-09-11T02:00:00Z');

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg);
  db = drizzle(pg) as unknown as Database;
  repository = new DrizzleGatewayRepository(db);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('delete from inbound_update');
  await pg.exec('delete from app_user');
  await pg.exec(
    `insert into app_user (id, timezone, currency_code, onboarding_step)
     values ('${USER}', 'Australia/Sydney', 'AUD', 'done')`,
  );
});

describe('claimUpdate', () => {
  it('claims an update once and refuses the redelivery', async () => {
    expect(await repository.claimUpdate('telegram', '800123', NOW)).toBe(true);
    expect(await repository.claimUpdate('telegram', '800123', NOW)).toBe(false);
  });

  it('treats the same update id on a different channel as a different update', async () => {
    // The primary key is (channel, update_id) precisely so a second adapter's id space
    // cannot collide with Telegram's.
    expect(await repository.claimUpdate('telegram', '1', NOW)).toBe(true);
    await pg.exec(`insert into inbound_update (channel, update_id) values ('whatsapp', '1')`);
    expect(await repository.claimUpdate('telegram', '1', NOW)).toBe(false);
  });

  it('produces exactly one winner across eight overlapping claims', async () => {
    // PGlite runs on a single connection, so these interleave rather than truly race:
    // this proves the `on conflict do nothing` + `returning` logic reports the right
    // winner, not that Postgres serialises concurrent inserts. Real concurrency needs
    // the Neon suite (`npm run test:integration`), which is where the same constraint
    // is exercised from separate connections.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.claimUpdate('telegram', '999', NOW)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('records when it arrived', async () => {
    await repository.claimUpdate('telegram', '555', NOW);

    const rows = await pg.query<{ received_at: Date }>(
      `select received_at from inbound_update where update_id = '555'`,
    );
    expect(rows.rows[0]!.received_at.getTime()).toBe(NOW);
  });
});

describe('pendingPrompt', () => {
  it('round-trips a prompt with its payload intact', async () => {
    await repository.setPendingPrompt({
      userId: USER,
      kind: 'confirm',
      payload: { amountMinorUnits: '1250', merchant: 'Woolworths' },
      now: NOW,
    });

    expect(await repository.findPendingPrompt(USER)).toEqual({
      userId: USER,
      kind: 'confirm',
      parseEventId: null,
      payload: { amountMinorUnits: '1250', merchant: 'Woolworths' },
      createdAt: NOW,
    });
  });

  it('keeps one open prompt per user — a second question replaces the first', async () => {
    await repository.setPendingPrompt({ userId: USER, kind: 'confirm', payload: { a: 1 }, now: NOW });
    await repository.setPendingPrompt({
      userId: USER,
      kind: 'clarify',
      payload: { question: 'which category?' },
      now: NOW + 1000,
    });

    const open = await repository.findPendingPrompt(USER);
    expect(open).toMatchObject({ kind: 'clarify', payload: { question: 'which category?' } });
    // The row's age is the age of the question actually outstanding.
    expect(open?.createdAt).toBe(NOW + 1000);

    const count = await pg.query<{ n: number }>('select count(*)::int as n from pending_prompt');
    expect(count.rows[0]!.n).toBe(1);
  });

  it('clears idempotently', async () => {
    await repository.setPendingPrompt({ userId: USER, kind: 'confirm', payload: {}, now: NOW });

    await repository.clearPendingPrompt(USER);
    await repository.clearPendingPrompt(USER);

    expect(await repository.findPendingPrompt(USER)).toBeNull();
  });

  it('rejects a kind outside the check constraint', async () => {
    await expect(
      pg.exec(
        `insert into pending_prompt (user_id, kind, payload) values ('${USER}', 'nonsense', '{}'::jsonb)`,
      ),
    ).rejects.toThrow();
  });

  it.each(['confirm', 'clarify', 'mapping'] as const)('accepts the %s kind', async (kind) => {
    // `mapping` is stage 4D's addition (migration 0009). This suite builds from the
    // migration journal, so it is the thing that proves the widened constraint
    // actually reached the schema a deploy would produce — the TypeScript union
    // would happily claim it either way.
    await repository.setPendingPrompt({ userId: USER, kind, payload: { a: 1 }, now: NOW });

    expect(await repository.findPendingPrompt(USER)).toMatchObject({ kind });
  });

  it('goes with the account when it is deleted', async () => {
    await repository.setPendingPrompt({ userId: USER, kind: 'confirm', payload: {}, now: NOW });

    await pg.exec('delete from app_user');

    const count = await pg.query<{ n: number }>('select count(*)::int as n from pending_prompt');
    expect(count.rows[0]!.n).toBe(0);
  });

  it('survives its parse_event being retired under M9 retention', async () => {
    const parseEventId = '22222222-2222-4222-8222-222222222222';
    await pg.exec(
      `insert into parse_event (id, user_id, route) values ('${parseEventId}', '${USER}', 'llm')`,
    );
    await repository.setPendingPrompt({
      userId: USER,
      kind: 'clarify',
      parseEventId,
      payload: { question: 'which category?' },
      now: NOW,
    });

    await pg.exec(`delete from parse_event where id = '${parseEventId}'`);

    // `on delete set null`: losing the correlation id must not delete the user's
    // conversation out from under them.
    const open = await repository.findPendingPrompt(USER);
    expect(open).toMatchObject({ kind: 'clarify', parseEventId: null });
  });
});
