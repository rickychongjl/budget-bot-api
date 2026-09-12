import { CommandRouter } from '../command-router';
import {
  paysupportCommand,
  subscribeCommand,
  subscriptionCommand,
  upgradeCommand,
} from './billing';
import { budgetCommand } from './budget';
import { cancelCommand } from './cancel';
import { categoriesCommand } from './categories';
import { deleteCommand } from './delete';
import { exportCommand } from './export';
import { helpCommand } from './help';
import { historyCommand } from './history';
import { remindCommand } from './remind';
import { settingsCommand } from './settings';
import { startCommand } from './start';
import { statsCommand } from './stats';
import { todayCommand } from './today';

/**
 * The command catalogue — all sixteen, as approved by Ricky on 11 Sep 2026.
 *
 * Stage 4C completed it: the nine product commands joined 4B's spine set. One table is
 * simultaneously the router, `/help`'s source, and (stage 4E) the list handed to
 * `setMyCommands`, which is what stops the registered `/` menu from drifting away from
 * the handlers that exist — M11's DoD line, "catalogue reflects what was implemented".
 *
 * **Registration order is menu order**, and it is deliberate rather than alphabetical:
 * `/start` first because it is the only way in, then the commands used daily, then the
 * management route, then the one true stub. Alphabetising would bury `/start` between
 * `/settings` and `/stats`.
 *
 * `/export` is still the only stub, and its description says "coming soon" so the menu
 * does not advertise something that cannot do anything.
 */
export function createCatalogue(): CommandRouter {
  return new CommandRouter([
    startCommand,
    todayCommand,
    budgetCommand,
    statsCommand,
    historyCommand,
    deleteCommand,
    categoriesCommand,
    remindCommand,
    settingsCommand,
    helpCommand,
    cancelCommand,
    subscriptionCommand,
    upgradeCommand,
    subscribeCommand,
    paysupportCommand,
    exportCommand,
  ]);
}

/** Open decision 1's default: short, and points at the one command that explains the rest. */
export const UNKNOWN_COMMAND = "I don't know that one — try /help.";
