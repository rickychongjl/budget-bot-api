import type { CommandContext, CommandHandler } from '../command-router';

/**
 * `/help` — renders the router's own catalogue, so the list can never describe a
 * command that isn't wired (M11 DoD: "catalogue reflects what was implemented").
 *
 * Exempt from admission: M11 gives `/help` "no onboarding prerequisite", and the way
 * out of a cap must not itself be capped.
 */
export const helpCommand: CommandHandler = {
  name: 'help',
  description: 'What I can do',
  exemptFromAdmission: true,
  requiresAccount: false,

  async handle(context) {
    const [requested] = context.args;
    if (requested !== undefined) {
      const name = requested.replace(/^\//, '').toLowerCase();
      const handler = context.router.find(name);
      if (handler) return { text: `/${handler.name} — ${handler.description}` };
      return { text: `I don't have a /${name}. Here's everything I do know:\n\n${listOf(context)}` };
    }

    return {
      text:
        `Here's what I can do:\n\n${listOf(context)}\n\n` +
        `Or just tell me what you spent, like "12.50 lunch".`,
    };
  },
};

function listOf(context: CommandContext): string {
  return context.router
    .all()
    .map((handler) => `/${handler.name} — ${handler.description}`)
    .join('\n');
}
