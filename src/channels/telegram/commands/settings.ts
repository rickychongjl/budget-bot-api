import type { CommandHandler } from '../command-router';
import { renderSettings } from '../render';

/**
 * `/settings` — **view only this pass** (Ricky, 11 Sep 2026).
 *
 * M2 already makes most of this unwritable: timezone is immutable after onboarding,
 * a currency change is refused once the account has any transaction, and the reminder
 * time is fixed at 07:00 with no customisation this pass. That left the budget anchor
 * date as the only genuinely editable field, and Ricky's call was to ship the read and
 * defer the write rather than build an edit path for one field.
 *
 * The accepted cost, recorded so it is not rediscovered as a bug: **a budget start date
 * mistyped during onboarding cannot be corrected without deleting the account.**
 *
 * `CommandServices.identity` is deliberately `Pick<IdentityService, 'getSettings' |
 * 'register'>` — `updateSettings` is not reachable from a handler at all, so this
 * decision is enforced by the compiler rather than by remembering it.
 */
export const settingsCommand: CommandHandler = {
  name: 'settings',
  description: 'See your timezone, currency and budget cycle',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const [settings, tier] = await Promise.all([
      context.services.identity.getSettings(userId),
      context.services.entitlements.tierOf(userId),
    ]);
    return { text: renderSettings(settings, tier) };
  },
};
