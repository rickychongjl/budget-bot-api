import { describe, expect, it } from 'vitest';
import type { Env, Services } from '../../../src/index';
import { createApp } from '../../../src/index';

/**
 * The webhook's place in the route table. The handler's own behaviour is
 * `webhook-handler.test.ts`; this is only about `index.ts` delegating — the raw
 * request and the execution context reaching it unchanged, and no parsing or routing
 * happening in the composition root (CLAUDE.md: `index.ts` "must not parse Telegram
 * commands").
 */

const ENV: Env = {
  HYPERDRIVE: { connectionString: 'postgres://unused' } as Hyperdrive,
  WORKER_BASE_URL: 'https://budge-bot-api.test',
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
  INTERNAL_DISPATCH_SECRET: 'dispatch-secret',
  OPENAI_API_KEY: 'sk-test',
  DATABASE_URL: 'postgres://unused',
  SUPPORT_CONTACT: 'support@example.test',
};

function stubServices() {
  const handled: { request: Request; ctx: unknown }[] = [];
  const services = {
    telegramWebhook: {
      handle: async (request: Request, ctx: unknown) => {
        handled.push({ request, ctx });
        return new Response('ok', { status: 200 });
      },
    },
  } as unknown as Services;
  return { services, handled };
}

function webhookRequest(body: unknown = { update_id: 1 }): Request {
  return new Request('https://budge-bot-api.test/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'webhook-secret',
    },
    body: JSON.stringify(body),
  });
}

/** The bits of `ExecutionContext` Hono's `fetch` signature insists on. */
function testContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

describe('POST /telegram/webhook', () => {
  it('hands the raw request and the execution context to the handler', async () => {
    const { services, handled } = stubServices();
    const app = createApp(() => services);
    const ctx = testContext();

    const response = await app.fetch(webhookRequest(), ENV, ctx);

    expect(response.status).toBe(200);
    expect(handled).toHaveLength(1);
    // The body must still be unread: the handler checks the secret before parsing it.
    expect(handled[0]!.request.bodyUsed).toBe(false);
    expect(handled[0]!.ctx).toBe(ctx);
  });

  it('returns whatever the handler decided, including a 401', async () => {
    const services = {
      telegramWebhook: { handle: async () => new Response('unauthorized', { status: 401 }) },
    } as unknown as Services;
    const app = createApp(() => services);
    const response = await app.fetch(webhookRequest(), ENV, testContext());

    // The route adds no opinion of its own — no rewriting of the handler's status.
    expect(response.status).toBe(401);
  });

  it('leaves /health untouched', async () => {
    const { services } = stubServices();
    const app = createApp(() => services);

    const response = await app.fetch(new Request('https://budge-bot-api.test/health'), ENV);

    expect(response.status).toBe(200);
  });
});
