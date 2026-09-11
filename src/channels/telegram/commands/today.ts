import { renderAllowanceLine } from '../../../core/allowance/messages';
import type { CommandHandler } from '../command-router';
import { requireCategory } from './context';

/**
 * `/today` — what is still spendable today, per budgeted category (M5).
 *
 * Every figure comes from `availableToday`, including the on-demand compute-and-persist
 * for a category whose row does not exist yet: M5 guarantees the morning reminder and
 * the day's first `/today` agree, and that guarantee only holds if M7 asks M5 rather
 * than working it out. The wording is M5's `renderAllowanceLine` for the same reason.
 *
 * Counts against the daily quota — admission runs before the router reaches this.
 */
export const todayCommand: CommandHandler = {
  name: 'today',
  description: "What you can still spend today",
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const [name] = context.args;

    const categoryId =
      name === undefined ? undefined : (await requireCategory(context, userId, name)).id;

    const settings = await context.services.identity.getSettings(userId);
    const views = await context.services.allowance.availableToday(userId, categoryId);

    if (views.length === 0) {
      return {
        text:
          name === undefined
            ? 'You have no budgets yet, so there is no daily figure to show. Set one with /budget <category> <amount>.'
            : `"${name}" has no budget, so it has no daily figure. Set one with /budget.`,
      };
    }

    return { text: views.map((view) => renderAllowanceLine(view, settings.currencyCode)).join('\n') };
  },
};
