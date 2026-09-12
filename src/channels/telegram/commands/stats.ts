import type { Id } from '../../../core/shared/common';
import type { CommandContext, CommandHandler } from '../command-router';
import type { StatsLine } from '../render';
import { renderStats } from '../render';
import { nameIndex, requireCategory, today } from './context';

/**
 * `/stats` — this cycle's spend against each cap (M3 + M4).
 *
 * Plain text, per open decision 3 and M11's recommendation: the bot sends without a
 * `parse_mode`, so a merchant literally named `*Woolworths*` cannot corrupt anything.
 * Long output is split by the dispatcher's own `paginate` on the way out, so this
 * handler returns one string and never truncates.
 *
 * **`ensurePeriod` on a read path, deliberately.** `spendInPeriod` needs a
 * `budget_period_id` and `currentBudgets` returns a `Period` without one, so the id has
 * to be materialised. That is already the house pattern rather than a new liberty —
 * M5's `availableToday` calls `ensurePeriod` too, so `/today` has always done this. The
 * upsert is race-safe on `(budget_id, period_key)` and M4 has deliberately no cron
 * opening periods in advance, so materialising on first read is how a period row comes
 * to exist at all. A cycle with nothing logged still reads as "cap applies, nothing
 * spent" — never an error (M4).
 */
export const statsCommand: CommandHandler = {
  name: 'stats',
  description: 'How this cycle is going',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const [name] = context.args;

    const localDate = await today(context, userId);
    const settings = await context.services.identity.getSettings(userId);
    const views = await context.services.budgets.currentBudgets(userId, localDate);

    const wanted = name === undefined ? null : (await requireCategory(context, userId, name)).id;
    const selected = wanted === null ? views : views.filter((view) => view.budget.categoryId === wanted);

    if (selected.length === 0) {
      return {
        text:
          name === undefined
            ? 'You have no budgets yet, so there is nothing to summarise. Set one with /budget.'
            : `"${name}" has no budget yet, so there is nothing to summarise for it.`,
      };
    }

    const names = nameIndex(await context.services.categories.list(userId, { includeArchived: true }));

    const lines: StatsLine[] = await Promise.all(
      selected.map(async (view) => ({
        name: labelOf(view.budget.categoryId, names),
        capMinorUnits: view.capMinorUnits,
        spentMinorUnits: await spendOf(context, userId, view.budget.id, localDate),
      })),
    );

    const period = selected[0]?.period ?? (await context.services.budgets.periodFor(userId, localDate));
    return { text: renderStats(lines, settings.currencyCode, period) };
  },
};

async function spendOf(
  context: CommandContext,
  userId: string,
  budgetId: Id,
  localDate: string,
): Promise<bigint> {
  const period = await context.services.budgets.ensurePeriod(userId, budgetId, localDate);
  return context.services.ledger.spendInPeriod(userId, period.id);
}

function labelOf(categoryId: Id | null, names: Map<Id, string>): string {
  if (categoryId === null) return 'Everything';
  return names.get(categoryId) ?? 'Unknown';
}
