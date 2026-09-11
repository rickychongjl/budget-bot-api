import { formatMoney } from '../../core/allowance/messages';
import type { AccountSummary, OnboardingPrompt, OnboardingReply } from '../../core/identity/onboarding';
import type { RefusalCode } from '../../core/shared/common';
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
