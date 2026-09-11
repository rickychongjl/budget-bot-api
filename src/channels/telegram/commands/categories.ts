import { RefusalError } from '../../../core/shared/errors';
import type { CommandHandler } from '../command-router';
import type { CategoryLine } from '../render';
import { CATEGORY_USAGE, renderCategoryList } from '../render';
import { requireCategory } from './context';

/**
 * `/categories` — list, add, rename, archive (M3).
 *
 *   /categories
 *   /categories add Coffee
 *   /categories rename "Eating Out" Dining
 *   /categories archive Coffee
 *
 * **Arguments rather than an inline keyboard — Ricky's call, 11 Sep 2026.** The stage
 * plan sketched `cat:<action>:<id>` buttons, but a rename needs the new name typed
 * back, and the only place M7 can park "I am waiting for a name" is `pending_prompt`,
 * whose `kind` is `'confirm' | 'clarify'`. A third kind means another migration inside
 * a stage that already adds nine handlers. Quoting a multi-word name is M11's shared
 * contract anyway, and the tokeniser already does it.
 *
 * Every refusal here is thrown by M3 or M8 and rendered by the dispatcher: the capacity
 * limit (M8's `CATEGORY_LIMIT`), and M3's archive gate — a category can only be
 * archived with no transaction in the current cycle. This handler does not pre-check
 * either; a pre-check would be M7 holding an opinion about a number.
 */
export const categoriesCommand: CommandHandler = {
  name: 'categories',
  description: 'List, add, rename or archive categories',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const [action, ...rest] = context.args;

    switch (action?.toLowerCase()) {
      case undefined:
        return { text: await list(context, userId) };

      case 'add': {
        const name = requireArg(rest[0], 'Tell me what to call it: /categories add <name>.');
        const created = await context.services.categories.create(userId, name);
        return { text: `Added ${created.name}. Give it a budget with /budget "${created.name}" <amount>.` };
      }

      case 'rename': {
        const from = requireArg(rest[0], 'Which one? /categories rename <old> <new>.');
        const to = requireArg(rest[1], 'What should it be called? /categories rename <old> <new>.');
        const category = await requireCategory(context, userId, from);
        const renamed = await context.services.categories.rename(userId, category.id, to);
        return { text: `Renamed to ${renamed.name}.` };
      }

      case 'archive': {
        const name = requireArg(rest[0], 'Which one? /categories archive <name>.');
        const category = await requireCategory(context, userId, name);
        await context.services.categories.archive(userId, category.id);
        // M3 clears the reminder flag through M5 on archive; M7 only says so.
        return { text: `Archived ${category.name}. Its history is untouched, and any reminder on it is off.` };
      }

      default:
        throw new RefusalError('INVALID_ARGUMENT', `I don't know "${action}". Try:\n\n${CATEGORY_USAGE}`);
    }
  },
};

async function list(
  context: Parameters<CommandHandler['handle']>[0],
  userId: string,
): Promise<string> {
  const [settings, categories, budgets, reminders] = await Promise.all([
    context.services.identity.getSettings(userId),
    context.services.categories.list(userId),
    context.services.budgets.activeBudgets(userId),
    context.services.reminders.enabledCategoryIds(userId),
  ]);

  const capOf = new Map(
    budgets
      .filter((budget) => budget.categoryId !== null)
      .map((budget) => [budget.categoryId as string, budget.capMinorUnits]),
  );
  const reminding = new Set(reminders);

  const lines: CategoryLine[] = categories.map((category) => ({
    name: category.name,
    capMinorUnits: capOf.get(category.id) ?? null,
    reminder: reminding.has(category.id),
  }));

  return renderCategoryList(lines, settings.currencyCode);
}

function requireArg(value: string | undefined, correction: string): string {
  if (value === undefined || value.trim() === '') {
    throw new RefusalError('INVALID_ARGUMENT', correction);
  }
  return value;
}
