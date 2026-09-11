import type { CommandHandler } from '../command-router';

/**
 * `/cancel` — abandon the uncommitted conversation (M11).
 *
 * Clears `pending_prompt` only. **Onboarding is deliberately not cancelled**: it is
 * resumable by design, and a half-configured account is a worse place to strand
 * someone than an unanswered question.
 *
 * Not admission-exempt — M11 lists `/help`, `/paysupport` and `/subscription` as the
 * management route, not this. `/cancel` acts on the user's own conversation, so it is
 * an ordinary product message.
 */
export const cancelCommand: CommandHandler = {
  name: 'cancel',
  description: 'Drop the question I just asked',
  exemptFromAdmission: false,
  requiresAccount: true,

  async handle(context) {
    const userId = context.requireUserId();
    const open = await context.services.gateway.findPendingPrompt(userId);
    if (open === null) return { text: "There's nothing waiting on an answer." };

    await context.services.gateway.clearPendingPrompt(userId);
    return { text: 'Dropped it. Nothing was recorded.' };
  },
};
