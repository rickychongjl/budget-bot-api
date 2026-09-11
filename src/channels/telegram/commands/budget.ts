import { MoneyError, toMinorUnits } from '../../../core/shared/money';
import { RefusalError } from '../../../core/shared/errors';
import { formatMoney } from '../../../core/allowance/messages';
import type { CommandHandler } from '../command-router';
import type { BudgetLine } from '../render';
import { renderBudgetList } from '../render';
import { nameIndex, requireCategory, today } from './context';

/**
 * `/budget` — view every cap, or set one (M4).
 *
 *   /budget                      every active budget for the current cycle
 *   /budget "Eating Out"         just that one
 *   /budget "Eating Out" 300     set the cap
 *
 * `setCap` writes the standing budget **and** the current period's snapshot, because
 * the user means "my budget is 300 now", not "from next month" (M4). M5 recomputes the
 * daily target the following morning and never rewrites today's — that is M5's rule,
 * and this handler does not try to help.
 *
 * The amount is converted once, by M3's `toMinorUnits`, against the account's own
 * currency. A malformed or over-precise amount refuses **before** anything is written:
 * M11's shared contract is "invalid input returns a precise correction with no partial
 * write", and the conversion happening first is what makes that true here.
 */
export const budgetCommand: CommandHandler = {
  name: 'budget',
  description: 'See or set a category budget',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const [name, amount, ...extra] = context.args;

    if (extra.length > 0) {
      throw new RefusalError(
        'INVALID_ARGUMENT',
        'Put a multi-word category in quotes, like /budget "Eating Out" 300.',
      );
    }

    const settings = await context.services.identity.getSettings(userId);

    if (name !== undefined && amount !== undefined) {
      const category = await requireCategory(context, userId, name);
      const cap = parseAmount(amount, settings.currencyCode);
      const saved = await context.services.budgets.setCap(userId, category.id, cap);
      return {
        text: `${category.name} is now ${formatMoney(saved.capMinorUnits, settings.currencyCode)} a cycle. The daily figure updates tomorrow morning.`,
      };
    }

    const localDate = await today(context, userId);
    const views = await context.services.budgets.currentBudgets(userId, localDate);
    const names = nameIndex(await context.services.categories.list(userId, { includeArchived: true }));

    // The current cycle's snapshot is what the user is actually living under; the
    // standing figure only stands in when nothing has been logged this cycle yet and
    // no snapshot row exists (M4 has deliberately no cron opening periods in advance).
    let lines: BudgetLine[] = views.map((view) => ({
      name: view.budget.categoryId === null ? 'Everything' : names.get(view.budget.categoryId) ?? 'Unknown',
      capMinorUnits: view.snapshotCapMinorUnits ?? view.budget.capMinorUnits,
    }));

    let period = views[0]?.period;

    if (name !== undefined) {
      const category = await requireCategory(context, userId, name);
      const only = views.filter((view) => view.budget.categoryId === category.id);
      period = only[0]?.period ?? period;
      lines = only.map((view) => ({
        name: category.name,
        capMinorUnits: view.snapshotCapMinorUnits ?? view.budget.capMinorUnits,
      }));
      if (lines.length === 0) {
        return { text: `"${category.name}" has no budget yet. Set one with /budget "${category.name}" <amount>.` };
      }
    }

    if (period === undefined) {
      // No budgets at all: M4 has no cycle to name, so ask for the cycle it would go in.
      period = await context.services.budgets.periodFor(userId, localDate);
    }

    return { text: renderBudgetList(lines, settings.currencyCode, period) };
  },
};

/** M3 owns the decimal→minor-units rule; M7 only turns its error into a refusal. */
function parseAmount(amount: string, currency: string): bigint {
  try {
    return toMinorUnits(amount, currency);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new RefusalError('INVALID_ARGUMENT', `I couldn't read "${amount}" as an amount in ${currency}.`);
    }
    throw error;
  }
}
