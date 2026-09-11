import { describe, expect, it } from 'vitest';
import {
  escapeCategoryName,
  formatMoney,
  renderAllowanceLine,
  renderBundledReminder,
  type AllowanceView,
} from '../../../src/core/allowance';

/**
 * The wording M5 owns, because M5 owns the numbers. Pure in, pure out.
 *
 * The tone rule under test throughout: a negative figure states the number plainly and
 * says what tomorrow looks like. Consequence, not a scolding.
 */

function view(overrides: Partial<AllowanceView> = {}): AllowanceView {
  return {
    categoryId: 'cat-1',
    categoryName: 'Food',
    dailyTarget: 1_800n,
    spentToday: 0n,
    availableToday: 1_800n,
    periodEnd: '2026-10-04',
    daysLeft: 12,
    ...overrides,
  };
}

describe('formatMoney', () => {
  it('drops a zero fraction so the number reads as a sentence, not a statement line', () => {
    expect(formatMoney(1_800n, 'AUD')).toBe('$18');
  });

  it('keeps a non-zero fraction in full', () => {
    expect(formatMoney(1_850n, 'AUD')).toBe('$18.50');
    expect(formatMoney(5n, 'AUD')).toBe('$0.05');
  });

  it('renders a negative as a signed amount, not parentheses', () => {
    expect(formatMoney(-450n, 'AUD')).toBe('-$4.50');
  });

  it('respects the currency exponent rather than assuming cents', () => {
    expect(formatMoney(1_800n, 'JPY')).toBe('¥1800');
  });

  it('falls back to the ISO code for a currency with no symbol we know', () => {
    expect(formatMoney(1_800n, 'SEK')).toBe('SEK 18');
  });
});

describe('escapeCategoryName', () => {
  it('strips characters that would corrupt Telegram markup', () => {
    // A category literally named *Woolworths* must not turn the message bold.
    expect(escapeCategoryName('*Woolworths*')).toBe('Woolworths');
    expect(escapeCategoryName('a_b`c[d]e<f>g')).toBe('abcdefg');
  });

  it('strips control characters', () => {
    expect(escapeCategoryName('Food')).toBe('Food');
  });

  it('caps the length so one category cannot dominate a bundle', () => {
    expect(escapeCategoryName('x'.repeat(200))).toHaveLength(40);
  });
});

describe('renderAllowanceLine — the logging confirmation', () => {
  it('is one sentence, one number, no preamble', () => {
    expect(renderAllowanceLine(view({ availableToday: 1_800n }), 'AUD')).toBe(
      'You can spend $18 on Food today to stay on budget.',
    );
  });

  it('states an overspend plainly and says what tomorrow looks like', () => {
    expect(renderAllowanceLine(view({ availableToday: -450n }), 'AUD')).toBe(
      "You're $4.50 over on Food today. Tomorrow's target will be lower to make it back.",
    );
  });

  it('treats exactly zero as still on budget rather than over', () => {
    expect(renderAllowanceLine(view({ availableToday: 0n }), 'AUD')).toContain('You can spend $0');
  });
});

describe('renderBundledReminder — the 07:00 message', () => {
  it('covers every category in one message, closing with days left', () => {
    const text = renderBundledReminder(
      [
        view({ categoryName: 'Food', availableToday: 1_800n }),
        view({ categoryId: 'cat-2', categoryName: 'Fun', availableToday: 4_200n }),
      ],
      'AUD',
    );
    expect(text).toBe(
      'You can spend $18 on Food and $42 on Fun today to stay on budget. 12 days left in this cycle.',
    );
  });

  it('uses an Oxford-free list for three or more categories', () => {
    const text = renderBundledReminder(
      [
        view({ categoryName: 'Food', availableToday: 1_800n }),
        view({ categoryId: 'c2', categoryName: 'Fun', availableToday: 4_200n }),
        view({ categoryId: 'c3', categoryName: 'Transport', availableToday: 900n }),
      ],
      'AUD',
    );
    expect(text).toContain('$18 on Food, $42 on Fun and $9 on Transport');
  });

  it('moves overspent categories into their own sentence rather than saying "spend -$4"', () => {
    const text = renderBundledReminder(
      [
        view({ categoryName: 'Food', availableToday: 1_800n }),
        view({ categoryId: 'c2', categoryName: 'Fun', availableToday: -450n }),
      ],
      'AUD',
    );
    expect(text).toBe(
      'You can spend $18 on Food today to stay on budget. ' +
        "You're $4.50 over on Fun. 12 days left in this cycle.",
    );
  });

  it('is all consequence and no scolding when every category is over', () => {
    const text = renderBundledReminder(
      [
        view({ categoryName: 'Food', availableToday: -100n }),
        view({ categoryId: 'c2', categoryName: 'Fun', availableToday: -450n }),
      ],
      'AUD',
    );
    expect(text).toBe("You're $1 over on Food and $4.50 over on Fun. 12 days left in this cycle.");
    expect(text).not.toContain('!');
  });

  it('says "last day" rather than "1 days left"', () => {
    const text = renderBundledReminder([view({ daysLeft: 1 })], 'AUD');
    expect(text).toContain('Last day of this cycle.');
    expect(text).not.toContain('1 days');
  });

  it('reports the true figure on day one of a cycle, with no special-casing', () => {
    const text = renderBundledReminder([view({ availableToday: 1_600n, daysLeft: 31 })], 'AUD');
    expect(text).toBe('You can spend $16 on Food today to stay on budget. 31 days left in this cycle.');
  });

  it('escapes category names inside the bundle', () => {
    const text = renderBundledReminder([view({ categoryName: '*Food*' })], 'AUD');
    expect(text).toContain('on Food today');
    expect(text).not.toContain('*');
  });

  it('refuses to render an empty bundle rather than sending an empty message', () => {
    // An empty bundle is `skipped` upstream; reaching here at all is a bug.
    expect(() => renderBundledReminder([], 'AUD')).toThrow('empty bundle');
  });
});
