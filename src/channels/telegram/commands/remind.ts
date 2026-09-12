import type { Id } from '../../../core/shared/common';
import { sanitiseDisplayText } from '../../../core/shared/text';
import { RefusalError } from '../../../core/shared/errors';
import type { CommandContext, CommandHandler } from '../command-router';
import { nameIndex, requireCategory } from './context';

/**
 * `/remind` — which categories send the 07:00 reminder (M5 + M8).
 *
 *   /remind              what is on, and what could be
 *   /remind Food         turn Food on, or off if it already is
 *
 * **Only budgeted categories are offered.** M5 refuses `NO_BUDGET` for a category with
 * no active cap — a reminder needs a cap to divide — and M7's own handover note says
 * to offer only budgeted categories "so M5's `NO_BUDGET` never surfaces after the
 * fact". Listing a category that can only fail is a worse answer than not listing it.
 *
 * There is no time to choose: every user gets one fixed 07:00 local send, bundled
 * across categories (M5). This command is purely about *which*.
 */
export const remindCommand: CommandHandler = {
  name: 'remind',
  description: 'Choose which categories remind you at 7am',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const [name, ...extra] = context.args;

    if (extra.length > 0) {
      throw new RefusalError(
        'INVALID_ARGUMENT',
        'Put a multi-word category in quotes, like /remind "Eating Out".',
      );
    }

    if (name === undefined) return { text: await list(context, userId) };

    const category = await requireCategory(context, userId, name);
    const enabled = new Set(await context.services.reminders.enabledCategoryIds(userId));

    if (enabled.has(category.id)) {
      await context.services.reminders.disable(userId, category.id);
      return { text: `${category.name} will not remind you any more.` };
    }

    // M5 still refuses NO_BUDGET if the cap went away between the list and the tap,
    // and M8 still refuses REMINDER_CATEGORY_LIMIT. Both render as their own copy.
    await context.services.reminders.enable(userId, category.id);
    return { text: `${category.name} will remind you at 7:00 each morning.` };
  },
};

async function list(context: CommandContext, userId: string): Promise<string> {
  const [budgets, enabledIds, categories] = await Promise.all([
    context.services.budgets.activeBudgets(userId),
    context.services.reminders.enabledCategoryIds(userId),
    context.services.categories.list(userId),
  ]);

  const names = nameIndex(categories);
  const live = new Set(categories.map((category) => category.id));
  const enabled = new Set(enabledIds);

  // Budgeted, not archived — the exact set M5 will accept.
  const eligible = budgets
    .map((budget) => budget.categoryId)
    .filter((id): id is Id => id !== null && live.has(id));

  if (eligible.length === 0) {
    return 'Reminders need a category with a budget. Set one with /budget <category> <amount>.';
  }

  const lines = eligible.map((id) => {
    const label = sanitiseDisplayText(names.get(id) ?? 'Unknown');
    return enabled.has(id) ? `- ${label} ✓` : `- ${label}`;
  });

  return [
    'Daily reminders at 7:00',
    '',
    ...lines,
    '',
    'Tap one on or off with /remind <category>.',
  ].join('\n');
}
