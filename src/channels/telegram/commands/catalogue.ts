import { CommandRouter } from '../command-router';
import {
  paysupportCommand,
  subscribeCommand,
  subscriptionCommand,
  upgradeCommand,
} from './billing';
import { cancelCommand } from './cancel';
import { exportCommand } from './export';
import { helpCommand } from './help';

/**
 * The command catalogue as it stands after stage 4B.
 *
 * 4B ships the cheapest end-to-end proof that the spine works: `/help`, `/cancel`, the
 * one true stub (`/export`), and the billing quartet — each either needs no other
 * module or needs only M8's tier. The nine product commands (`/start`, `/today`,
 * `/budget`, `/categories`, `/settings`, `/stats`, `/delete`, `/remind`, `/history`)
 * land in stage 4C, one file each, and register themselves here.
 *
 * Until then an unlisted command gets `UNKNOWN_COMMAND` rather than a stub that
 * pretends to be implemented, and `setMyCommands` is not called until 4E — so nothing
 * advertises a command that does not exist yet. Registration order is menu order.
 */
export function createCatalogue(): CommandRouter {
  return new CommandRouter([
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
