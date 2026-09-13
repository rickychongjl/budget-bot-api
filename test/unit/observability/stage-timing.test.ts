import { describe, expect, it } from 'vitest';
import { TelegramApiClient } from '../../../src/channels/telegram/telegram-api-client';
import { parseUpdate } from '../../../src/channels/telegram/update-parser';
import { TelegramWebhookHandler } from '../../../src/channels/telegram/webhook-handler';
import type { BackgroundWork } from '../../../src/channels/telegram/webhook-handler';
import type { Instant } from '../../../src/core/shared/common';
import { OpenAiLlmParser, LLM_MODEL } from '../../../src/infrastructure/llm/openai-parser';
import type { LogFields, LogLevel, Logger } from '../../../src/observability/log';
import { startTimer, timed } from '../../../src/observability/timing';
import { FakeTelegramApi, telegramOk } from '../../support/fake-telegram-api';
import { InMemoryGatewayRepository } from '../../support/in-memory-gateway-repository';
import { llmResult } from '../../support/scripted-llm-parser';
import { TestClock } from '../../support/test-clock';
import { USER, createHarness, textUpdate } from '../telegram/harness';

/**
 * The request-lifecycle stage timing (M9).
 *
 * Two things are asserted, and nothing else is: that each boundary emits a line whose
 * name is stable and whose `ms` is a real non-negative number, and that no line
 * anywhere on the path carries message text, a category or merchant name, a chat id or
 * a secret. Every duration is driven by a `TestClock` advanced a known amount inside a
 * double — never by real elapsed time, which would make these assertions flaky on a
 * slow machine and meaningless on a fast one.
 *
 * The privacy half mirrors `test/unit/llm-parser.test.ts`'s "never logs the API key,
 * the message text, or the categories". Timing is the one thing this instrumentation
 * is allowed to say.
 */

const SECRET = 'webhook-secret-value';
const BOT_TOKEN = '8000000000:AAHtestTOKENvalue_not_real_0123456789';
const API_KEY = 'sk-test-0123456789abcdefghijklmnop';

class CapturingLogger implements Logger {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[] = [];

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.lines.push({ level, event, fields });
  }

  events(): string[] {
    return this.lines.map((line) => line.event);
  }

  /** The single line for `event` — a stage that fired twice is a bug worth failing on. */
  only(event: string): { level: LogLevel; event: string; fields: LogFields } {
    const found = this.lines.filter((line) => line.event === event);
    if (found.length !== 1) {
      throw new Error(`expected exactly one ${event} line, got ${found.length} of [${this.events().join(', ')}]`);
    }
    return found[0]!;
  }

  ms(event: string): number {
    const value = this.only(event).fields.ms;
    if (typeof value !== 'number') throw new Error(`${event} has no numeric ms field`);
    return value;
  }
}

class TestContext implements BackgroundWork {
  readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  settle(): Promise<unknown[]> {
    return Promise.all(this.pending);
  }
}

// ---- the helper itself -------------------------------------------------------------

describe('timing helpers', () => {
  it('measures against the injected clock, not wall time', async () => {
    const clock = new TestClock('2026-09-13T00:00:00Z');
    const logger = new CapturingLogger();

    await timed(logger, clock, 'stage.example', async () => {
      clock.advance(1234);
    });

    expect(logger.ms('stage.example')).toBe(1234);
  });

  it('still logs the duration when the stage throws — a slow failure is the interesting one', async () => {
    const clock = new TestClock(0);
    const logger = new CapturingLogger();

    await expect(
      timed(logger, clock, 'stage.exploding', async () => {
        clock.advance(50);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(logger.ms('stage.exploding')).toBe(50);
    // The error itself is not the timer's business to describe.
    expect(JSON.stringify(logger.only('stage.exploding').fields)).not.toContain('boom');
  });

  it('never reports a negative duration, even if the clock steps backwards', () => {
    const clock = new TestClock(1000);
    const elapsed = startTimer(clock);
    clock.advance(-500);

    expect(elapsed()).toBe(0);
  });
});

// ---- the webhook boundary ----------------------------------------------------------

function post(body: unknown): Request {
  return new Request('https://budge-bot-api.test/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: JSON.stringify(body),
  });
}

describe('webhook receipt', () => {
  it('times the dedupe claim and hands the receipt instant to the dispatcher', async () => {
    const clock = new TestClock('2026-09-11T02:00:00Z');
    const receivedAt = clock.now();
    const logger = new CapturingLogger();
    const gateway = new InMemoryGatewayRepository();
    const claimUpdate = gateway.claimUpdate.bind(gateway);
    // The first database round trip — the one that pays for a cold Neon compute.
    gateway.claimUpdate = async (channel, updateId, now) => {
      clock.advance(250);
      return claimUpdate(channel, updateId, now);
    };

    const dispatched: (Instant | undefined)[] = [];
    const handler = new TelegramWebhookHandler({
      dispatcher: {
        dispatch: async (_event, at) => {
          dispatched.push(at);
        },
      },
      gateway,
      clock,
      logger,
      webhookSecret: SECRET,
    });

    const ctx = new TestContext();
    const response = await handler.handle(post(textUpdate('coffee 5')), ctx);
    await ctx.settle();

    expect(response.status).toBe(200);
    expect(logger.events()).toEqual(
      expect.arrayContaining(['telegram.webhook.received', 'telegram.webhook.claimed']),
    );
    expect(logger.only('telegram.webhook.received').fields.kind).toBe('text_message');
    expect(logger.ms('telegram.webhook.received')).toBe(0);
    expect(logger.only('telegram.webhook.claimed').fields.claimed).toBe(true);
    expect(logger.ms('telegram.webhook.claimed')).toBe(250);
    // Handed on, so the dispatcher's closing line covers the whole lifecycle.
    expect(dispatched).toEqual([receivedAt]);
  });
});

// ---- the whole free-text lifecycle -------------------------------------------------

/**
 * One free-text message, timed end to end with every slow stage faked at a known
 * duration: 40ms to resolve the user, 30ms to read the pending prompt, 900ms in the
 * model. The dispatch is told the webhook took delivery 500ms earlier.
 */
async function runFreeTextLifecycle(): Promise<CapturingLogger> {
  const logger = new CapturingLogger();
  const h = createHarness('2026-09-11T02:00:00Z', logger);
  await h.seedCategory(USER, 'Food', { cap: 60000n });

  const resolve = h.identity.resolve.bind(h.identity);
  h.identity.resolve = async (channel, externalId) => {
    h.clock.advance(40);
    return resolve(channel, externalId);
  };
  const findPendingPrompt = h.gateway.findPendingPrompt.bind(h.gateway);
  h.gateway.findPendingPrompt = async (userId) => {
    h.clock.advance(30);
    return findPendingPrompt(userId);
  };
  const parse = h.llm.parse.bind(h.llm);
  h.llm.parse = async (text, context) => {
    h.clock.advance(900);
    return parse(text, context);
  };
  h.llm.enqueue(
    llmResult({
      intent: 'expense',
      amount: 12.5,
      currency: 'AUD',
      merchant: 'Woolworths',
      category: 'Food',
      confidence: 0.96,
    }),
  );

  const receivedAt = h.clock.now() - 500;
  await h.dispatcher.dispatch(parseUpdate(textUpdate('woolies 12.50')), receivedAt);
  return logger;
}

describe('a free-text message, stage by stage', () => {
  it('emits every stage with a non-negative numeric duration', async () => {
    const logger = await runFreeTextLifecycle();

    for (const event of [
      'telegram.dispatch.resolved',
      'telegram.dispatch.admitted',
      'telegram.dispatch.prompt_checked',
      'telegram.dispatch.free_text',
      'telegram.freetext.context',
      'telegram.freetext.parse',
      'telegram.freetext.prompt_written',
      'parse.mechanical',
      'parse.event_recorded',
      'parse.recorded',
      'parse.allowance_recalculated',
      'telegram.dispatch.routed',
      'telegram.dispatch.sent',
      'telegram.dispatch.complete',
    ]) {
      const ms = logger.ms(event);
      expect(Number.isFinite(ms), `${event} ms is not a number`).toBe(true);
      expect(ms, `${event} ms is negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('attributes the time to the stage that spent it, and totals the lifecycle', async () => {
    const logger = await runFreeTextLifecycle();

    expect(logger.ms('telegram.dispatch.resolved')).toBe(40);
    expect(logger.ms('telegram.dispatch.prompt_checked')).toBe(30);
    expect(logger.only('telegram.dispatch.prompt_checked').fields.open).toBe(false);
    // The model dominates, which is the whole reason this instrumentation exists.
    expect(logger.ms('telegram.freetext.parse')).toBe(900);
    expect(logger.ms('telegram.dispatch.free_text')).toBe(900);
    expect(logger.only('telegram.dispatch.free_text').fields.path).toBe('new');
    // In-memory stages cost nothing, which is the control on the numbers above.
    expect(logger.ms('telegram.freetext.context')).toBe(0);
    expect(logger.ms('parse.mechanical')).toBe(0);
    // Total = 500ms before dispatch started + 40 + 30 + 900 inside it. Read straight
    // off one line, without adding up the breakdown by hand.
    expect(logger.ms('telegram.dispatch.complete')).toBe(1470);
    expect(logger.only('telegram.dispatch.complete').fields.ok).toBe(true);
  });

  it('closes the lifecycle even when the dispatch fails', async () => {
    const logger = new CapturingLogger();
    const h = createHarness('2026-09-11T02:00:00Z', logger);
    h.identity.resolve = async () => {
      h.clock.advance(70);
      throw new Error('database unreachable');
    };

    await h.dispatcher.dispatch(parseUpdate(textUpdate('coffee 5')));

    expect(logger.ms('telegram.dispatch.resolved')).toBe(70);
    expect(logger.only('telegram.dispatch.complete').fields.ok).toBe(false);
    expect(logger.ms('telegram.dispatch.complete')).toBe(70);
  });
});

// ---- the invariant that matters ----------------------------------------------------

describe('the timing lines never carry content or secrets (M9)', () => {
  it('logs nothing from the message, the categories or the merchant', async () => {
    const logger = await runFreeTextLifecycle();

    expect(logger.lines.length).toBeGreaterThan(5);
    for (const line of logger.lines) {
      const text = JSON.stringify(line);
      expect(text, `${line.event} leaked content`).not.toMatch(
        /woolies|Woolworths|12\.50|Food|Australia\/Sydney/i,
      );
      // Chat and sender ids are channel identifiers — M9 forbids those too.
      expect(text, `${line.event} leaked a channel identifier`).not.toMatch(/99001|55501/);
    }
  });

  it('logs no secret from the webhook or the Bot API', async () => {
    const clock = new TestClock('2026-09-11T02:00:00Z');
    const logger = new CapturingLogger();
    const api = new FakeTelegramApi(() => {
      clock.advance(310);
      return telegramOk();
    });
    const client = new TelegramApiClient({ token: BOT_TOKEN, fetch: api.fetch, logger, clock });

    await client.sendMessage('99001', 'Recorded $12.50 at Woolworths under Food.');

    // The outbound half of the latency, measured off the injected clock.
    expect(logger.only('telegram.call.ok').fields.method).toBe('sendMessage');
    expect(logger.ms('telegram.call.ok')).toBe(310);
    const text = JSON.stringify(logger.lines);
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/Woolworths|12\.50|Food|99001/);
  });

  it('logs the model call on success with usage only — never the prompt or the key', async () => {
    const clock = new TestClock('2026-09-06T02:00:00Z');
    const logger = new CapturingLogger();
    const body = {
      id: 'resp_1',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: LLM_MODEL,
      error: null,
      incomplete_details: null,
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              annotations: [],
              text: JSON.stringify({
                intent: 'expense',
                amount: 12.5,
                currency: 'AUD',
                merchant: 'Woolworths',
                category: 'Food',
                transaction_date: null,
                confidence: 0.96,
                needs_clarification: false,
                clarification_question: null,
              }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 480,
        output_tokens: 52,
        total_tokens: 532,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const fetchFn: typeof fetch = async () => {
      clock.advance(870);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const parser = new OpenAiLlmParser({ apiKey: API_KEY, clock, logger, fetch: fetchFn });

    await parser.parse('woolies 12.50', { categoryNames: ['Food', 'Coffee'], currencyCode: 'AUD' });

    // The same `latencyMs` the result's `usage` carries and `parse_event` stores —
    // one measurement, reported rather than recomputed.
    const line = logger.only('llm_parse_ok');
    expect(line.fields.latencyMs).toBe(870);
    expect(line.fields.model).toBe(LLM_MODEL);
    expect(line.fields.inputTokens).toBe(480);
    expect(line.fields.outputTokens).toBe(52);
    const text = JSON.stringify(logger.lines);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toMatch(/woolies|Woolworths|12\.50|Food|Coffee/);
  });
});
