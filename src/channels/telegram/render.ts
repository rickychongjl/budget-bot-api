import { formatMoney } from '../../core/allowance/messages';
import type { Period } from '../../core/budgets/budget-service';
import type { UserSettings } from '../../core/identity/identity-service';
import type { AccountSummary, OnboardingPrompt, OnboardingReply } from '../../core/identity/onboarding';
import type { TransactionDirection } from '../../core/ledger/ledger-service';
import type { CurrencyCode, LocalDate, MinorUnits, RefusalCode, Tier } from '../../core/shared/common';
import type { OutboundMessage } from '../../core/shared/messaging';
import { sanitiseDisplayText } from '../../core/shared/text';

/**
 * M7 renders; it never computes. Every number in here arrives already calculated by
 * the module that owns it — this file only decides how it looks on a phone.
 *
 * Two bot-wide rules:
 *   - **Plain text, no `parse_mode`** (phase-4 plan, finding 2). User-supplied text is
 *     run through `sanitiseDisplayText`, which *strips* markup rather than escaping it;
 *     that is only correct because Telegram is never asked to interpret markup.
 *   - **One reply per input step** (M11's shared contract). A branch that wants to say
 *     two things says them in one message.
 */

/** Telegram's hard limit on `sendMessage.text`. */
export const TELEGRAM_MAX_MESSAGE = 4096;

/** Above this, an option list is a numbered prompt instead of a keyboard (open decision 2). */
export const MAX_INLINE_OPTIONS = 4;

/** Telegram rejects `callback_data` longer than this many bytes. */
const MAX_CALLBACK_DATA_BYTES = 64;

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

// ---- refusals -------------------------------------------------------------------

/**
 * One line of copy per refusal code, M11's table.
 *
 * `satisfies Record<RefusalCode, string>` is load-bearing: adding a code to the union
 * in `core/shared/common.ts` without adding a line here fails `npm run typecheck`,
 * rather than surfacing as a raw error in front of a user at runtime.
 */
const REFUSAL_TEXT = {
  ONBOARDING_REQUIRED: 'Send /start first — I need a few details before I can help.',
  INVALID_ARGUMENT: "I couldn't read that one.",
  CATEGORY_NOT_FOUND: "I don't have a category by that name.",
  NO_BUDGET: 'That category has no budget yet. Set one with /budget.',
  DAILY_MESSAGE_LIMIT: "You've used today's messages.",
  FAIR_USE_LIMIT: "That's a lot of messages in a short time — give it a few minutes.",
  CATEGORY_LIMIT: "You've reached your category limit.",
  REMINDER_CATEGORY_LIMIT: "You've reached your reminder limit.",
  TIER_REQUIRED: 'That one is a Premium feature.',
  STALE_ACTION: "That button is out of date — here's where you are now.",
  RESOURCE_NOT_FOUND: "I couldn't find that.",
  NO_TRANSACTIONS: "There's nothing recorded yet.",
  NO_SUBSCRIPTION: "You're on the Free plan — there's no subscription to show.",
  BILLING_UNAVAILABLE: 'Payments are not set up yet.',
  DELIVERY_FAILED: "I couldn't deliver that message.",
  TIMEZONE_IMMUTABLE: "Your timezone is fixed when you set it up and can't be changed.",
  NOT_YET_AVAILABLE: "That one isn't available yet.",
} satisfies Record<RefusalCode, string>;

/**
 * The thrower's `message` wins when it has one — modules write specific, numeric copy
 * (M8's "back at 7:00 am (Australia/Sydney)", M3's archive refusal) that a generic line
 * cannot match. The table is the floor, not the ceiling.
 */
export function renderRefusal(code: RefusalCode, message?: string): OutboundMessage {
  const specific = message?.trim();
  return { text: specific !== undefined && specific !== '' ? specific : REFUSAL_TEXT[code] };
}

export function refusalText(code: RefusalCode): string {
  return REFUSAL_TEXT[code];
}

// ---- onboarding -----------------------------------------------------------------

/**
 * `ob:<step>:<value>` — the callback data M2's machine expects back. `OnboardingInput`
 * carries `step` precisely so a button pressed two steps ago is detectable as stale.
 */
export function onboardingCallbackData(step: string, value: string): string {
  return `ob:${step}:${value}`;
}

export function parseOnboardingCallbackData(
  data: string,
): { step: string; value: string } | null {
  if (!data.startsWith('ob:')) return null;
  const rest = data.slice(3);
  const separator = rest.indexOf(':');
  if (separator === -1) return null;
  // Only the first separator splits: a value may legitimately contain one
  // (`Australia/Sydney` does not, but a category name could).
  return { step: rest.slice(0, separator), value: rest.slice(separator + 1) };
}

export function renderOnboardingReply(reply: OnboardingReply): OutboundMessage {
  switch (reply.kind) {
    case 'prompt':
      return renderPrompt(reply.prompt);
    case 'complete':
    case 'summary':
      return { text: `${reply.text}\n\n${renderAccountSummary(reply.summary)}`.trim() };
    case 'refused': {
      const refusal = renderRefusal(reply.code, reply.message);
      // One reply per step: the correction and the question the user still has to
      // answer travel together, or they would have to press twice to see it.
      if (reply.prompt === null) return refusal;
      const next = renderPrompt(reply.prompt);
      return { text: `${refusal.text}\n\n${next.text}`, ...markupOf(next) };
    }
  }
}

function renderPrompt(prompt: OnboardingPrompt): OutboundMessage {
  if (prompt.options.length === 0) return { text: prompt.text };

  if (prompt.options.length > MAX_INLINE_OPTIONS) {
    // A wall of buttons is unusable on a phone; a numbered list is answerable by
    // typing, which the machine already accepts as free text.
    const list = prompt.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n');
    return { text: `${prompt.text}\n\n${list}` };
  }

  const buttons = prompt.options
    .map((option) => ({
      text: sanitiseDisplayText(option.label),
      callback_data: onboardingCallbackData(prompt.step, option.value),
    }))
    .filter((button) => fitsCallbackData(button.callback_data));

  // Every button dropped for length is still answerable as text, and the prompt text
  // already says what the choices are — so fall back rather than send a partial row.
  if (buttons.length !== prompt.options.length) return { text: prompt.text };

  return {
    text: prompt.text,
    replyMarkup: { inline_keyboard: buttons.map((button) => [button]) } satisfies InlineKeyboardMarkup,
  };
}

export function renderAccountSummary(summary: AccountSummary): string {
  const { settings, tier, categories } = summary;
  const lines = [
    `Plan: ${tier === 'premium' ? 'Premium' : 'Free'}`,
    `Timezone: ${settings.timezone}`,
    `Currency: ${settings.currencyCode}`,
  ];
  if (settings.periodAnchorDate !== null) lines.push(`Budget starts on day: ${settings.periodAnchorDate}`);
  lines.push(`Daily reminder: ${settings.reminderLocalTime}`);

  if (categories.length > 0) {
    lines.push('', 'Categories:');
    for (const category of categories) {
      const cap =
        category.capMinorUnits === null
          ? 'no budget'
          : formatMoney(category.capMinorUnits, settings.currencyCode);
      const reminder = category.reminder ? ', reminder on' : '';
      lines.push(`- ${sanitiseDisplayText(category.name)}: ${cap}${reminder}`);
    }
  }
  return lines.join('\n');
}

// ---- stage 4C's command views ---------------------------------------------------

/**
 * Every figure below arrives already computed. These functions choose wording and
 * order; if one of them ever had to add, divide or compare money, that arithmetic
 * would belong in the module that owns the number (M7: "this module may decide *how*
 * a figure is rendered; never *what* the figure is").
 */

/**
 * `/settings` — **view only this pass** (Ricky, 11 Sep 2026).
 *
 * Timezone is immutable by M2's design and says so; the rest is shown without an edit
 * affordance, because there is no command that writes it. When settings do become
 * editable, the usage lines go here and `/settings` grows a write path — not before.
 */
export function renderSettings(settings: UserSettings, tier: Tier): string {
  const lines = [
    'Your settings',
    '',
    `Plan: ${tier === 'premium' ? 'Premium' : 'Free'}`,
    `Timezone: ${settings.timezone} (fixed when you signed up)`,
    `Currency: ${settings.currencyCode}`,
  ];
  if (settings.periodAnchorDate !== null) {
    lines.push(`Budget cycle starts: ${formatShortDate(settings.periodAnchorDate)} each month`);
  }
  lines.push(`Daily reminder: ${settings.reminderLocalTime}`);
  lines.push('', 'These are fixed for now — I can show them, but not change them yet.');
  return lines.join('\n');
}

export interface CategoryLine {
  name: string;
  capMinorUnits: MinorUnits | null;
  reminder: boolean;
}

export function renderCategoryList(
  lines: readonly CategoryLine[],
  currency: CurrencyCode,
): string {
  if (lines.length === 0) return 'You have no categories yet. Add one with /categories add <name>.';

  const rendered = lines.map((line) => {
    const cap = line.capMinorUnits === null ? 'no budget' : formatMoney(line.capMinorUnits, currency);
    const reminder = line.reminder ? ', reminder on' : '';
    return `- ${sanitiseDisplayText(line.name)}: ${cap}${reminder}`;
  });

  return ['Your categories', '', ...rendered, '', CATEGORY_USAGE].join('\n');
}

export const CATEGORY_USAGE = [
  '/categories add <name>',
  '/categories rename <old> <new>',
  '/categories archive <name>',
].join('\n');

export interface BudgetLine {
  name: string;
  capMinorUnits: MinorUnits;
}

/**
 * `/budget` with no arguments shows the **current-period snapshot** (M4, confirmed
 * 5 Sep).
 *
 * M4's page adds "only differs from the standing rule right after a mid-period change,
 * in which case show both" — but its implementation makes that unreachable:
 * `setCap` updates the standing budget *and* the materialised snapshot for the current
 * cycle in the same call (`default-budget-service.ts:168-174`), precisely so the user's
 * "my budget is 300 now" means now. There is therefore no second figure to show, and a
 * branch rendering one would be dead code pretending to be a feature. The caller
 * resolves snapshot-or-standing before calling; this renders the one number.
 */
export function renderBudgetList(
  lines: readonly BudgetLine[],
  currency: CurrencyCode,
  period: Period,
): string {
  if (lines.length === 0) {
    return 'You have no budgets yet. Set one with /budget <category> <amount>.';
  }

  const rendered = lines.map(
    (line) => `- ${sanitiseDisplayText(line.name)}: ${formatMoney(line.capMinorUnits, currency)}`,
  );

  return [
    `Your budgets for ${formatPeriod(period)}`,
    '',
    ...rendered,
    '',
    'Change one with /budget <category> <amount>.',
  ].join('\n');
}

export interface StatsLine {
  name: string;
  capMinorUnits: MinorUnits;
  spentMinorUnits: MinorUnits;
}

/**
 * `/stats` — plain text (open decision 3, and M11's recommendation). "Left" can go
 * negative; that is M3's arithmetic showing an overspend, not an error to hide.
 */
export function renderStats(
  lines: readonly StatsLine[],
  currency: CurrencyCode,
  period: Period,
): string {
  if (lines.length === 0) {
    return 'You have no budgets yet, so there is nothing to summarise. Set one with /budget.';
  }

  const rendered = lines.map((line) => {
    const left = line.capMinorUnits - line.spentMinorUnits;
    const spent = formatMoney(line.spentMinorUnits, currency);
    const cap = formatMoney(line.capMinorUnits, currency);
    const tail =
      left < 0n ? `${formatMoney(-left, currency)} over` : `${formatMoney(left, currency)} left`;
    return `- ${sanitiseDisplayText(line.name)}: ${spent} of ${cap}, ${tail}`;
  });

  return [`This cycle (${formatPeriod(period)})`, '', ...rendered].join('\n');
}

// ---- history --------------------------------------------------------------------

/** `hist:<cursor>` — the one callback prefix stage 4C introduces. */
export function historyCallbackData(cursor: string): string {
  return `hist:${cursor}`;
}

export function parseHistoryCallbackData(data: string): string | null {
  if (!data.startsWith('hist:')) return null;
  const cursor = data.slice('hist:'.length);
  return cursor === '' ? null : cursor;
}

export interface HistoryLine {
  occurredOn: LocalDate;
  direction: TransactionDirection;
  amountMinorUnits: MinorUnits;
  /** Null for a transaction whose category was removed. */
  categoryName: string | null;
  merchant: string | null;
  note: string | null;
}

/**
 * Forward-only paging: `Page<T>` carries a `nextCursor` and nothing else, so there is
 * no "previous" to offer without changing M3's contract (phase-4 plan, 4C finding 1;
 * Ricky's call, 11 Sep). A chat transcript pages downward anyway.
 *
 * The button is dropped rather than truncated if a cursor will not fit Telegram's
 * 64-byte `callback_data` — a button that silently fails is worse than none.
 */
export function renderHistoryPage(
  lines: readonly HistoryLine[],
  currency: CurrencyCode,
  nextCursor: string | null,
): OutboundMessage {
  if (lines.length === 0) return { text: refusalText('NO_TRANSACTIONS') };

  const rendered = lines.map((line) => {
    const amount = formatMoney(line.amountMinorUnits, currency);
    const sign = line.direction === 'expense' ? '' : `${line.direction} `;
    const where = [line.merchant, line.note]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .map((part) => sanitiseDisplayText(part))
      .join(' — ');
    const category = line.categoryName === null ? 'uncategorised' : sanitiseDisplayText(line.categoryName);
    const tail = where === '' ? category : `${category} — ${where}`;
    return `${formatShortDate(line.occurredOn)}  ${sign}${amount}  ${tail}`;
  });

  const text = ['Recent entries', '', ...rendered].join('\n');

  if (nextCursor === null) return { text };
  const data = historyCallbackData(nextCursor);
  if (!fitsCallbackData(data)) return { text };

  return {
    text,
    replyMarkup: {
      inline_keyboard: [[{ text: 'More', callback_data: data }]],
    } satisfies InlineKeyboardMarkup,
  };
}

// ---- dates ----------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-11` → `11 Sep`. Presentation only; the date itself is M3's. */
export function formatShortDate(localDate: LocalDate): string {
  const [, month, day] = localDate.split('-');
  const name = MONTHS[Number(month) - 1];
  if (name === undefined || day === undefined) return localDate;
  return `${Number(day)} ${name}`;
}

function formatPeriod(period: Period): string {
  return `${formatShortDate(period.start)} – ${formatShortDate(period.end)}`;
}

// ---- pagination -----------------------------------------------------------------

/**
 * Split text into Telegram-sized chunks, preferring a line boundary and never cutting
 * a word in half. A caller that gets more than one chunk sends them in order — that is
 * the one place M11's "one reply per input step" bends, because the alternative is a
 * 400 from the Bot API and no reply at all.
 */
export function paginate(text: string, limit: number = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const cut = lastBreak(window, limit);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

/** Prefer the last newline, then the last space; fall back to a hard cut. */
function lastBreak(window: string, limit: number): number {
  const newline = window.lastIndexOf('\n');
  if (newline > 0) return newline;
  const space = window.lastIndexOf(' ');
  if (space > 0) return space;
  return limit;
}

// ---- helpers --------------------------------------------------------------------

function fitsCallbackData(data: string): boolean {
  return new TextEncoder().encode(data).length <= MAX_CALLBACK_DATA_BYTES;
}

function markupOf(message: OutboundMessage): { replyMarkup?: unknown } {
  return message.replyMarkup === undefined ? {} : { replyMarkup: message.replyMarkup };
}
