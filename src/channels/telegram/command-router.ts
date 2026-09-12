import type { DailyAllowanceService } from '../../core/allowance/allowance-service';
import type { ReminderSelectionService } from '../../core/allowance/reminder-selection-service';
import type { BudgetService } from '../../core/budgets/budget-service';
import type { EntitlementService } from '../../core/entitlements/entitlement-service';
import type { IdentityService } from '../../core/identity/identity-service';
import type { OnboardingService } from '../../core/identity/onboarding';
import type { CategoryService } from '../../core/ledger/category-service';
import type { LedgerService } from '../../core/ledger/ledger-service';
import type { Instant, UserId } from '../../core/shared/common';
import type { OutboundMessage } from '../../core/shared/messaging';
import type { GatewayRepository } from './gateway-repository';
import type { TelegramSender } from './update-parser';

/**
 * The command catalogue: one table that is simultaneously the router, the source for
 * `/help`, and (stage 4E) the list handed to `setMyCommands`. One source of truth is
 * what stops the registered `/` menu drifting from the handlers that actually exist —
 * M11's DoD line, "catalogue reflects what was implemented".
 *
 * Handlers call the owning service, render the result, and return one message. They
 * contain no arithmetic and no policy (M7: "if a change here would alter a number the
 * user sees, it belongs somewhere else").
 */

/** What a handler is given. */
export interface CommandContext {
  /**
   * Who sent the update, in Telegram's terms. Only `/start` uses it — `register`
   * needs an `externalId` and a `chatId`, and a handler reached before an account
   * exists has no `userId` to work from. Every other handler works from `userId`;
   * a Telegram identifier must not travel further into the application than this.
   */
  sender: TelegramSender;
  /** Null only for a sender with no account yet; a handler with `requiresAccount` never sees null. */
  userId: UserId | null;
  /**
   * The user id, for the handlers the dispatcher only reaches with one. Throws rather
   * than returning null so a `requiresAccount` handler cannot silently act on nobody —
   * the dispatcher checks `requiresAccount` before calling, so this never fires in
   * practice and exists to keep that guarantee honest instead of casting it away.
   */
  requireUserId(): UserId;
  /** Tokenised arguments, quotes already resolved. */
  args: readonly string[];
  /** Everything after the command word, untokenised. */
  rest: string;
  now: Instant;
  services: CommandServices;
  /** The catalogue itself, so `/help` can list it without importing every handler. */
  router: CommandRouter;
}

/**
 * M2, as the command handlers use it. `register` is `/start`'s; `getSettings` is how
 * almost every other handler learns the user's currency before rendering a figure.
 */
export type CommandIdentity = Pick<IdentityService, 'getSettings' | 'register'>;

/** M2's onboarding machine. The dispatcher owns `answer`; `/start` owns `start`. */
export type CommandOnboarding = Pick<OnboardingService, 'start'>;

/**
 * Every core service a handler may call, and nothing else.
 *
 * Each one is the owning module's *public contract*, never a repository and never a
 * concrete class: a handler's whole job is to call the module that owns the decision
 * and render what comes back. If a handler ever needs something not on this list,
 * that is the signal the behaviour belongs in a core module rather than here.
 */
export interface CommandServices {
  identity: CommandIdentity;
  onboarding: CommandOnboarding;
  entitlements: EntitlementService;
  categories: CategoryService;
  budgets: BudgetService;
  ledger: LedgerService;
  allowance: DailyAllowanceService;
  reminders: ReminderSelectionService;
  gateway: GatewayRepository;
  /** `env.SUPPORT_CONTACT` — shown by `/paysupport`. */
  supportContact: string;
}

export interface CommandHandler {
  /** Without the slash, as Telegram's `setMyCommands` wants it. */
  name: string;
  /** One line, shown in the `/` menu and by `/help`. Telegram caps this at 256 chars. */
  description: string;
  /**
   * Skips `admitMessage` entirely. M11: the management route "must also work when
   * ordinary product messages are capped", and `/help` has "no onboarding
   * prerequisite". These cost no quota and stay reachable at the cap.
   */
  exemptFromAdmission: boolean;
  /** False only for commands answerable before the user has an account. */
  requiresAccount: boolean;
  handle(context: CommandContext): Promise<OutboundMessage>;
}

export class CommandRouter {
  private readonly handlers: Map<string, CommandHandler>;

  constructor(handlers: readonly CommandHandler[]) {
    this.handlers = new Map(handlers.map((handler) => [handler.name, handler]));
  }

  find(name: string): CommandHandler | null {
    return this.handlers.get(name.toLowerCase()) ?? null;
  }

  /** Registration order is menu order; alphabetising it would bury `/start`. */
  all(): readonly CommandHandler[] {
    return [...this.handlers.values()];
  }
}

export interface ParsedCommand {
  /** Lowercased, no slash, `@botname` suffix removed. */
  name: string;
  args: readonly string[];
  rest: string;
}

/**
 * `/budget "Eating Out" 300` → `{ name: 'budget', args: ['Eating Out', '300'] }`.
 *
 * Quoting multiword category names is M11's shared contract. Both quote characters are
 * accepted because phone keyboards produce curly quotes without being asked.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const firstSpace = trimmed.search(/\s/);
  const word = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  // `/help@BudgeBot` — Telegram appends the bot's username in groups, and users copy
  // that form into private chats.
  const name = (word.split('@')[0] ?? '').toLowerCase();
  if (name === '') return null;

  return { name, args: tokenise(rest), rest };
}

const QUOTES = new Set(['"', "'", '“', '”', '‘', '’']);
const CLOSING: Record<string, string> = { '“': '”', '‘': '’' };

function tokenise(rest: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const character of rest) {
    if (quote !== null) {
      if (character === quote || character === CLOSING[quote]) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (QUOTES.has(character)) {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  // An unclosed quote keeps what was typed rather than discarding it — the user meant
  // the words, not the punctuation.
  if (current !== '') tokens.push(current);
  return tokens;
}
