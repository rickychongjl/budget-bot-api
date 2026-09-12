import type { Category } from '../../../core/ledger/category-service';
import type { Id, LocalDate, UserId } from '../../../core/shared/common';
import { RefusalError } from '../../../core/shared/errors';
import { localDateAt } from '../../../core/shared/local-date';
import type { CommandContext } from '../command-router';

/**
 * The three lookups nearly every 4C handler starts with.
 *
 * Each is a call into an owning module plus the smallest possible amount of glue —
 * there is no decision here that a core module does not already make. In particular
 * the name→category lookup goes through M3's `findByName`, which owns normalisation
 * (`normalizeCategoryName`); M7 must not lowercase or trim a category name itself, or
 * the two would drift and `/budget food` would stop finding "Food".
 */

/** The user's own calendar date right now — every period and allowance read needs it. */
export async function today(context: CommandContext, userId: UserId): Promise<LocalDate> {
  const settings = await context.services.identity.getSettings(userId);
  return localDateAt(context.now, settings.timezone);
}

/** Absence is exceptional here: the user named something, and it has to exist. */
export async function requireCategory(
  context: CommandContext,
  userId: UserId,
  name: string,
): Promise<Category> {
  const category = await context.services.categories.findByName(userId, name);
  if (category === null) {
    throw new RefusalError(
      'CATEGORY_NOT_FOUND',
      `You don't have a category called "${name}". /categories shows the ones you do have.`,
    );
  }
  return category;
}

/** `id → display name`, for the handlers that render rows M3 only gives ids for. */
export function nameIndex(categories: readonly Category[]): Map<Id, string> {
  return new Map(categories.map((category) => [category.id, category.name]));
}
