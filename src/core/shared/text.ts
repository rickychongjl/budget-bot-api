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
      // Control characters, including the bidi and newline tricks that let a crafted
      // name rearrange the rest of the sentence.
      .replace(/[\p{Cc}]/gu, '')
      // Markdown and HTML markup, in every parse mode Telegram offers.
      .replace(/[*_`[\]<>]/g, '')
      .slice(0, maxLength)
  );
}
