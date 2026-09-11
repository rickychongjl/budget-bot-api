import type { CurrencyCode, MinorUnits } from '../shared/common';
import { formatMinorUnits } from '../shared/money';
import type { AllowanceView } from './allowance-service';

/**
 * M5's message renderers — "Message shape" in `docs/M5-daily-allowance-scheduler.md`.
 *
 * Pure: same views in, same string out. M5 owns the wording because it owns the
 * numbers; M7 escapes nothing further and computes nothing (M7: "this module renders,
 * never computes" — for allowance text, M5 is that module).
 *
 * Tone rule from the plan: a negative figure states the number plainly and says what
 * tomorrow looks like. Consequence, not a scolding — no "you overspent!", no emoji, no
 * exclamation marks.
 */

const MAX_CATEGORY_NAME = 40;

/**
 * Strip anything that could read as Telegram markup or a control character. The same
 * rule as M2's private `escapeForPrompt`; deliberately duplicated rather than hoisted
 * to `core/shared` in this PR, because CLAUDE.md says not to fold a rename sweep into a
 * feature change. Worth unifying when M7 lands and there are three copies.
 */
export function escapeCategoryName(value: string): string {
  return value
    .replace(/[\p{Cc}]/gu, '')
    .replace(/[*_`[\]<>]/g, '')
    .slice(0, MAX_CATEGORY_NAME);
}

/**
 * `$18`, `$18.50`, `AUD 18` for a currency with no symbol we know. A zero fraction is
 * dropped because "$18.00 on Food" reads like a statement line rather than a sentence;
 * a non-zero one is always shown in full.
 */
export function formatMoney(amount: MinorUnits, currency: CurrencyCode): string {
  const negative = amount < 0n;
  const rendered = formatMinorUnits(negative ? -amount : amount, currency);
  const trimmed = rendered.endsWith('.00') ? rendered.slice(0, -3) : rendered;
  const symbol = SYMBOLS[currency.toUpperCase()];
  const body = symbol ? `${symbol}${trimmed}` : `${currency.toUpperCase()} ${trimmed}`;
  return negative ? `-${body}` : body;
}

const SYMBOLS: Record<string, string> = {
  AUD: '$',
  NZD: '$',
  USD: '$',
  CAD: '$',
  SGD: '$',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
};

/** `a`, `a and b`, `a, b and c`. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The line appended to a logging confirmation — one category, one sentence, one
 * number, no preamble.
 */
export function renderAllowanceLine(view: AllowanceView, currency: CurrencyCode): string {
  const name = escapeCategoryName(view.categoryName);
  if (view.availableToday >= 0n) {
    return `You can spend ${formatMoney(view.availableToday, currency)} on ${name} today to stay on budget.`;
  }
  return (
    `You're ${formatMoney(-view.availableToday, currency)} over on ${name} today. ` +
    `Tomorrow's target will be lower to make it back.`
  );
}

/**
 * The 07:00 bundle — one message covering every reminder-eligible category, closing
 * with days remaining in the cycle. `daysLeft` comes straight off the domain formula;
 * every view in a bundle shares a period, so the first one's figure speaks for all.
 *
 * Categories the user is already over on move to their own sentence rather than being
 * read as "you can spend -$4", which is not a sentence anyone parses on a phone.
 */
export function renderBundledReminder(
  views: readonly AllowanceView[],
  currency: CurrencyCode,
): string {
  if (views.length === 0) {
    throw new Error('allowance: refusing to render an empty bundle');
  }

  const within = views.filter((v) => v.availableToday >= 0n);
  const over = views.filter((v) => v.availableToday < 0n);

  const sentences: string[] = [];

  if (within.length > 0) {
    const parts = within.map(
      (v) => `${formatMoney(v.availableToday, currency)} on ${escapeCategoryName(v.categoryName)}`,
    );
    sentences.push(`You can spend ${joinPhrases(parts)} today to stay on budget.`);
  }

  if (over.length > 0) {
    const parts = over.map(
      (v) => `${formatMoney(-v.availableToday, currency)} over on ${escapeCategoryName(v.categoryName)}`,
    );
    sentences.push(`You're ${joinPhrases(parts)}.`);
  }

  sentences.push(renderDaysLeft(views[0]!.daysLeft));

  return sentences.join(' ');
}

function renderDaysLeft(daysLeft: number): string {
  if (daysLeft === 1) return 'Last day of this cycle.';
  return `${daysLeft} days left in this cycle.`;
}
