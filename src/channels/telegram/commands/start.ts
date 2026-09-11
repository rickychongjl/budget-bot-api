import type { CommandHandler } from '../command-router';
import { renderOnboardingReply } from '../render';

/**
 * `/start` — sign up, resume a half-finished sign-up, or show a settings summary
 * (M2: "a returning user who sends /start again gets a summary of their settings, not
 * a new account").
 *
 * The one handler with `requiresAccount: false` that *creates* something. Registration
 * is `/start`'s job and only `/start`'s — **Ricky's call, 11 Sep 2026**, closing stage
 * 4B's open question 1. Registering on any first contact would close the
 * pre-registration rate-limit gap that 4B logged, at the price of an `app_user` row for
 * every wrong number and spam bot that ever messages this bot. The gap stays open
 * knowingly; a stranger's other messages still get "Send /start first".
 *
 * `register` is called unconditionally rather than only when `userId` is null, because
 * it is idempotent by contract (M2: "re-running /start must not create a second user")
 * and it is also what **re-activates a `channel_connection`** that the 403 path
 * deactivated. A user who blocked the bot and changed their mind types `/start`, and
 * this is the line that makes that work.
 */
export const startCommand: CommandHandler = {
  name: 'start',
  description: 'Set up your account, or see your settings',
  exemptFromAdmission: false,
  requiresAccount: false,

  async handle(context) {
    const { externalId, chatId, username } = context.sender;
    const resolved = await context.services.identity.register('telegram', externalId, chatId, username);
    // M2 decides whether that is step one of onboarding or a summary; M7 renders it.
    const reply = await context.services.onboarding.start(resolved.userId);
    return renderOnboardingReply(reply);
  },
};
