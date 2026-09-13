import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_OPTIONS,
  TELEGRAM_MAX_MESSAGE,
  confirmCallbackData,
  formatShortDate,
  historyCallbackData,
  mappingCallbackData,
  paginate,
  parseConfirmCallbackData,
  parseHistoryCallbackData,
  parseMappingCallbackData,
  refusalText,
  renderAccountSummary,
  renderConfirmPrompt,
  renderHistoryPage,
  renderMappingQuestion,
  renderOnboardingReply,
  renderRecorded,
  renderRefusal,
} from '../../../src/channels/telegram/render';
import type { AccountSummary, OnboardingPrompt } from '../../../src/core/identity/onboarding';
import type { RefusalCode } from '../../../src/core/shared/common';

/**
 * Rendering is where a plain-text bot either holds the line or leaks markup. These
 * tests are the markdown-injection guard the phase-4 plan asks for, plus the two
 * numbers that are easy to get wrong (4096 and four options).
 */

const SETTINGS: AccountSummary['settings'] = {
  timezone: 'Australia/Sydney',
  currencyCode: 'AUD',
  periodAnchorDate: '2026-09-01',
  reminderLocalTime: '07:00',
  accountCreatedOn: '2026-08-30',
};

function prompt(options: { label: string; value: string }[]): OnboardingPrompt {
  return { step: 'timezone', text: 'Which timezone are you in?', options };
}

describe('markup can never reach Telegram', () => {
  it.each([
    ['*Woolworths*', 'Woolworths'],
    ['[click](https://evil.example)', 'click(https://evil.example)'],
    ['<b>bold</b>', 'bbold/b'],
    ['back`tick`', 'backtick'],
    ['under_score_', 'underscore'],
  ])('renders %s literally', (name, expected) => {
    const summary: AccountSummary = {
      settings: SETTINGS,
      tier: 'free',
      categories: [{ id: 'c1', name, capMinorUnits: 30000n, reminder: false }],
    };

    const text = renderAccountSummary(summary);

    expect(text).toContain(expected);
    // Nothing that survives can be read as markup by any parse mode.
    expect(text).not.toMatch(/[*_`[\]<>]/);
  });

  it('strips control characters that could rearrange the sentence', () => {
    const summary: AccountSummary = {
      settings: SETTINGS,
      tier: 'free',
      categories: [{ id: 'c1', name: 'Food‮gnihtemos‭', capMinorUnits: null, reminder: false }],
    };

    expect(renderAccountSummary(summary)).not.toMatch(/[‪-‮]/);
  });
});

describe('refusal copy', () => {
  const codes: RefusalCode[] = [
    'ONBOARDING_REQUIRED',
    'INVALID_ARGUMENT',
    'CATEGORY_NOT_FOUND',
    'NO_BUDGET',
    'DAILY_MESSAGE_LIMIT',
    'FAIR_USE_LIMIT',
    'CATEGORY_LIMIT',
    'REMINDER_CATEGORY_LIMIT',
    'TIER_REQUIRED',
    'STALE_ACTION',
    'RESOURCE_NOT_FOUND',
    'NO_TRANSACTIONS',
    'NO_SUBSCRIPTION',
    'BILLING_UNAVAILABLE',
    'DELIVERY_FAILED',
    'TIMEZONE_IMMUTABLE',
    'NOT_YET_AVAILABLE',
  ];

  it.each(codes)('%s has copy a user can read', (code) => {
    const text = refusalText(code);

    expect(text.length).toBeGreaterThan(10);
    // The code itself is never the message — M11: "rendered by M7, never a raw error".
    expect(text).not.toContain(code);
  });

  it("prefers the thrower's own message, which carries the specifics", () => {
    const message = "You've used your 5 messages today. Your limit resets at 12:00 am (Australia/Sydney).";

    expect(renderRefusal('DAILY_MESSAGE_LIMIT', message).text).toBe(message);
  });

  it('falls back to the table when the thrower had nothing to add', () => {
    expect(renderRefusal('NO_BUDGET', '   ').text).toBe(refusalText('NO_BUDGET'));
  });
});

describe('onboarding prompts', () => {
  it(`renders ${MAX_INLINE_OPTIONS} options as an inline keyboard`, () => {
    const options = Array.from({ length: MAX_INLINE_OPTIONS }, (_, i) => ({
      label: `Zone ${i}`,
      value: `zone-${i}`,
    }));

    const message = renderOnboardingReply({ kind: 'prompt', prompt: prompt(options) });

    expect(message.replyMarkup).toEqual({
      inline_keyboard: options.map((option) => [
        { text: option.label, callback_data: `ob:timezone:${option.value}` },
      ]),
    });
  });

  it(`renders ${MAX_INLINE_OPTIONS + 1} options as a numbered list instead`, () => {
    const options = Array.from({ length: MAX_INLINE_OPTIONS + 1 }, (_, i) => ({
      label: `Zone ${i}`,
      value: `zone-${i}`,
    }));

    const message = renderOnboardingReply({ kind: 'prompt', prompt: prompt(options) });

    expect(message.replyMarkup).toBeUndefined();
    expect(message.text).toContain('1. Zone 0');
    expect(message.text).toContain(`${options.length}. Zone ${options.length - 1}`);
  });

  it('falls back to plain text when a value will not fit in callback_data', () => {
    const message = renderOnboardingReply({
      kind: 'prompt',
      prompt: prompt([{ label: 'Long', value: 'x'.repeat(200) }]),
    });

    // Telegram caps callback_data at 64 bytes; a partial keyboard would be worse than none.
    expect(message.replyMarkup).toBeUndefined();
  });

  it('keeps a refusal and the next question in one message', () => {
    const message = renderOnboardingReply({
      kind: 'refused',
      code: 'INVALID_ARGUMENT',
      message: "That isn't a date I recognise.",
      prompt: prompt([]),
    });

    expect(message.text).toContain("That isn't a date I recognise.");
    expect(message.text).toContain('Which timezone are you in?');
  });
});

describe('pagination', () => {
  it('leaves a short message alone', () => {
    expect(paginate('short')).toEqual(['short']);
  });

  it('splits on a line boundary', () => {
    const line = `${'a'.repeat(99)}\n`;
    const text = line.repeat(60); // ~6000 characters

    const chunks = paginate(text, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    // Every chunk is whole lines — no line is cut in half.
    for (const chunk of chunks) {
      for (const l of chunk.split('\n')) expect([0, 99]).toContain(l.length);
    }
  });

  it('never splits mid-word when there are no line breaks', () => {
    const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');

    const chunks = paginate(text, 100);

    expect(chunks.join(' ').split(/\s+/)).toEqual(text.split(' '));
  });

  it('defaults to Telegram s own limit', () => {
    expect(TELEGRAM_MAX_MESSAGE).toBe(4096);
    expect(paginate('x'.repeat(5000)).every((c) => c.length <= 4096)).toBe(true);
  });
});

// ---- stage 4C's views -----------------------------------------------------------

describe('history paging', () => {
  const line = {
    occurredOn: '2026-09-11',
    direction: 'expense' as const,
    amountMinorUnits: 1250n,
    categoryName: 'Food',
    merchant: null,
    note: null,
  };

  it('round-trips a cursor through the callback data', () => {
    expect(parseHistoryCallbackData(historyCallbackData('abc123'))).toBe('abc123');
  });

  it('ignores a prefix it does not own, and an empty cursor', () => {
    expect(parseHistoryCallbackData('ob:timezone:Australia/Sydney')).toBeNull();
    expect(parseHistoryCallbackData('hist:')).toBeNull();
  });

  it('drops the button rather than sending a cursor Telegram will reject', () => {
    // Telegram caps `callback_data` at 64 bytes and rejects the whole send above it.
    // A page with no button is recoverable; a 400 is a reply the user never sees.
    const message = renderHistoryPage([line], 'AUD', 'x'.repeat(200));

    expect(message.text).toContain('Food');
    expect(message.replyMarkup).toBeUndefined();
  });

  it('keeps a cursor that fits', () => {
    const message = renderHistoryPage([line], 'AUD', 'cursor-1');

    expect(message.replyMarkup).toBeDefined();
  });
});

describe('short dates', () => {
  it('reads as a date a person would say', () => {
    expect(formatShortDate('2026-09-11')).toBe('11 Sep');
    expect(formatShortDate('2026-01-05')).toBe('5 Jan');
    expect(formatShortDate('2026-12-31')).toBe('31 Dec');
  });

  it('returns anything unparseable unchanged rather than inventing a month', () => {
    expect(formatShortDate('not-a-date')).toBe('not-a-date');
  });
});

// ---- stage 4D ---------------------------------------------------------------------

describe('recorded confirmations', () => {
  const TODAY = '2026-09-11';

  const expense = {
    direction: 'expense' as const,
    amountMinorUnits: 1250n,
    occurredOn: TODAY,
    merchant: 'Woolworths',
    categoryName: 'Groceries',
  };

  it('leads with what was recorded', () => {
    expect(renderRecorded(expense, 'AUD', TODAY)).toBe('Recorded $12.50 at Woolworths under Groceries.');
  });

  it('names the day only when it is not today', () => {
    expect(renderRecorded({ ...expense, occurredOn: '2026-09-10' }, 'AUD', TODAY)).toBe(
      'Recorded $12.50 at Woolworths under Groceries, yesterday.',
    );
    expect(renderRecorded({ ...expense, occurredOn: '2026-09-05' }, 'AUD', TODAY)).toBe(
      'Recorded $12.50 at Woolworths under Groceries, on 5 Sep.',
    );
  });

  it('says income without a category, because income never offsets a cap', () => {
    const line = renderRecorded(
      { direction: 'income', amountMinorUnits: 250000n, occurredOn: TODAY, merchant: null, categoryName: null },
      'AUD',
      TODAY,
    );

    expect(line).toBe('Recorded $2500 income.');
    expect(line).not.toContain('uncategorised');
  });

  it('words a refund as a refund', () => {
    expect(renderRecorded({ ...expense, direction: 'refund' }, 'AUD', TODAY)).toBe(
      'Recorded a $12.50 refund from Woolworths to Groceries.',
    );
  });

  it('says so when an expense has no category rather than quietly omitting it', () => {
    expect(renderRecorded({ ...expense, categoryName: null }, 'AUD', TODAY)).toBe(
      'Recorded $12.50 at Woolworths (uncategorised).',
    );
  });

  it('renders a merchant named like markup literally', () => {
    const line = renderRecorded({ ...expense, merchant: '*Woolworths*' }, 'AUD', TODAY);

    expect(line).toContain('at Woolworths under');
    expect(line).not.toContain('*');
  });
});

describe('confirm prompt', () => {
  const TODAY = '2026-09-11';

  it('asks before recording, with buttons and a typed fallback', () => {
    const message = renderConfirmPrompt(
      {
        direction: 'expense',
        amountMinorUnits: 8950n,
        occurredOn: TODAY,
        merchant: 'Bunnings',
        categoryName: 'Shopping',
      },
      'AUD',
      TODAY,
    );

    expect(message.text).toContain('Should I record $89.50 at Bunnings under Shopping?');
    // M11: every keyboard is answerable by typing — an old message scrolled out of
    // reach still has to be answerable.
    expect(message.text).toContain('reply yes or no');
    expect(message.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'pc:yes' },
          { text: 'No', callback_data: 'pc:no' },
        ],
      ],
    });
  });
});

describe('mapping question', () => {
  const proposal = {
    normalizedMerchant: 'woolies',
    displayMerchant: 'Woolworths',
    categoryName: 'Groceries',
    categoryId: 'cat-groceries',
  };

  it("uses M6's copy and rides on the confirmation it follows", () => {
    const message = renderMappingQuestion(proposal, 'Recorded $12.50 at Woolworths under Groceries.');

    expect(message.text).toBe(
      'Recorded $12.50 at Woolworths under Groceries.\n\nAlways categorise Woolworths as Groceries?',
    );
    expect(message.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'map:yes' },
          { text: 'No', callback_data: 'map:no' },
        ],
      ],
    });
  });

  it('stands alone when there is nothing to lead with', () => {
    expect(renderMappingQuestion(proposal).text).toBe('Always categorise Woolworths as Groceries?');
  });

  it('strips markup from a merchant and a category name', () => {
    const message = renderMappingQuestion({ ...proposal, displayMerchant: '[x](y)', categoryName: '<b>Food' });

    expect(message.text).toBe('Always categorise x(y) as bFood?');
  });
});

describe('yes/no callback data', () => {
  it('round-trips both prefixes', () => {
    expect(parseConfirmCallbackData(confirmCallbackData(true))).toBe(true);
    expect(parseConfirmCallbackData(confirmCallbackData(false))).toBe(false);
    expect(parseMappingCallbackData(mappingCallbackData(true))).toBe(true);
    expect(parseMappingCallbackData(mappingCallbackData(false))).toBe(false);
  });

  it('never reads one prefix as the other, or anything else as an answer', () => {
    expect(parseConfirmCallbackData('map:yes')).toBeNull();
    expect(parseMappingCallbackData('pc:yes')).toBeNull();
    expect(parseConfirmCallbackData('pc:maybe')).toBeNull();
    expect(parseConfirmCallbackData('hist:abc')).toBeNull();
    expect(parseMappingCallbackData('')).toBeNull();
  });

  it('fits Telegram’s 64-byte callback_data cap with room to spare', () => {
    for (const data of ['pc:yes', 'pc:no', 'map:yes', 'map:no']) {
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
  });
});
