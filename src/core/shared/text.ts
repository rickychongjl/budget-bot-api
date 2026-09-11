/**
 * The one definition of "make this string safe to echo back to a user".
 *
 * Hoisted here by M7 stage 4B, which is the moment M5's build-log predicted: "worth
 * unifying when M7 lands and there are three copies." The two existing copies — M2's
 * private `escapeForPrompt` (`core/identity/onboarding.ts`) and M5's
 * `escapeCategoryName` (`core/allowance/messages.ts`) — now delegate here under their
 * own names, so no module's public surface changes.
 *
 * **This strips, it does not escape**, and that is deliberate. Escaping would put
 * backslashes in front of markup characters, which only renders correctly if the send
 * carries a `parse_mode`; M7 sends every message as plain text (phase-4 plan, finding
 * 2), so a backslash would arrive on the user's screen as a backslash. Removing the
 * characters is correct for a plain-text bot and cannot be defeated by nesting.
 *
 * Pure: same input, same output, no clock, no I/O.
 */

/**
 * The cap every existing caller already applied. A category name is capped at 40 by
 * M3's validation, and no display string this function guards is longer.
 */
export const MAX_DISPLAY_TEXT = 40;

/**
 * Remove control characters and anything Telegram could read as markup, then cap the
 * length. Used wherever user-supplied text (a category name, a merchant, a rejected
 * amount) is echoed inside a message the bot sends.
 */
export function sanitiseDisplayText(value: string, maxLength: number = MAX_DISPLAY_TEXT): string {
  return (
    value
      // C0/C1 control characters — newlines included, so a name cannot forge a second
      // line of the bot's own message.
      .replace(/[\p{Cc}]/gu, '')
      .replace(BIDI_CONTROLS, '')
      // Markdown and HTML markup, in every parse mode Telegram offers.
      .replace(/[*_`[\]<>]/g, '')
      .slice(0, maxLength)
  );
}

/**
 * Bidirectional overrides and isolates. These are `\p{Cf}` (format), **not** `\p{Cc}`,
 * so the original copies of this function let them through: a category name containing
 * U+202E renders the rest of the line right-to-left in the user's chat, which can make
 * a message appear to say something it does not.
 *
 * Listed explicitly rather than stripping all of `\p{Cf}`, because that class also
 * holds the zero-width joiner — and removing that would break a perfectly ordinary
 * emoji in a category name.
 */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
