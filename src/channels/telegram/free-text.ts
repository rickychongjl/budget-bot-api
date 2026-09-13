import { renderAllowanceLine } from '../../core/allowance/messages';
import type { DailyAllowanceService } from '../../core/allowance/allowance-service';
import type { IdentityService } from '../../core/identity/identity-service';
import type { CategoryService } from '../../core/ledger/category-service';
import type { Transaction, ValidatedCandidate } from '../../core/ledger/ledger-service';
import type { Clock } from '../../core/shared/clock';
import type { Id, Instant, LocalDate, UserId } from '../../core/shared/common';
import { localDateAt } from '../../core/shared/local-date';
import type { OutboundMessage } from '../../core/shared/messaging';
import { sanitiseDisplayText } from '../../core/shared/text';
import { mergeClarificationAnswer, type TransactionParsingPipeline } from '../../parsing/pipeline';
import type { ParseOutcome, UserParseContext } from '../../parsing/types';
import type { FreeTextHandler } from './dispatcher';
import type { GatewayRepository, PendingPrompt } from './gateway-repository';
import { decodePendingPayload, encodePendingPayload, type PendingPayload } from './pending-payload';
import {
  renderConfirmPrompt,
  renderMappingQuestion,
  renderRecorded,
  renderRefusal,
  type EntryLine,
} from './render';

/**
 * Stage 4D: the free-text path. Everything a user types that is not a command and
 * not an onboarding answer arrives here, along with every answer to a question the
 * bot asked.
 *
 * The division of labour is M7's own rule — "if a change here would alter a number
 * the user sees, it belongs somewhere else":
 *
 *   - **M6 decides** what a message means, whether it is confident enough to record,
 *     what to ask when it is not, and how an answer combines with the question it
 *     answers (`answerClarification`).
 *   - **M3/M5 decide** what was recorded and what is still spendable today.
 *   - **This file decides** only what is remembered between two Worker invocations,
 *     and which sentence goes back.
 *
 * There is no arithmetic here and no policy. The one judgement it makes is reading
 * "yes" as yes.
 */

/** The pipeline, narrowed to the four calls this path makes. */
export type FreeTextPipeline = Pick<
  TransactionParsingPipeline,
  'parse' | 'answerClarification' | 'recordConfirmed' | 'confirmMerchantMapping'
>;

export interface TelegramFreeTextDeps {
  pipeline: FreeTextPipeline;
  /** M2, for the currency, timezone and backdating floor `UserParseContext` needs. */
  identity: Pick<IdentityService, 'getSettings'>;
  /** M3, for the category names M6 matches against. */
  categories: Pick<CategoryService, 'list'>;
  /** M5, for the line that follows a confirmation. */
  allowance: Pick<DailyAllowanceService, 'availableToday'>;
  gateway: GatewayRepository;
  /**
   * The same clock M6 stamps a transaction with — deliberately not the sender's
   * timestamp off the Telegram update. "Was this today?" has to be asked against the
   * clock that decided the entry's date, or a few seconds' skew across a local
   * midnight makes the bot call today's entry yesterday's.
   */
  clock: Clock;
}

export const DROPPED_REPLY = 'Dropped it. Nothing was recorded.';
export const MAPPING_DECLINED_REPLY = "No problem — I'll ask again next time.";

export class TelegramFreeTextHandler implements FreeTextHandler {
  constructor(private readonly deps: TelegramFreeTextDeps) {}

  /** Step 9: an ordinary message from someone with no open question. */
  async handleFreeText(userId: UserId, text: string): Promise<OutboundMessage> {
    const context = await this.contextFor(userId);
    const outcome = await this.deps.pipeline.parse(text, context);
    return this.afterParse(context, outcome, text);
  }

  /**
   * Step 8: a message arriving while a question is open.
   *
   * A `clarify` takes any text as its answer — that is what it asked for. A `confirm`
   * or a `mapping` asked a yes/no question, so anything that is not yes or no
   * **supersedes** it: the user has moved on and typing a second expense should log
   * that expense, not be read as an answer to a question about the first one. The
   * abandoned question is dropped rather than queued, which is also what the table's
   * one-row-per-user primary key already enforces.
   */
  async handlePromptAnswer(userId: UserId, text: string): Promise<OutboundMessage> {
    const open = await this.deps.gateway.findPendingPrompt(userId);
    // Nothing open: the dispatcher only routes here when there is, but a concurrent
    // /cancel can empty the row in between. Treating it as fresh text is what the
    // user typed anyway.
    if (open === null) return this.handleFreeText(userId, text);

    const payload = decodePendingPayload(open.kind, open.payload);
    if (payload === null) return this.discard(userId);

    switch (payload.kind) {
      case 'clarify': {
        const context = await this.contextFor(userId);
        const outcome = await this.deps.pipeline.answerClarification(
          context,
          payload.original,
          payload.reason,
          text,
        );
        // If M6 asks a *second* question, the message it would be answering is the
        // merged one, not the original. `mergeClarificationAnswer` is M6's own
        // exported rule and it is pure, so calling it here reads the same answer the
        // pipeline just computed rather than guessing at it.
        return this.afterParse(
          context,
          outcome,
          mergeClarificationAnswer(payload.original, payload.reason, text),
        );
      }
      case 'confirm': {
        const answer = readYesNo(text);
        if (answer === null) return this.supersede(userId, text);
        return this.settleConfirm(userId, payload, answer);
      }
      case 'mapping': {
        const answer = readYesNo(text);
        if (answer === null) return this.supersede(userId, text);
        return this.settleMapping(userId, payload, answer);
      }
    }
  }

  /** The `pc:yes` / `pc:no` buttons. */
  async answerConfirm(userId: UserId, yes: boolean): Promise<OutboundMessage> {
    const payload = await this.openPayload(userId, 'confirm');
    if (payload === null) return this.discard(userId);
    return this.settleConfirm(userId, payload, yes);
  }

  /** The `map:yes` / `map:no` buttons. */
  async answerMapping(userId: UserId, yes: boolean): Promise<OutboundMessage> {
    const payload = await this.openPayload(userId, 'mapping');
    if (payload === null) return this.discard(userId);
    return this.settleMapping(userId, payload, yes);
  }

  // ---- the three outcomes --------------------------------------------------------

  /**
   * Turns one `ParseOutcome` into the prompt state it implies and the single message
   * that describes it.
   *
   * The prompt state is written as a **function of the outcome**, not patched: a
   * recorded entry with a merchant to remember leaves a `mapping` row, and every
   * other recorded entry leaves none. The table's upsert-on-user_id makes either a
   * single statement, and it means no path can leave a question open that the user
   * has already answered.
   */
  private async afterParse(
    context: UserParseContext,
    outcome: ParseOutcome,
    /** The text M6 was given. A `clarify` has to remember it to be answerable. */
    parsedText: string,
  ): Promise<OutboundMessage> {
    const now = this.deps.clock.now();
    const today = localDateAt(now, context.timezone);

    switch (outcome.kind) {
      case 'recorded': {
        const lead = await this.describeRecorded(context, outcome.transaction, today);
        if (outcome.mappingProposal === null) {
          await this.deps.gateway.clearPendingPrompt(context.userId);
          return { text: lead };
        }
        await this.setPrompt(
          context.userId,
          { kind: 'mapping', proposal: outcome.mappingProposal },
          outcome.parseEventId,
          now,
        );
        return renderMappingQuestion(outcome.mappingProposal, lead);
      }
      case 'confirm': {
        await this.setPrompt(
          context.userId,
          {
            kind: 'confirm',
            candidate: outcome.candidate,
            parseEventId: outcome.parseEventId,
            categoryName: outcome.categoryName,
            mappingProposal: outcome.mappingProposal,
          },
          outcome.parseEventId,
          now,
        );
        return renderConfirmPrompt(
          candidateLine(outcome.candidate, outcome.categoryName),
          context.currencyCode,
          today,
        );
      }
      case 'clarify': {
        await this.setPrompt(
          context.userId,
          {
            kind: 'clarify',
            original: parsedText,
            reason: outcome.reason,
            question: outcome.question,
            parseEventId: outcome.parseEventId,
          },
          outcome.parseEventId,
          now,
        );
        return { text: outcome.question };
      }
    }
  }

  // ---- settling an open question -------------------------------------------------

  private async settleConfirm(
    userId: UserId,
    payload: Extract<PendingPayload, { kind: 'confirm' }>,
    yes: boolean,
  ): Promise<OutboundMessage> {
    if (!yes) {
      await this.deps.gateway.clearPendingPrompt(userId);
      return { text: DROPPED_REPLY };
    }

    const context = await this.contextFor(userId);
    // The record happens before the row is touched: if M3 refuses or the database
    // fails, the question is still open and the user can answer it again. A cleared
    // row plus a failed write would be an entry silently lost.
    const outcome = await this.deps.pipeline.recordConfirmed(
      context,
      payload.candidate,
      payload.parseEventId,
      payload.mappingProposal,
    );
    return this.afterParse(context, outcome, payload.candidate.rawText);
  }

  private async settleMapping(
    userId: UserId,
    payload: Extract<PendingPayload, { kind: 'mapping' }>,
    yes: boolean,
  ): Promise<OutboundMessage> {
    if (!yes) {
      await this.deps.gateway.clearPendingPrompt(userId);
      return { text: MAPPING_DECLINED_REPLY };
    }

    // M6 can still refuse — a multi-category merchant never becomes a permanent
    // mapping even when the user asks for one. Reported honestly rather than
    // answered "saved!" over a refusal.
    const result = await this.deps.pipeline.confirmMerchantMapping(userId, payload.proposal, 'user_confirmed');
    await this.deps.gateway.clearPendingPrompt(userId);

    const merchant = sanitiseDisplayText(payload.proposal.displayMerchant);
    if (result.saved) {
      return {
        text: `Got it — ${merchant} goes under ${sanitiseDisplayText(payload.proposal.categoryName)} from now on.`,
      };
    }
    return {
      text:
        result.reason === 'multi_category_merchant'
          ? `${merchant} covers a few different kinds of spending, so I'll keep asking rather than guess. The entry is recorded.`
          : "I couldn't work out what to remember there, so I'll ask again next time. The entry is recorded.",
    };
  }

  /**
   * Not an answer to the open question — so the question goes and the message is
   * treated as what it is. The entry the user is now logging matters more than the
   * one they have stopped talking about.
   */
  private async supersede(userId: UserId, text: string): Promise<OutboundMessage> {
    await this.deps.gateway.clearPendingPrompt(userId);
    return this.handleFreeText(userId, text);
  }

  /**
   * A button pressed twice, a button from a conversation that has moved on, or a row
   * whose payload no longer decodes. All three are the same thing to the user: the
   * thing they tapped is not there any more.
   */
  private async discard(userId: UserId): Promise<OutboundMessage> {
    await this.deps.gateway.clearPendingPrompt(userId);
    return renderRefusal('STALE_ACTION');
  }

  // ---- plumbing ------------------------------------------------------------------

  private async openPayload<K extends PendingPayload['kind']>(
    userId: UserId,
    kind: K,
  ): Promise<Extract<PendingPayload, { kind: K }> | null> {
    const open: PendingPrompt | null = await this.deps.gateway.findPendingPrompt(userId);
    if (open === null || open.kind !== kind) return null;
    const payload = decodePendingPayload(open.kind, open.payload);
    return payload !== null && payload.kind === kind
      ? (payload as Extract<PendingPayload, { kind: K }>)
      : null;
  }

  private setPrompt(
    userId: UserId,
    payload: PendingPayload,
    parseEventId: Id | null,
    now: Instant,
  ): Promise<void> {
    return this.deps.gateway.setPendingPrompt({
      userId,
      kind: payload.kind,
      parseEventId,
      payload: encodePendingPayload(payload),
      now,
    });
  }

  /**
   * What M6 needs to know about the user for one parse, assembled from the two
   * modules that own it. Non-archived categories only — M3's `list` default — because
   * a category the user has retired is not one the parser should propose.
   */
  private async contextFor(userId: UserId): Promise<UserParseContext> {
    const [settings, categories] = await Promise.all([
      this.deps.identity.getSettings(userId),
      this.deps.categories.list(userId),
    ]);
    return {
      userId,
      currencyCode: settings.currencyCode,
      timezone: settings.timezone,
      categories: categories.map((category) => ({ id: category.id, name: category.name })),
      accountCreatedOn: settings.accountCreatedOn,
    };
  }

  /**
   * The confirmation, plus M5's allowance line when there is one to show.
   *
   * `availableToday` is called **directly**, the way `/delete` does:
   * `AllowanceNotifier.ledgerChanged` is a documented no-op because `available_today`
   * is derived rather than stored, so a handler waiting to be notified would print
   * the figure from before the entry it is confirming.
   *
   * Income gets no line — it never offsets a cap — and neither does an uncategorised
   * expense or a category with no budget, which has no daily figure to report.
   */
  private async describeRecorded(
    context: UserParseContext,
    transaction: Transaction,
    today: LocalDate,
  ): Promise<string> {
    const categoryName = nameOf(context, transaction.categoryId);
    const lines = [
      renderRecorded(
        {
          direction: transaction.direction,
          amountMinorUnits: transaction.amountMinorUnits,
          occurredOn: transaction.occurredOn,
          merchant: transaction.merchantDisplay,
          categoryName,
        },
        context.currencyCode,
        today,
      ),
    ];

    if (transaction.direction !== 'income' && transaction.categoryId !== null) {
      const views = await this.deps.allowance.availableToday(context.userId, transaction.categoryId);
      for (const view of views) lines.push(renderAllowanceLine(view, context.currencyCode));
    }

    return lines.join('\n');
  }
}

/**
 * Yes, no, or "this is not an answer to that question".
 *
 * Kept to the words a person actually types at a yes/no button, with trailing
 * punctuation and an emoji-free trim. Everything else supersedes, so the cost of
 * being conservative here is that "yep 12.50 coffee" logs a coffee — which is what it
 * says — rather than confirming something else.
 */
export function readYesNo(text: string): boolean | null {
  const word = text.trim().toLowerCase().replace(/[.!,]+$/, '');
  if (YES.has(word)) return true;
  if (NO.has(word)) return false;
  return null;
}

const YES = new Set(['yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'sure', 'please do']);
const NO = new Set(['no', 'n', 'nope', 'nah', "don't", 'dont']);

/** A candidate described for the user, before it is anything M3 knows about. */
function candidateLine(candidate: ValidatedCandidate, categoryName: string | null): EntryLine {
  return {
    direction: candidate.direction,
    amountMinorUnits: candidate.amountMinorUnits,
    occurredOn: candidate.occurredOn,
    merchant: candidate.merchantDisplay ?? null,
    categoryName,
  };
}

function nameOf(context: UserParseContext, categoryId: Id | null): string | null {
  if (categoryId === null) return null;
  return context.categories.find((category) => category.id === categoryId)?.name ?? null;
}

