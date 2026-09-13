import type { DailyAllowanceService } from '../../core/allowance/allowance-service';
import type { ReminderSelectionService } from '../../core/allowance/reminder-selection-service';
import type { BudgetService } from '../../core/budgets/budget-service';
import { isEntitlementRefusal } from '../../core/entitlements/entitlement-service';
import type { EntitlementService } from '../../core/entitlements/entitlement-service';
import type { ChannelConnectionDirectory } from '../../core/identity/channel-connection-directory';
import type { IdentityService, ResolvedUser } from '../../core/identity/identity-service';
import type { OnboardingInput, OnboardingService } from '../../core/identity/onboarding';
import { ONBOARDING_STEPS } from '../../core/identity/onboarding-step';
import type { OnboardingStep } from '../../core/identity/onboarding-step';
import type { CategoryService } from '../../core/ledger/category-service';
import type { LedgerService } from '../../core/ledger/ledger-service';
import type { Clock } from '../../core/shared/clock';
import type { Instant, UserId } from '../../core/shared/common';
import { RefusalError } from '../../core/shared/errors';
import type { ChannelConnection, MessageSender, OutboundMessage } from '../../core/shared/messaging';
import type { Logger } from '../../observability/log';
import { startTimer, timed } from '../../observability/timing';
import type { CommandHandler, CommandRouter, CommandServices } from './command-router';
import { parseCommand } from './command-router';
import { UNKNOWN_COMMAND } from './commands/catalogue';
import { historyPage } from './commands/history';
import type { GatewayRepository } from './gateway-repository';
import {
  paginate,
  parseConfirmCallbackData,
  parseHistoryCallbackData,
  parseMappingCallbackData,
  parseOnboardingCallbackData,
  renderOnboardingReply,
  renderRefusal,
} from './render';
import type { TelegramEvent, TelegramSender } from './update-parser';

/** Every event except the ones the parser already decided are not for us. */
type RoutableEvent = Exclude<TelegramEvent, { kind: 'unsupported' }>;

/**
 * Everything that happens after the webhook has returned 200 — this is what
 * `ctx.waitUntil` runs.
 *
 * The routing order is **M11's, not M7's page order**: a recognised slash command or
 * callback wins over a pending clarification. M7's own page says so explicitly ("M11
 * (5 Sep) explicitly revises step 2 vs. step 3"), and `/cancel`, `/help`,
 * `/subscription` and `/paysupport` reaching the user during an open prompt is exactly
 * the case the original ordering got wrong.
 *
 *   1. Group/channel chat        → private-chat instruction, never account data
 *   2. Resolve the user (M2)     → no account: only `requiresAccount: false` commands
 *   3. Admit the message (M8)    → except the admission-exempt commands
 *   4. Callback / payment events → routed explicitly, before the media fallback
 *   5. Non-text message          → "text only"
 *   6. A known slash command     → the router, *even if a prompt is open*
 *   7. Mid-onboarding            → M2's onboarding machine
 *   8. An open `pending_prompt`  → the answer path (stage 4D)
 *   9. Free text                 → M6's parsing pipeline (stage 4D)
 *
 * Every branch ends in exactly one send (M11: "one conversational reply per input
 * step"), and every failure ends in exactly one apology.
 *
 * **Stage timing (M9).** Each step above that can block — the identity read, the
 * admission transaction, the onboarding machine, the pending-prompt read, the
 * free-text path — is wrapped in a `telegram.dispatch.*` line carrying the update id
 * and a duration, and `dispatch` closes with `telegram.dispatch.complete` giving the
 * total since the webhook received the update. One `wrangler tail` session therefore
 * shows a message's total and its breakdown without arithmetic. Durations and stage
 * names only: no message text, no category or merchant names, no chat id.
 */

/**
 * M2's surfaces, as this module uses them.
 *
 * `resolve` and `deactivateConnection` are the dispatcher's own; `register` and
 * `getSettings` are the command handlers', passed straight through. One collaborator
 * rather than two fields, because they are one module.
 */
export type IdentityCollaborator = Pick<IdentityService, 'resolve' | 'register' | 'getSettings'> &
  Pick<ChannelConnectionDirectory, 'deactivateConnection'>;

/** Acknowledging a callback query is a Telegram-transport concern, not a routing one. */
export interface CallbackAcknowledger {
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
}

/**
 * The free-text path (stage 4D). The dispatcher decides *when* a message is free
 * text, an answer to an open question, or a press of one of the two buttons that
 * path puts on screen; everything after that — M6, the prompt row, the wording — is
 * behind this seam.
 *
 * Every method returns exactly one message, including its failure cases: a stale
 * button and an undecodable prompt both answer `STALE_ACTION` rather than throwing.
 *
 * **No `now` is passed.** The dispatcher's `now` is the sender's timestamp off the
 * Telegram update, which is the right clock for M8's admission windows and the wrong
 * one here: M6 stamps a transaction from its own injected `Clock`, so a handler
 * deciding "was this today?" against Telegram's timestamp can call an entry
 * yesterday's on the strength of a few seconds' skew across a local midnight. This
 * path uses the same clock that stamped the row.
 */
export interface FreeTextHandler {
  handleFreeText(userId: UserId, text: string): Promise<OutboundMessage>;
  handlePromptAnswer(userId: UserId, text: string): Promise<OutboundMessage>;
  /** `pc:yes` / `pc:no` — record the candidate the bot asked about, or drop it. */
  answerConfirm(userId: UserId, yes: boolean): Promise<OutboundMessage>;
  /** `map:yes` / `map:no` — remember this merchant's category, or keep asking. */
  answerMapping(userId: UserId, yes: boolean): Promise<OutboundMessage>;
}

export interface DispatcherDeps {
  identity: IdentityCollaborator;
  entitlements: EntitlementService;
  onboarding: OnboardingService;
  /** The four M3/M4/M5 contracts the 4C handlers call. The dispatcher itself uses none of them. */
  categories: CategoryService;
  budgets: BudgetService;
  ledger: LedgerService;
  allowance: DailyAllowanceService;
  reminders: ReminderSelectionService;
  gateway: GatewayRepository;
  router: CommandRouter;
  sender: MessageSender;
  callbacks: CallbackAcknowledger;
  clock: Clock;
  logger: Logger;
  supportContact: string;
  freeText: FreeTextHandler;
}

const CHANNEL = 'telegram' as const;

export const GROUP_CHAT_REPLY =
  'I only work in a private chat — message me directly and I can help.';
export const TEXT_ONLY_REPLY = "I can only read text messages. Tell me what you spent, like \"12.50 lunch\".";
export const PAYMENTS_NOT_LIVE_REPLY =
  "Payments aren't live yet, so I can't take that. Nothing was charged.";
export const APOLOGY =
  "Something went wrong on my end and I couldn't finish that. Try again in a moment.";

export class TelegramDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /**
   * Never throws. The webhook has already answered 200, so an exception here would
   * become an unhandled rejection inside `waitUntil` and the user would simply hear
   * nothing back.
   *
   * `receivedAt` is the instant the webhook took delivery, passed so the closing
   * timing line can report the whole lifecycle. Optional: a caller that dispatches an
   * event from anywhere else (tests, a replay) simply gets this call's own duration.
   */
  async dispatch(event: TelegramEvent, receivedAt?: Instant): Promise<void> {
    if (event.kind === 'unsupported') return;

    const startedAt = receivedAt ?? this.deps.clock.now();
    const sinceReceipt = (): number => Math.max(0, this.deps.clock.now() - startedAt);
    let failed = false;

    const chatId = event.sender.chatId;
    // Captured as `route` resolves it, so both the reply path and the failure path can
    // deactivate the right connection on a 403.
    let userId: UserId | null = null;
    const remember = (id: UserId | null): void => {
      userId = id;
    };

    try {
      const routeElapsed = startTimer(this.deps.clock);
      const message = await this.route(event, remember);
      // How long the routing decision itself took — steps 1-9 above, every database
      // read they made included. `replied` says whether a branch chose to say nothing.
      this.deps.logger.log('info', 'telegram.dispatch.routed', {
        updateId: event.updateId,
        replied: message !== null,
        ms: routeElapsed(),
      });
      if (message !== null) {
        await timed(this.deps.logger, this.deps.clock, 'telegram.dispatch.sent', () =>
          this.send(chatId, message, userId),
        );
      }
    } catch (error) {
      failed = true;
      // A refusal is an answer, not a failure: modules throw `RefusalError` /
      // `EntitlementRefusal` with copy written for the user, and M11 requires it be
      // rendered rather than surfacing as a raw error.
      const refusal = renderThrown(error);
      if (refusal === null) {
        this.deps.logger.log('error', 'telegram.dispatch.failed', {
          updateId: event.updateId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
      // Exactly one message either way — the branch that threw sent nothing.
      await this.send(chatId, refusal ?? { text: APOLOGY }, userId).catch(() => undefined);
    }

    // The one line that answers "how long did that message take?" — everything from
    // the webhook taking delivery to the reply being on its way. Read it against the
    // `telegram.*` / `parse.*` / `llm_parse_ok` stage lines above it in the tail.
    this.deps.logger.log('info', 'telegram.dispatch.complete', {
      updateId: event.updateId,
      ok: !failed,
      ms: sinceReceipt(),
    });
  }

  /** Returns the single reply to send, or null when the branch deliberately says nothing. */
  private async route(
    event: RoutableEvent,
    remember: (userId: UserId | null) => void,
  ): Promise<OutboundMessage | null> {
    // 1. Group or channel. Answered without resolving anyone: M11's shared contract
    //    says such a request never sees account data, and resolving is account data.
    if (event.kind === 'group_chat') return { text: GROUP_CHAT_REPLY };

    const now = event.sentAt ?? this.deps.clock.now();

    // 2. Who is this? Null means no account yet — not an error, just a stranger.
    const resolved = await timed(
      this.deps.logger,
      this.deps.clock,
      'telegram.dispatch.resolved',
      () => this.deps.identity.resolve(CHANNEL, event.sender.externalId),
      { updateId: event.updateId },
    );

    remember(resolved?.userId ?? null);

    // A command has to be parsed before admission, because whether it is exempt is a
    // property of the command.
    const parsed = event.kind === 'text_message' ? parseCommand(event.text) : null;
    const command = parsed === null ? null : this.deps.router.find(parsed.name);

    if (resolved === null) {
      if (command !== null && !command.requiresAccount) {
        return this.runCommand(command, parsed, event.sender, null, now);
      }
      // Pre-registration senders are not rate-limited: `usage_counter` is keyed on a
      // `user_id` that does not exist yet. `inbound_update` still stops a Telegram
      // redelivery from being answered twice. Registering on first contact is what
      // would close this, and that is `/start`'s job — stage 4C.
      return renderRefusal('ONBOARDING_REQUIRED');
    }

    // 3. Admission (M8), the first gate after resolution — except for the management
    //    commands, which must stay reachable at the cap.
    if (command === null || !command.exemptFromAdmission) {
      // M8's admission is a multi-query transaction — the second-largest block of
      // database time a plain message pays for, after the parse itself.
      const refusal = await timed(
        this.deps.logger,
        this.deps.clock,
        'telegram.dispatch.admitted',
        () => this.admit(resolved, event.updateId, now),
        { updateId: event.updateId },
      );
      if (refusal !== undefined) return refusal;
    }

    // 4. Explicit events, before any text fallback.
    if (event.kind === 'callback_query') {
      await this.deps.callbacks.answerCallbackQuery(event.callbackQueryId);
      return this.routeCallback(resolved, event.data);
    }
    if (event.kind === 'pre_checkout' || event.kind === 'successful_payment') {
      return { text: PAYMENTS_NOT_LIVE_REPLY };
    }

    // 5. Stickers, photos, voice notes.
    if (event.kind === 'non_text_message') return { text: TEXT_ONLY_REPLY };

    // 6. A known command wins over an open prompt (M11's revision).
    if (parsed !== null) {
      if (command === null) return { text: UNKNOWN_COMMAND };
      return this.runCommand(command, parsed, event.sender, resolved.userId, now);
    }

    // 7. Still signing up: every message is an answer to the current step.
    if (!resolved.onboarded) {
      // M2's machine runs several reads and writes per step; it is measured as one
      // stage because its internals are core code with no logger of their own.
      const reply = await timed(
        this.deps.logger,
        this.deps.clock,
        'telegram.dispatch.onboarding',
        () => this.deps.onboarding.answer(resolved.userId, { value: event.text }),
        { updateId: event.updateId },
      );
      return renderOnboardingReply(reply);
    }

    // 8. An open question takes the next free-text message as its answer.
    const promptElapsed = startTimer(this.deps.clock);
    const open = await this.deps.gateway.findPendingPrompt(resolved.userId);
    this.deps.logger.log('info', 'telegram.dispatch.prompt_checked', {
      updateId: event.updateId,
      open: open !== null,
      ms: promptElapsed(),
    });
    if (open !== null) {
      return timed(
        this.deps.logger,
        this.deps.clock,
        'telegram.dispatch.free_text',
        () => this.deps.freeText.handlePromptAnswer(resolved.userId, event.text),
        { updateId: event.updateId, path: 'answer' },
      );
    }

    // 9. Free text → M6.
    return timed(
      this.deps.logger,
      this.deps.clock,
      'telegram.dispatch.free_text',
      () => this.deps.freeText.handleFreeText(resolved.userId, event.text),
      { updateId: event.updateId, path: 'new' },
    );
  }

  /**
   * Returns the refusal to send, or `undefined` to carry on. A `duplicate` returns a
   * null message — the original delivery is already being answered, and answering
   * again would be the double-reply M8's dedupe exists to prevent.
   */
  private async admit(
    resolved: ResolvedUser,
    updateId: string,
    now: Instant,
  ): Promise<OutboundMessage | null | undefined> {
    const result = await this.deps.entitlements.admitMessage(resolved.userId, updateId, now, {
      // Ricky's ruling, 11 Sep 2026: the daily cap is a product limit on a working
      // account, waived until sign-up finishes. Fair use is abuse protection and still
      // applies here — `skipDailyCap` cannot switch it off.
      skipDailyCap: !resolved.onboarded,
    });

    if (result.outcome === 'refused') return renderRefusal(result.code, result.message);
    if (result.outcome === 'duplicate') return null;
    return undefined;
  }

  private async routeCallback(
    resolved: ResolvedUser,
    data: string,
  ): Promise<OutboundMessage | null> {
    const onboarding = parseOnboardingCallbackData(data);
    if (onboarding !== null) {
      // The step travels with the button so M2 can tell a stale or forged press from a
      // current one — M7 passes it along and makes no judgement itself. An unrecognised
      // step name is dropped rather than forwarded: M2's contract takes a step or none,
      // and inventing one would defeat the staleness check it exists for.
      const step = asOnboardingStep(onboarding.step);
      const input: OnboardingInput =
        step === null ? { value: onboarding.value } : { value: onboarding.value, step };
      const reply = await this.deps.onboarding.answer(resolved.userId, input);
      return renderOnboardingReply(reply);
    }

    // `/history`'s More button — the one callback prefix stage 4C introduces. It routes
    // to the same function the command itself uses, so a continued page can never
    // render differently from the page it continues. M3 scopes the read to this user,
    // so a replayed or forged cursor can still only return the presser's own rows.
    const cursor = parseHistoryCallbackData(data);
    if (cursor !== null) {
      return historyPage(this.commandServices(), resolved.userId, cursor);
    }

    // Stage 4D's two buttons. Both carry nothing but yes/no — what they answer lives
    // in `pending_prompt`, which is also how a typed "yes" reaches the same place
    // (M11: every keyboard needs a free-text fallback). The handler is what decides
    // a press with nothing open is stale; the dispatcher does not read the row.
    const confirm = parseConfirmCallbackData(data);
    if (confirm !== null) {
      return this.deps.freeText.answerConfirm(resolved.userId, confirm);
    }
    const mapping = parseMappingCallbackData(data);
    if (mapping !== null) {
      return this.deps.freeText.answerMapping(resolved.userId, mapping);
    }

    // A prefix nothing claims. A press that does nothing is worse than one that says so.
    this.deps.logger.log('info', 'telegram.callback.unrouted', { prefix: data.split(':')[0] ?? '' });
    return renderRefusal('STALE_ACTION');
  }

  /**
   * The command handlers' view of the application. Assembled here rather than held as
   * a field so there is exactly one place that decides what a handler may reach for.
   */
  private commandServices(): CommandServices {
    return {
      identity: this.deps.identity,
      onboarding: this.deps.onboarding,
      entitlements: this.deps.entitlements,
      categories: this.deps.categories,
      budgets: this.deps.budgets,
      ledger: this.deps.ledger,
      allowance: this.deps.allowance,
      reminders: this.deps.reminders,
      gateway: this.deps.gateway,
      supportContact: this.deps.supportContact,
    };
  }

  private async runCommand(
    handler: CommandHandler,
    parsed: ReturnType<typeof parseCommand>,
    sender: TelegramSender,
    userId: UserId | null,
    now: Instant,
  ): Promise<OutboundMessage> {
    // `handler.name` is the catalogue's own constant, never the text the user typed —
    // an unknown command never reaches here.
    return timed(
      this.deps.logger,
      this.deps.clock,
      'telegram.dispatch.command',
      () => this.runHandler(handler, parsed, sender, userId, now),
      { command: handler.name },
    );
  }

  private async runHandler(
    handler: CommandHandler,
    parsed: ReturnType<typeof parseCommand>,
    sender: TelegramSender,
    userId: UserId | null,
    now: Instant,
  ): Promise<OutboundMessage> {
    return handler.handle({
      sender,
      userId,
      requireUserId: () => {
        if (userId === null) throw new RefusalError('ONBOARDING_REQUIRED');
        return userId;
      },
      args: parsed?.args ?? [],
      rest: parsed?.rest ?? '',
      now,
      services: this.commandServices(),
      router: this.deps.router,
    });
  }

  /**
   * The one place a reply leaves this module.
   *
   * The `ChannelConnection` is built from the update itself rather than read back from
   * M2: this is a reply to a message that just arrived, so the chat it came from is by
   * definition where the answer goes — and a lookup would add a round trip that could
   * only ever return the same `chat_id`. Every `MessageSender` reads `chatId` and
   * nothing else.
   */
  private async send(chatId: string, message: OutboundMessage, userId: UserId | null): Promise<void> {
    const connection: ChannelConnection = {
      id: '',
      userId: userId ?? '',
      channel: CHANNEL,
      externalId: chatId,
      chatId,
      isActive: true,
      linkedAt: this.deps.clock.now(),
    };

    // Only the first chunk carries the keyboard; a paginated reply is one logical
    // message split by Telegram's 4096-character limit, not several answers.
    const chunks = paginate(message.text);
    for (const [index, chunk] of chunks.entries()) {
      const outbound: OutboundMessage =
        index === 0 && message.replyMarkup !== undefined
          ? { text: chunk, replyMarkup: message.replyMarkup }
          : { text: chunk };
      const result = await this.deps.sender.send(connection, outbound);

      if (result.status === 'skipped' && userId !== null) {
        // The user blocked the bot. M5's own send path deactivates on its own results;
        // this is M7 deactivating on M7's.
        await this.deps.identity.deactivateConnection(userId, CHANNEL);
        return;
      }
      if (result.status !== 'sent') return;
    }
  }
}

function asOnboardingStep(value: string): OnboardingStep | null {
  return (ONBOARDING_STEPS as readonly string[]).includes(value) ? (value as OnboardingStep) : null;
}

/** M7 catches exactly two refusal shapes; everything else is a bug, not a message. */
export function renderThrown(error: unknown): OutboundMessage | null {
  if (RefusalError.is(error)) return renderRefusal(error.code, error.message);
  if (isEntitlementRefusal(error)) return renderRefusal(error.code, error.message);
  return null;
}
