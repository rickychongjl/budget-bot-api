import type { UserId } from '../../../core/shared/common';
import type { OutboundMessage } from '../../../core/shared/messaging';
import type { CommandHandler, CommandServices } from '../command-router';
import type { HistoryLine } from '../render';
import { renderHistoryPage } from '../render';
import { nameIndex } from './context';

/**
 * `/history` — the paginated read (M3).
 *
 * The *interactive editing* is what M11 defers, on either tier; the read path "was
 * never blocked" (master plan §5.8). So this is real, and there are no Edit buttons.
 *
 * Paging is forward-only: `Page<T>` carries a `nextCursor` and nothing else, so a
 * "previous" button would mean changing M3's public contract and its Drizzle repository
 * from inside an M7 stage — exactly the mixing CLAUDE.md warns against. Ricky's call,
 * 11 Sep 2026: one "More" button.
 */
const PAGE_SIZE = 10;

export const historyCommand: CommandHandler = {
  name: 'history',
  description: 'Look back at what you recorded',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    return historyPage(context.services, context.requireUserId(), null);
  },
};

/**
 * One page, from the start or from a cursor.
 *
 * Exported because the `hist:` callback needs exactly this and must not duplicate it —
 * a "More" button that renders differently from the command it continues is a bug
 * waiting to happen. The cursor is the only thing the button carries, and M3 scopes
 * every read to the `userId` passed here, so a forged or replayed cursor can still only
 * ever return the presser's own rows.
 */
export async function historyPage(
  services: CommandServices,
  userId: UserId,
  cursor: string | null,
): Promise<OutboundMessage> {
  const settings = await services.identity.getSettings(userId);
  const page = await services.ledger.history(
    userId,
    cursor === null ? { limit: PAGE_SIZE } : { cursor, limit: PAGE_SIZE },
  );

  // Archived categories included: a transaction keeps its category, and a row that
  // rendered as "uncategorised" purely because the category was archived would be a
  // lie about the user's own history.
  const names = nameIndex(await services.categories.list(userId, { includeArchived: true }));

  const lines: HistoryLine[] = page.items.map((item) => ({
    occurredOn: item.occurredOn,
    direction: item.direction,
    amountMinorUnits: item.amountMinorUnits,
    categoryName: item.categoryId === null ? null : names.get(item.categoryId) ?? null,
    merchant: item.merchantDisplay,
    note: item.note,
  }));

  return renderHistoryPage(lines, settings.currencyCode, page.nextCursor);
}
