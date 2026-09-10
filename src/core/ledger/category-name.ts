import { RefusalError } from '../shared/errors';

/**
 * The category-naming rules, owned by M3 because M3 owns the `category` table and its
 * `unique (user_id, normalized_name)` constraint. Pure — no clock, no DB.
 *
 * M2's onboarding matches user input against `normalizedName` and previously kept its
 * own copy of this function ("mirrors the intent of M3's `normalized_name`"); it now
 * delegates here so there is exactly one definition of what makes two category names
 * the same name.
 */

/** Longest name the bot will store — long enough for real names, short enough to render. */
export const MAX_CATEGORY_NAME_LENGTH = 40;

/**
 * The uniqueness key: case- and whitespace-insensitive. "Eating Out", "eating out"
 * and " EATING  OUT " are one category, which is what a user means by "I already have
 * that one".
 */
export function normalizeCategoryName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The display name as it will be stored: trimmed and whitespace-collapsed, but with
 * the user's own capitalisation kept. Throws `INVALID_ARGUMENT` for a name that is
 * empty, too long, or made only of characters that would vanish when rendered.
 */
export function toCategoryDisplayName(name: string): string {
  const display = name.trim().replace(/\s+/g, ' ');
  if (display === '') {
    throw new RefusalError('INVALID_ARGUMENT', 'A category needs a name.');
  }
  if (display.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new RefusalError(
      'INVALID_ARGUMENT',
      `That name is too long — keep it under ${MAX_CATEGORY_NAME_LENGTH} characters.`,
    );
  }
  if (normalizeCategoryName(display) === '') {
    throw new RefusalError('INVALID_ARGUMENT', 'A category needs a name.');
  }
  return display;
}
