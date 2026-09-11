import { describe, expect, it } from 'vitest';
import { TelegramWebhookHandler } from '../../../src/channels/telegram/webhook-handler';
import type { BackgroundWork } from '../../../src/channels/telegram/webhook-handler';
import type { TelegramEvent } from '../../../src/channels/telegram/update-parser';
import { NoopLogger } from '../../../src/observability/log';
import { InMemoryGatewayRepository } from '../../support/in-memory-gateway-repository';
import { TestClock } from '../../support/test-clock';

/**
 * The webhook's three guarantees: an unauthenticated request is refused without the
 * body being touched, a Telegram redelivery is acknowledged and dropped, and 200 comes
 * back *before* the work finishes.
 *
 * The last one is the reason the handler exists in this shape at all — Telegram
 * retries any non-2xx aggressively, and the work can include an LLM call.
 */

const SECRET = 'webhook-secret-value';

/** Collects `waitUntil` promises so a test can await the background work on purpose. */
class TestContext implements BackgroundWork {
  readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  settle(): Promise<unknown[]> {
    return Promise.all(this.pending);
  }
}

function createHandler(options: { onDispatch?: (event: TelegramEvent) => Promise<void> } = {}) {
  const dispatched: TelegramEvent[] = [];
  const gateway = new InMemoryGatewayRepository();
  const handler = new TelegramWebhookHandler({
    dispatcher: {
      dispatch: async (event) => {
        dispatched.push(event);
        await options.onDispatch?.(event);
      },
    },
    gateway,
    clock: new TestClock('2026-09-11T02:00:00Z'),
    logger: new NoopLogger(),
    webhookSecret: SECRET,
  });
  return { handler, dispatched, gateway };
}

function update(id: number, text = 'hello'): unknown {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1789000000,
      chat: { id: '99001', type: 'private' },
      from: { id: '55501' },
      text,
    },
  };
}

function post(body: unknown, secret?: string): Request {
  return new Request('https://budge-bot-api.test/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret }),
    },
    body: JSON.stringify(body),
  });
}

describe('authentication', () => {
  it.each([
    ['a missing secret', undefined],
    ['a wrong secret', 'not-the-secret-value'],
    ['an empty secret', ''],
  ])('refuses %s with 401', async (_label, secret) => {
    const { handler, dispatched } = createHandler();

    const response = await handler.handle(post(update(1), secret), new TestContext());

    expect(response.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('never reads the body of an unauthenticated request', async () => {
    const { handler } = createHandler();
    // The URL alone is not a credential, so an unauthenticated caller must not be able
    // to make us parse arbitrary JSON. A request whose body explodes on read proves it.
    const request = new Request('https://budge-bot-api.test/telegram/webhook', { method: 'POST' });
    Object.defineProperty(request, 'json', {
      value: () => {
        throw new Error('body was read');
      },
    });

    const response = await handler.handle(request, new TestContext());

    expect(response.status).toBe(401);
  });
});

describe('deduplication', () => {
  it('claims an update once and drops the redelivery', async () => {
    const { handler, dispatched } = createHandler();
    const ctx = new TestContext();

    const first = await handler.handle(post(update(42), SECRET), ctx);
    const second = await handler.handle(post(update(42), SECRET), ctx);
    await ctx.settle();

    expect(first.status).toBe(200);
    // 200 on the duplicate too: anything else and Telegram retries it forever.
    expect(second.status).toBe(200);
    expect(dispatched).toHaveLength(1);
  });

  it('treats a different update_id as a different message', async () => {
    const { handler, dispatched } = createHandler();
    const ctx = new TestContext();

    await handler.handle(post(update(1), SECRET), ctx);
    await handler.handle(post(update(2), SECRET), ctx);
    await ctx.settle();

    expect(dispatched).toHaveLength(2);
  });
});

describe('responding before the work', () => {
  it('returns 200 while the dispatch is still running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler, dispatched } = createHandler({ onDispatch: () => blocked });
    const ctx = new TestContext();

    const response = await handler.handle(post(update(7), SECRET), ctx);

    // The reply is already out while the background work is still blocked.
    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(ctx.pending).toHaveLength(1);

    release();
    await ctx.settle();
  });

  it('acknowledges malformed JSON rather than inviting a retry', async () => {
    const { handler, dispatched } = createHandler();
    const request = new Request('https://budge-bot-api.test/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: 'not json at all',
    });

    const response = await handler.handle(request, new TestContext());

    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(0);
  });

  it('acknowledges an unrecognisable update without claiming anything', async () => {
    const { handler, dispatched, gateway } = createHandler();

    const response = await handler.handle(post({ not: 'an update' }, SECRET), new TestContext());

    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(0);
    expect(gateway.claims).toHaveLength(0);
  });
});
