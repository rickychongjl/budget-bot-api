import { formatMoney, renderAllowanceLine } from '../../../core/allowance/messages';
import { RefusalError } from '../../../core/shared/errors';
import type { CommandHandler } from '../command-router';
import { sanitiseDisplayText } from '../../../core/shared/text';

/**
 * `/delete` — soft-delete the last confirmed entry (M3).
 *
 * `deleteLast` picks by `created_at`, not `occurred_on`: "/delete" means "the one I
 * just typed", which may well be a backdated entry.
 *
 * The confirmation carries the updated allowance line, and it gets it by calling
 * `availableToday` **directly**. `AllowanceNotifier.ledgerChanged` is a documented
 * no-op — `available_today` is derived rather than stored, so there is nothing for a
 * notification to have refreshed. Expecting it to have done so would print yesterday's
 * number after a delete.
 */
export const deleteCommand: CommandHandler = {
  name: 'delete',
  description: 'Remove the last thing I recorded',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();

    const removed = await context.services.ledger.deleteLast(userId);
    if (removed === null) {
      throw new RefusalError('NO_TRANSACTIONS', "There's nothing recorded yet, so there's nothing to delete.");
    }

    const settings = await context.services.identity.getSettings(userId);
    const what = sanitiseDisplayText(removed.merchantDisplay ?? removed.note ?? 'that entry');
    const lines = [
      `Removed ${formatMoney(removed.amountMinorUnits, settings.currencyCode)} — ${what}.`,
    ];

    if (removed.categoryId !== null) {
      const views = await context.services.allowance.availableToday(userId, removed.categoryId);
      // A category with no active budget has no allowance row, and that is normal —
      // the delete still happened, it just has no daily figure to report.
      for (const view of views) lines.push(renderAllowanceLine(view, settings.currencyCode));
    }

    return { text: lines.join('\n') };
  },
};
