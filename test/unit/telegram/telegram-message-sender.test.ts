import { describe, expect, it } from 'vitest';
import { TelegramApiClient } from '../../../src/channels/telegram/telegram-api-client';
import { TelegramMessageSender } from '../../../src/channels/telegram/telegram-message-sender';
import type { ChannelConnection } from '../../../src/core/shared/messaging';
import type { LogFields, LogLevel, Logger } from '../../../src/observability/log';
import { FakeTelegramApi, telegramError, telegramOk } from '../../support/fake-telegram-api';

/**
 * The failure-classification matrix from M7's "Outbound delivery", driven through the
 * real `TelegramApiClient` over a fake `fetch`. This is the contract M5 depends on —
 * `DefaultAllowanceService` maps each `SendResult` onto a `daily_allowance_send` row
 * state, so getting 429 wrong turns a retryable bundle into a dead one. Unit tier:
 * no network, no database.
 */

const TOKEN = '8000000000:AAHtestTOKENvalue_not_real_0123456789';

const CONNECTION: ChannelConnection = {
  id: 'conn-1',
  userId: 'user-1',
  channel: 'telegram',
  externalId: '424242',
  chatId: '424242',
  username: 'ricky',
  isActive: true,
  linkedAt: Date.parse('2026-09-01T00:00:00Z'),
};

class CapturingLogger implements Logger {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.lines.push({ level, event, fields });
  }
}

function harness(...scripted: (Response | (() => Response) | Error)[]) {
  const api = new FakeTelegramApi(...scripted);
  const logger = new CapturingLogger();
  const client = new TelegramApiClient({ token: TOKEN, fetch: api.fetch, logger });
  return { api, logger, sender: new TelegramMessageSender(client) };
}

describe('TelegramMessageSender — failure classification', () => {
  it('200 -> sent, and posts the text to the connection chat as plain text', async () => {
    const { api, sender } = harness(telegramOk());

    const result = await sender.send(CONNECTION, { text: 'Groceries: $18 available today' });

    expect(result).toEqual({ status: 'sent' });
    expect(api.only.method).toBe('sendMessage');
    expect(api.only.payload).toEqual({
      chat_id: '424242',
      text: 'Groceries: $18 available today',
    });
    // No parse_mode: M5 strips markup rather than escaping it, which only holds if
    // Telegram is never asked to interpret markup.
    expect(api.only.payload).not.toHaveProperty('parse_mode');
  });

  it('403 blocked -> skipped/blocked, and never deactivates anything itself', async () => {
    const { sender } = harness(telegramError(403, 'Forbidden: bot was blocked by the user'));

    const result = await sender.send(CONNECTION, { text: 'hi' });

    // M5's `computeAndSend` owns the deactivation; the sender only classifies.
    expect(result).toEqual({ status: 'skipped', reason: 'blocked' });
  });

  it('429 -> retryable, carrying parameters.retry_after', async () => {
    const { sender } = harness(telegramError(429, 'Too Many Requests: retry after 37', 37));

    const result = await sender.send(CONNECTION, { text: 'hi' });

    expect(result).toEqual({ status: 'retryable', retryAfterSeconds: 37 });
  });

  it('429 without retry_after -> retryable with the field absent, not undefined', async () => {
    const { sender } = harness(telegramError(429, 'Too Many Requests'));

    const result = await sender.send(CONNECTION, { text: 'hi' });

    expect(result).toEqual({ status: 'retryable' });
    expect(Object.hasOwn(result, 'retryAfterSeconds')).toBe(false);
  });

  it('5xx -> retryable', async () => {
    const { sender } = harness(telegramError(502, 'Bad Gateway'));

    expect(await sender.send(CONNECTION, { text: 'hi' })).toEqual({ status: 'retryable' });
  });

  it('a network failure -> retryable', async () => {
    const { sender } = harness(new TypeError('fetch failed'));

    expect(await sender.send(CONNECTION, { text: 'hi' })).toEqual({ status: 'retryable' });
  });

  it('400 -> permanent; retrying would send identical bytes', async () => {
    const { sender } = harness(telegramError(400, "Bad Request: can't parse entities"));

    expect(await sender.send(CONNECTION, { text: 'hi' })).toEqual({ status: 'permanent' });
  });

  it('401 (wrong token) and 404 (chat gone) -> permanent, not an endless retry', async () => {
    const unauthorised = harness(telegramError(401, 'Unauthorized'));
    expect(await unauthorised.sender.send(CONNECTION, { text: 'hi' })).toEqual({
      status: 'permanent',
    });

    const gone = harness(telegramError(404, 'Not Found: chat not found'));
    expect(await gone.sender.send(CONNECTION, { text: 'hi' })).toEqual({ status: 'permanent' });
  });

  it('a non-JSON error body is classified by status, not by a parse failure', async () => {
    const { sender } = harness(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    expect(await sender.send(CONNECTION, { text: 'hi' })).toEqual({ status: 'retryable' });
  });
});

describe('TelegramApiClient — the token never escapes', () => {
  it('puts the token in the request URL and nowhere else', async () => {
    const { api, logger, sender } = harness(telegramError(429, 'Too Many Requests', 5));

    const result = await sender.send(CONNECTION, { text: 'hi' });

    // It is in the URL, because that is how the Bot API authenticates.
    expect(api.only.url).toContain(TOKEN);
    // And in nothing that is returned or written down.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
    expect(JSON.stringify(api.only.payload)).not.toContain(TOKEN);
  });

  it('reduces a fetch rejection to its error name, because the message can quote the URL', async () => {
    const leaky = new TypeError(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
    const { logger, sender } = harness(leaky);

    const result = await sender.send(CONNECTION, { text: 'hi' });

    expect(result).toEqual({ status: 'retryable' });
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
    expect(logger.lines.map((l) => l.event)).toContain('telegram.call.network_error');
  });

  it('does not throw on any failure — every outcome is classifiable', async () => {
    const { sender } = harness(
      new TypeError('boom'),
      telegramError(500),
      () => new Response('', { status: 418 }),
    );

    await expect(sender.send(CONNECTION, { text: 'a' })).resolves.toBeDefined();
    await expect(sender.send(CONNECTION, { text: 'b' })).resolves.toBeDefined();
    await expect(sender.send(CONNECTION, { text: 'c' })).resolves.toBeDefined();
  });
});
