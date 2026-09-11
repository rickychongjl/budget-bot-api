import type { CommandHandler } from '../command-router';
import { refusalText } from '../render';

/**
 * `/export` — the one true stub this pass (M11: "Deferred — Story 7; stub only").
 *
 * `LedgerService.exportCsv` refuses the same way, so this handler is not hiding a
 * capability that exists. The menu description says "coming soon" for the same
 * reason — the `/` menu should not advertise something that cannot do anything yet.
 */
export const exportCommand: CommandHandler = {
  name: 'export',
  description: 'Download your history (coming soon)',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle() {
    return {
      text: `${refusalText('NOT_YET_AVAILABLE')} Downloading your full history is on the list.`,
    };
  },
};
