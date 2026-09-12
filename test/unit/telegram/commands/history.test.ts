import { beforeEach, describe, expect, it } from 'vitest';
import { parseHistoryCallbackData } from '../../../../src/channels/telegram/render';
import { parseUpdate } from '../../../../src/channels/telegram/update-parser';
import type { InlineKeyboardMarkup } from '../../../../src/channels/telegram/render';
import { callbackUpdate, createHarness, reply, replyMessage, USER } from '../harness';
import type { Harness } from '../harness';

/**
 * `/history` — the real paginated read. M11 defers the interactive *editing*, not the
 * read path (master plan §5.8), so there are no Edit buttons and everything else works.
 *
 * Paging is forward-only: `Page<T>` carries a `nextCursor` and nothing else.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function seedEntries(count: number): Promise<void> {
  const food = await h.seedCategory(USER, 'Food', { cap: 600000n });
  for (let i = 0; i < count; i += 1) {
    await h.spend(USER, food, BigInt(100 + i), '2026-09-11');
  }
}

describe('/history', () => {
  it('lists recent entries newest first', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 1250n, '2026-09-10');
    await h.spend(USER, food, 8420n, '2026-09-11');

    const text = await reply(h, '/history');

    expect(text).toContain('Recent entries');
    expect(text).toContain('11 Sep');
    expect(text).toContain('$84.20');
    expect(text).toContain('Food');
    expect(text.indexOf('$84.20')).toBeLessThan(text.indexOf('$12.50'));
  });

  it('refuses an empty history rather than printing a blank list', async () => {
    expect(await reply(h, '/history')).toContain("nothing recorded yet");
  });

  it('offers one More button when there is another page', async () => {
    await seedEntries(12);

    const message = await replyMessage(h, '/history');
    const markup = message.replyMarkup as InlineKeyboardMarkup;

    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0]).toHaveLength(1);
    // Forward only — there is no "previous" to offer without changing M3's contract.
    expect(markup.inline_keyboard[0]![0]!.text).toBe('More');
    expect(parseHistoryCallbackData(markup.inline_keyboard[0]![0]!.callback_data)).not.toBeNull();
  });

  it('offers no button when the page is the last one', async () => {
    await seedEntries(3);

    const message = await replyMessage(h, '/history');

    expect(message.replyMarkup).toBeUndefined();
  });

  it('continues from the cursor when More is pressed', async () => {
    await seedEntries(12);
    const first = await replyMessage(h, '/history');
    const markup = first.replyMarkup as InlineKeyboardMarkup;
    const data = markup.inline_keyboard[0]![0]!.callback_data;

    h.sender.sent.length = 0;
    await h.dispatcher.dispatch(parseUpdate(callbackUpdate(data)));

    const second = h.sender.onlyText;
    expect(second).toContain('Recent entries');
    // A second page, not the first one again.
    expect(second).not.toBe(first.text);
    expect(h.callbacks.answered).toHaveLength(1);
  });

  it('renders a merchant that looks like markup literally', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.ledger.record(USER, {
      direction: 'expense',
      amountMinorUnits: 1250n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-11T02:00:00Z'),
      occurredOn: '2026-09-11',
      categoryId: food,
      merchantDisplay: '*Woolworths*',
      rawText: 'test',
      parseRoute: 'mechanical',
    });

    const text = await reply(h, '/history');

    // Sends carry no `parse_mode`, and `sanitiseDisplayText` strips the characters
    // anyway — belt and braces, because this is the one that corrupts a message.
    expect(text).toContain('Woolworths');
    expect(text).not.toContain('*Woolworths*');
  });

  it('shows an uncategorised entry as such rather than as a blank', async () => {
    await h.ledger.record(USER, {
      direction: 'expense',
      amountMinorUnits: 500n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-11T02:00:00Z'),
      occurredOn: '2026-09-11',
      categoryId: null,
      rawText: 'test',
      parseRoute: 'mechanical',
    });

    expect(await reply(h, '/history')).toContain('uncategorised');
  });
});
