import { describe, expect, it } from 'vitest';
import { parseUpdate } from '../../../src/channels/telegram/update-parser';

/**
 * Realistic Telegram payloads for each event kind, plus the shapes that must not
 * throw. The parser is the only place in the repo that knows Telegram's wire format,
 * so everything downstream is only as correct as this file's fixtures.
 */

const FROM = { id: 55501, is_bot: false, first_name: 'Ricky', username: 'ricky' };
const PRIVATE_CHAT = { id: 99001, first_name: 'Ricky', type: 'private' };

function message(extra: Record<string, unknown>): unknown {
  return {
    update_id: 800123,
    message: { message_id: 41, from: FROM, chat: PRIVATE_CHAT, date: 1789000000, ...extra },
  };
}

describe('text messages', () => {
  it('parses a plain message', () => {
    const event = parseUpdate(message({ text: '12.50 lunch' }));

    expect(event).toMatchObject({
      kind: 'text_message',
      text: '12.50 lunch',
      updateId: '800123',
      sender: { externalId: '55501', chatId: '99001', username: 'ricky' },
    });
  });

  it('carries Telegram s date through as epoch milliseconds', () => {
    const event = parseUpdate(message({ text: 'hi' }));

    // Telegram sends seconds; every `Instant` in this codebase is milliseconds.
    expect(event.kind === 'text_message' && event.sentAt).toBe(1789000000000);
  });

  it('keeps numeric ids as strings, since they can exceed 2^53', () => {
    const event = parseUpdate(message({ text: 'hi', from: { ...FROM, id: 9007199254740993 } }));

    expect(event.kind === 'text_message' && typeof event.sender.externalId).toBe('string');
  });

  it('treats an edited message as a fresh one rather than ignoring the correction', () => {
    const event = parseUpdate({
      update_id: 800124,
      edited_message: { message_id: 41, from: FROM, chat: PRIVATE_CHAT, text: '13.50 lunch' },
    });

    expect(event.kind).toBe('text_message');
  });

  it('treats a whitespace-only message as non-text', () => {
    const event = parseUpdate(message({ text: '   ' }));

    expect(event.kind).toBe('non_text_message');
  });
});

describe('non-text and scope', () => {
  it('recognises a sticker as a non-text message', () => {
    const event = parseUpdate(message({ sticker: { file_id: 'abc' } }));

    expect(event.kind).toBe('non_text_message');
  });

  it.each(['group', 'supergroup', 'channel'])('flags a %s chat', (type) => {
    const event = parseUpdate(message({ text: '/today', chat: { id: -100123, type } }));

    expect(event.kind).toBe('group_chat');
  });

  it('recognises a successful payment', () => {
    const event = parseUpdate(
      message({ successful_payment: { telegram_payment_charge_id: 'ch_1', total_amount: 250 } }),
    );

    expect(event.kind).toBe('successful_payment');
  });
});

describe('callback queries', () => {
  it('parses a button press', () => {
    const event = parseUpdate({
      update_id: 800125,
      callback_query: {
        id: '4382',
        from: FROM,
        message: { message_id: 42, chat: PRIVATE_CHAT },
        data: 'ob:timezone:Australia/Sydney',
      },
    });

    expect(event).toMatchObject({
      kind: 'callback_query',
      callbackQueryId: '4382',
      data: 'ob:timezone:Australia/Sydney',
    });
  });

  it('ignores a callback with no data — it is not a button we built', () => {
    const event = parseUpdate({
      update_id: 800126,
      callback_query: { id: '4383', from: FROM, message: { message_id: 42, chat: PRIVATE_CHAT } },
    });

    expect(event.kind).toBe('unsupported');
  });

  it('flags a button pressed in a group', () => {
    const event = parseUpdate({
      update_id: 800127,
      callback_query: {
        id: '4384',
        from: FROM,
        message: { message_id: 42, chat: { id: -100123, type: 'supergroup' } },
        data: 'ob:timezone:Australia/Sydney',
      },
    });

    expect(event.kind).toBe('group_chat');
  });
});

describe('everything else', () => {
  it('parses a pre-checkout query', () => {
    const event = parseUpdate({
      update_id: 800128,
      pre_checkout_query: { id: 'pc_1', from: FROM, total_amount: 250, invoice_payload: 'premium' },
    });

    expect(event).toMatchObject({ kind: 'pre_checkout', preCheckoutQueryId: 'pc_1' });
  });

  it.each([
    ['null', null],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an update with no payload', { update_id: 1 }],
    ['a message with no sender', { update_id: 2, message: { message_id: 1, chat: PRIVATE_CHAT } }],
  ])('returns unsupported for %s instead of throwing', (_label, body) => {
    expect(parseUpdate(body).kind).toBe('unsupported');
  });

  it('keeps the update id on a recognisable but unusable update, so it can still be deduped', () => {
    const event = parseUpdate({ update_id: 909, poll_answer: { poll_id: 'p' } });

    expect(event).toEqual({ kind: 'unsupported', updateId: '909' });
  });
});
