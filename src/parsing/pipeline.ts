import type { Clock } from '../core/shared/clock';
import type { Id, Instant, LocalDate, UserId } from '../core/shared/common';
import type { DailyAllowanceService } from '../core/allowance/allowance-service';
import type { LedgerService, ParseRoute, Transaction, ValidatedCandidate } from '../core/ledger/ledger-service';
import { NoopLogger, type Logger } from '../observability/log';
import { startTimer, timed } from '../observability/timing';
import { localDateAt } from './dates';
import { LlmParseError, type LlmParseResult, type LlmParser, type LlmUsage } from './llm-parser';
import type { MechanicalTransactionParser } from './mechanical-parser';
import type { MerchantMappingRepository } from './merchant-mapping-repository';
import { isMultiCategoryMerchant } from './multi-category-merchants';
import type { MessageNormalizer } from './normalizer';
import type { ParseEventRepository, ParseEventCorrectionHook, ParseEventInput } from './parse-event-repository';
import type {
  CategoryRef,
  ClarifyReason,
  ExtractedAmount,
  MappingProposal,
  MechanicalCandidate,
  MerchantMappingSource,
  ParseOutcome,
  UserParseContext,
} from './types';
import type { CandidateFields, TransactionCandidateValidator, ValidationResult } from './validator';

/**
 * The M6 orchestrator: mechanical → merchant memory → LLM (M6 "Illustrative
 * routing"), then validation and the confidence policy, then `LedgerService.record`
 * and M5's recalculation trigger — at the port level only; M3/M5 own persistence.
 *
 * Every call ends with exactly one `parse_event` row (routes/tokens/latency/booleans,
 * no text) — including failure paths, which is what makes the row useful.
 */
export interface ParsingPolicy {
  /** LLM confidence at or above this records straight away (then offers to remember the merchant). */
  recordThreshold: number;
  /** Between this and `recordThreshold`: ask the user to confirm the parsed candidate first. Below: clarify. */
  confirmThreshold: number;
  /** Only propose remembering a merchant key of at most this many words — longer keys never recur. */
  maxMappingKeyWords: number;
}

/**
 * Defaults are a starting point, NOT tuned — M6 "Open decisions" says set them from
 * the eval set. The deterministic eval can't measure model confidence; the live
 * eval (`test/eval/live-llm.eval.test.ts`) reports the distribution to tune against.
 */
export const DEFAULT_POLICY: ParsingPolicy = {
  recordThreshold: 0.85,
  confirmThreshold: 0.5,
  maxMappingKeyWords: 3,
};

export interface TransactionParsingPipelineDeps {
  clock: Clock;
  normalizer: MessageNormalizer;
  mechanicalParser: MechanicalTransactionParser;
  merchantMappings: MerchantMappingRepository;
  llmParser: LlmParser;
  validator: TransactionCandidateValidator;
  parseEvents: ParseEventRepository;
  ledger: LedgerService;
  allowance: DailyAllowanceService;
  logger?: Logger;
  policy?: Partial<ParsingPolicy>;
}

export class TransactionParsingPipeline implements ParseEventCorrectionHook {
  private readonly clock: Clock;
  private readonly normalizer: MessageNormalizer;
  private readonly mechanicalParser: MechanicalTransactionParser;
  private readonly merchantMappings: MerchantMappingRepository;
  private readonly llmParser: LlmParser;
  private readonly validator: TransactionCandidateValidator;
  private readonly parseEvents: ParseEventRepository;
  private readonly ledger: LedgerService;
  private readonly allowance: DailyAllowanceService;
  private readonly logger: Logger;
  private readonly policy: ParsingPolicy;

  constructor(deps: TransactionParsingPipelineDeps) {
    this.clock = deps.clock;
    this.normalizer = deps.normalizer;
    this.mechanicalParser = deps.mechanicalParser;
    this.merchantMappings = deps.merchantMappings;
    this.llmParser = deps.llmParser;
    this.validator = deps.validator;
    this.parseEvents = deps.parseEvents;
    this.ledger = deps.ledger;
    this.allowance = deps.allowance;
    this.logger = deps.logger ?? new NoopLogger();
    this.policy = { ...DEFAULT_POLICY, ...deps.policy };
  }

  /** Parse one free-text message that M7 has already routed past commands/clarifications. */
  async parse(text: string, context: UserParseContext): Promise<ParseOutcome> {
    const now = this.clock.now();
    const today = localDateAt(now, context.timezone);
    // Pure and in-memory, so this should always read ~0ms. It is logged anyway: it is
    // the control that proves a slow parse is the model or the database, not us.
    const mechanicalElapsed = startTimer(this.clock);
    const normalized = this.normalizer.normalize(text);
    const candidate = this.mechanicalParser.parse(normalized, today);
    this.logger.log('info', 'parse.mechanical', {
      hasExactlyOneAmount: candidate.hasExactlyOneAmount,
      ms: mechanicalElapsed(),
    });
    const run = new ParseRun(this, context, candidate, today, now);

    // Things the rules already know for certain, and that no route may override:
    // a correction, several amounts, a foreign currency, an impossible date. Each
    // is a clarification without a model call (M6 "Clarification policy"), logged
    // as route 'mechanical' so M9's "% handled without an LLM" stays honest.
    const guard = await run.mechanicalGuard();
    if (guard !== null) return guard;

    // --- M6 illustrative routing, verbatim in shape ---------------------------
    if (candidate.isExplicitIncome && candidate.hasExactlyOneAmount) {
      return run.recordIncome();
    }
    if (candidate.hasExactlyOneAmount) {
      const mapping = await this.merchantMappings.find(context.userId, candidate.normalizedDescription);
      if (mapping !== null && !isMultiCategoryMerchant(candidate.normalizedDescription)) {
        return run.recordExpenseFromMapping(mapping.id, mapping.categoryId, mapping.displayMerchant);
      }
    }
    return run.llmRoute();
  }

  /**
   * The user has answered a `clarify` question. M6 decides how the answer combines
   * with the message that prompted it, then runs the ordinary `parse` path — so the
   * answered attempt produces exactly one new `parse_event` row, like any other
   * parse, and every validation rule applies to it unchanged.
   *
   * This exists so M7 does not have to hold the policy. "Append the answer to the
   * original" is wrong for half the reasons: appending "4.50" to "coffee 4,50" still
   * contains a decimal comma, appending a day to a message with an impossible date
   * still contains the impossible date, and both would ask the same question forever.
   * Which reasons those are is a fact about the parser, so it lives here.
   *
   * The reason alone is not the whole rule, though. `model_asked` and `low_confidence`
   * cover every question the *model* invents, whatever it happens to be about — and
   * one of the things it asks about is an amount the message already stated ("is that
   * one coffee for $5, or two $5 coffees?"). Appending an answer that restates that
   * amount accumulates a second amount into the text, and the next round's mechanical
   * guard refuses it as two transactions. So the merge also asks the extractors a
   * question only they can answer: does the answer state money of its own? See
   * `mergeClarificationAnswer`.
   */
  async answerClarification(
    context: UserParseContext,
    original: string,
    reason: ClarifyReason,
    answer: string,
  ): Promise<ParseOutcome> {
    const restates = !REPLACING_REASONS.has(reason) && this.answerRestatesAmount(original, answer, context);
    return this.parse(mergeClarificationAnswer(original, reason, answer, restates), context);
  }

  /**
   * The user said "yes" to a `confirm` outcome. Records the already-validated
   * candidate under the original parse event; nothing is re-parsed.
   */
  async recordConfirmed(
    context: UserParseContext,
    candidate: ValidatedCandidate,
    parseEventId: Id,
    mappingProposal: MappingProposal | null,
  ): Promise<ParseOutcome> {
    const transaction = await this.persist(context.userId, candidate, parseEventId);
    return { kind: 'recorded', route: candidate.parseRoute, parseEventId, transaction, mappingProposal };
  }

  /**
   * The ONLY way a merchant mapping comes into existence: the user explicitly
   * confirmed ("Always categorise X as Y?" → yes) or corrected the category of a
   * recorded transaction. An LLM guess alone never reaches this method. Multi-
   * category merchants are refused even here — a permanent mapping for Amazon is
   * wrong by construction (M6 "Merchant memory").
   */
  async confirmMerchantMapping(
    userId: UserId,
    proposal: MappingProposal,
    source: MerchantMappingSource,
  ): Promise<{ saved: true } | { saved: false; reason: 'multi_category_merchant' | 'empty_key' }> {
    const key = this.normalizer.deriveMerchantKey(proposal.normalizedMerchant);
    if (key.length === 0) return { saved: false, reason: 'empty_key' };
    if (isMultiCategoryMerchant(key) || isMultiCategoryMerchant(proposal.displayMerchant)) {
      return { saved: false, reason: 'multi_category_merchant' };
    }
    await this.merchantMappings.saveConfirmed(
      {
        userId,
        normalizedMerchant: key,
        displayMerchant: proposal.displayMerchant,
        categoryId: proposal.categoryId,
        source,
      },
      this.clock.now(),
    );
    return { saved: true };
  }

  /** M3's `correct()` calls this — flips `parse_event.was_corrected` (M9). */
  onTransactionCorrected(parseEventId: Id): Promise<void> {
    return this.parseEvents.markCorrected(parseEventId);
  }

  /**
   * Evidence for the restatement half of the merge rule, gathered where the
   * extractors live rather than guessed from the text by the pure merge function.
   *
   * Both halves matter. The question must have been asked about a message that
   * **already carried an amount** — otherwise the answer is the missing amount and
   * belongs alongside the original ("woolies" + "12.50"), which is `no_amount`'s
   * whole shape. And the answer must state money the extractors are sure of: either
   * unambiguously (`$5`, `5 dollars`, `4.50`), or the same number the original
   * already stated, which is a restatement by definition.
   *
   * A bare number that is *not* one of those is left to append, because a bare number
   * is exactly the token the model could not tell from a quantity in the first place:
   * "2" answering "one coffee or two?" is a count, and "Cafe 63" is a category name.
   * Neither may quietly become the transaction's amount by standing alone.
   */
  private answerRestatesAmount(original: string, answer: string, context: UserParseContext): boolean {
    const today = localDateAt(this.clock.now(), context.timezone);
    const amountsIn = (text: string): MechanicalCandidate['amounts'] =>
      this.mechanicalParser.parse(this.normalizer.normalize(text), today).amounts;
    const stated = amountsIn(original);
    if (stated.length === 0) return false;
    return amountsIn(answer).some(
      (amount) => amount.explicit || stated.some((s) => sameDecimalText(s.decimal, amount.decimal)),
    );
  }

  // --- internals used by ParseRun --------------------------------------------

  /**
   * @internal
   *
   * `parseEventId` closes M6's open question 2 (M7 stage 4D): every candidate that
   * reaches here was parsed, so it always has one, and stamping it onto the candidate
   * — never onto `CandidateFields`/the validator, which run before the event is
   * logged — is what lets `LedgerService.correct()` attribute a later fix back to it.
   */
  async persist(userId: UserId, candidate: ValidatedCandidate, parseEventId: Id): Promise<Transaction> {
    // The transaction write — the database round trip a recorded message pays for.
    const transaction = await timed(this.logger, this.clock, 'parse.recorded', () =>
      this.ledger.record(userId, { ...candidate, parseEventId }),
    );
    // M5 recalculation trigger (M3 checklist 2e / M6 checklist 3). Income never
    // offsets a cap, so only categorised expenses/refunds need it.
    const categoryId = candidate.categoryId;
    if (candidate.direction !== 'income' && categoryId !== null) {
      await timed(this.logger, this.clock, 'parse.allowance_recalculated', () =>
        this.allowance.availableToday(userId, categoryId),
      );
    }
    return transaction;
  }

  /** @internal */
  get deps(): {
    clock: Clock;
    normalizer: MessageNormalizer;
    merchantMappings: MerchantMappingRepository;
    llmParser: LlmParser;
    validator: TransactionCandidateValidator;
    parseEvents: ParseEventRepository;
    logger: Logger;
    policy: ParsingPolicy;
  } {
    return {
      clock: this.clock,
      normalizer: this.normalizer,
      merchantMappings: this.merchantMappings,
      llmParser: this.llmParser,
      validator: this.validator,
      parseEvents: this.parseEvents,
      logger: this.logger,
      policy: this.policy,
    };
  }
}

/**
 * Reasons where the original message is itself the problem: it carries too many
 * amounts, an amount the extractors cannot read, a foreign currency, or a date that
 * is impossible or contradictory. The offending token is still in the original text,
 * so keeping it would re-trigger the same guard and ask the same question again. The
 * answer therefore stands alone.
 *
 * Every other reason means the original was fine but incomplete — no amount, no
 * category, a category we do not have, an intent or confidence the model was unsure
 * of — and the answer is the missing piece, so it extends the original.
 */
const REPLACING_REASONS: ReadonlySet<ClarifyReason> = new Set<ClarifyReason>([
  'multiple_amounts',
  'invalid_amount',
  'foreign_currency',
  'ambiguous_date',
  'invalid_date',
  'correction_intent',
]);

/**
 * How a clarification answer becomes the text to parse. Pure, and exported so the
 * rule is testable and quotable on its own rather than inferred from a transcript.
 *
 * `answerRestatesAmount` is the second half of the rule, and it is a parameter rather
 * than something computed here because the evidence for it belongs to the mechanical
 * extractors (`TransactionParsingPipeline.answerRestatesAmount`), not to a string
 * function. It means: the message we asked about already carried an amount, and the
 * answer states money of its own that the extractors are sure of — unambiguously
 * (`$5`, `5 dollars`, `4.50`) or as the same number already stated. That is a user
 * restating or correcting **the same** money, never a second transaction — so the
 * answer supersedes, exactly as a replacing reason does.
 *
 * Why that case needs saying at all: `model_asked` and `low_confidence` are not
 * topics, they are "the model asked something". One of the things it asks is to
 * disambiguate an amount that is already in the message ("one coffee for $5, or two
 * $5 coffees?"). Append the answer to that and the text now carries the same $5
 * twice; the extractors cannot tell a restatement from two purchases, so the next
 * round's `hasMultipleAmounts` guard refuses a message the user never wrote — and
 * each further answer makes it worse. With this rule the transcript can never
 * accumulate a second stated amount, however many rounds the conversation takes.
 *
 * Known cost of the replacing branch, accepted rather than hidden: a user who answers
 * "the 30th" to "which day was it?" has dropped the merchant and amount along with
 * the bad date, and will be asked for them next. The restatement branch can cost the
 * same — answer "$5" and the "coffee" goes with it. Each question converges —
 * nothing loops — but it can take two round trips. Reconstructing the good half of
 * the original would mean re-running the mechanical parse and trusting its residual
 * description, which is exactly what the decimal-comma case shows cannot be trusted.
 */
export function mergeClarificationAnswer(
  original: string,
  reason: ClarifyReason,
  answer: string,
  answerRestatesAmount = false,
): string {
  const trimmedAnswer = answer.trim();
  const trimmedOriginal = original.trim();
  // An empty answer is not an answer; re-parsing the original asks again, which is
  // the honest outcome and costs no model call the first guard would not have cost.
  if (trimmedAnswer.length === 0) return trimmedOriginal;
  if (REPLACING_REASONS.has(reason) || answerRestatesAmount) return trimmedAnswer;
  if (trimmedOriginal.length === 0) return trimmedAnswer;
  return `${trimmedOriginal} ${trimmedAnswer}`;
}

/** One parse's state — keeps `TransactionParsingPipeline.parse` readable as the routing decision it is. */
class ParseRun {
  private usage: LlmUsage | null = null;

  constructor(
    private readonly pipeline: TransactionParsingPipeline,
    private readonly context: UserParseContext,
    private readonly candidate: MechanicalCandidate,
    private readonly today: LocalDate,
    private readonly now: Instant,
  ) {}

  async recordIncome(): Promise<ParseOutcome> {
    const amount = this.candidate.amounts[0];
    const description = this.candidate.normalizedDescription;
    return this.validateAndRecord('mechanical', {
      direction: 'income',
      amountDecimal: amount?.decimal ?? null,
      currencyCode: amount?.currencyCode ?? null,
      transactionDate: null,
      merchantDisplay: description.length > 0 ? description : null,
      normalizedMerchant: description.length > 0 ? description : null,
      route: 'mechanical',
    });
  }

  async recordExpenseFromMapping(mappingId: Id, categoryId: Id, displayMerchant: string): Promise<ParseOutcome> {
    const amount = this.candidate.amounts[0];
    const outcome = await this.validateAndRecord('mapping', {
      direction: this.candidate.markers.includes('refund') ? 'refund' : 'expense',
      amountDecimal: amount?.decimal ?? null,
      currencyCode: amount?.currencyCode ?? null,
      transactionDate: null,
      categoryId,
      merchantDisplay: displayMerchant,
      normalizedMerchant: this.candidate.normalizedDescription,
      route: 'mapping',
    });
    if (outcome.kind === 'recorded') {
      await this.pipeline.deps.merchantMappings.markUsed(mappingId, this.now);
    }
    return outcome;
  }

  /** Pre-routing clarifications that need no model and no mapping — see `parse`. */
  async mechanicalGuard(): Promise<ParseOutcome | null> {
    const c = this.candidate;
    const currency = this.context.currencyCode;
    if (c.isCorrection) {
      return this.clarify('mechanical', 'correction_intent', 'Did you want to change or delete an earlier entry? Use /delete for the last one, or tell me which.');
    }
    if (c.hasAmbiguousDecimalComma) {
      return this.clarify('mechanical', 'invalid_amount', 'Is that a decimal comma? Please use a dot for cents, e.g. 4.50.');
    }
    if (c.hasMultipleAmounts) {
      return this.clarify('mechanical', 'multiple_amounts', 'I found more than one amount — please send one transaction per message so I record each correctly.');
    }
    const foreign = c.currencyTokens.find((t) => t.toUpperCase() !== currency.toUpperCase());
    if (foreign !== undefined) {
      return this.clarify('mechanical', 'foreign_currency', `That looks like ${foreign}, but your budget is in ${currency}. What was it in ${currency}?`);
    }
    const badDate = c.invalidDateTokens[0];
    if (badDate !== undefined) {
      return this.clarify('mechanical', 'invalid_date', `"${badDate}" isn't a real date — which day was it?`);
    }
    return null;
  }

  async llmRoute(): Promise<ParseOutcome> {
    const c = this.candidate;
    let result: LlmParseResult;
    try {
      result = await this.pipeline.deps.llmParser.parse(c.normalized.original, {
        categoryNames: this.context.categories.map((cat) => cat.name),
        currencyCode: this.context.currencyCode,
      });
    } catch (error) {
      if (error instanceof LlmParseError) {
        this.usage = error.usage ?? null;
        return this.clarify('llm', 'llm_unavailable', "I couldn't work that one out just now. Try something like \"$12.50 coffee\" and I'll record it.");
      }
      throw error;
    }
    this.usage = result.usage ?? null;

    // The rules, not the model, decide whether a bare number is the amount.
    const settled = result.needsClarification ? this.settledAmountDespiteModelDoubt(result) : null;
    if (result.needsClarification && settled === null) {
      return this.clarify('llm', 'model_asked', result.clarificationQuestion ?? 'Can you tell me the amount, what it was for, and which category?');
    }
    // A settled amount also outranks low confidence: asking "what was the amount?"
    // about a number the rules already read is the same question by another name.
    if (settled === null && result.confidence < this.pipeline.deps.policy.confirmThreshold) {
      return this.clarify('llm', 'low_confidence', result.clarificationQuestion ?? 'I\'m not sure I got that — what was the amount and category?');
    }

    const merchantDisplay = result.merchant?.trim() || null;
    const fields: CandidateFields = {
      direction: result.intent,
      // The model may have withheld the amount precisely because it read the bare
      // number as a quantity; the settled amount stands in when it did.
      amountDecimal: result.amount !== null ? decimalText(result.amount) : settled?.decimal ?? null,
      currencyCode: result.currency,
      transactionDate: result.transactionDate,
      categoryName: result.category,
      merchantDisplay,
      normalizedMerchant: this.mappingKey(),
      route: 'llm',
      confidence: result.confidence,
    };
    const validation = this.pipeline.deps.validator.validate({
      fields,
      mechanical: c,
      context: this.context,
      today: this.today,
      now: this.now,
    });
    if (!validation.ok) return this.clarify('llm', validation.reason, validation.question);

    const proposal = this.mappingProposal(validation.category, merchantDisplay);
    // The model did flag doubt, so this never records silently — it asks the user to
    // confirm the candidate (amount included), which is not the forbidden question.
    if (settled !== null || result.confidence < this.pipeline.deps.policy.recordThreshold) {
      const parseEventId = await this.logEvent('llm', false);
      return {
        kind: 'confirm',
        route: 'llm',
        parseEventId,
        candidate: validation.candidate,
        categoryName: validation.category?.name ?? null,
        mappingProposal: proposal,
        confidence: result.confidence,
      };
    }
    const parseEventId = await this.logEvent('llm', false);
    const transaction = await this.pipeline.persist(this.context.userId, validation.candidate, parseEventId);
    return { kind: 'recorded', route: 'llm', parseEventId, transaction, mappingProposal: proposal };
  }

  // ---------------------------------------------------------------------------

  /**
   * Product decision, 13 Sep 2026: a single bare number in a message is always the
   * transaction amount — "coffee 5", "5 coffee" and "$5 coffee" are all $5 — and the
   * bot never asks whether a number is a quantity or a price.
   *
   * The rules already settle that before the model is called: `hasExactlyOneAmount`
   * goes false the moment an explicit multiplier appears ("2 x 5", "x3", "each",
   * "apiece", "per person"), so a genuine multi-item message clarified mechanically
   * and never reached this route. Where the rules HAVE settled on one amount, the
   * model may not reopen it — the instructions tell it not to, and this is what makes
   * that a guarantee rather than a hope.
   *
   * A model question is still relayed whenever something it could legitimately be
   * unsure about is missing: no settled amount, money-in (income vs refund is a
   * documented must-ask — M6 "Clarification policy"), or no category to work with.
   * When none of those hold, the only thing left to doubt is the amount, so the parse
   * continues on the settled amount — as a `confirm`, never a silent record.
   */
  private settledAmountDespiteModelDoubt(result: LlmParseResult): ExtractedAmount | null {
    if (!this.candidate.hasExactlyOneAmount) return null;
    if (result.intent !== 'expense') return null;
    if ((result.category ?? '').trim().length === 0) return null;
    return this.candidate.amounts[0] ?? null;
  }

  private async validateAndRecord(route: ParseRoute, fields: CandidateFields): Promise<ParseOutcome> {
    const validation: ValidationResult = this.pipeline.deps.validator.validate({
      fields,
      mechanical: this.candidate,
      context: this.context,
      today: this.today,
      now: this.now,
    });
    if (!validation.ok) return this.clarify(route, validation.reason, validation.question);
    const parseEventId = await this.logEvent(route, false);
    const transaction = await this.pipeline.persist(this.context.userId, validation.candidate, parseEventId);
    return { kind: 'recorded', route, parseEventId, transaction, mappingProposal: null };
  }

  private async clarify(route: ParseRoute, reason: ClarifyReason, question: string): Promise<ParseOutcome> {
    const parseEventId = await this.logEvent(route, true);
    // `parsedText` is what M6 actually parsed — the merged text on a second round —
    // so M7 stores that rather than re-deriving the merge rule at the call site.
    return { kind: 'clarify', route, parseEventId, reason, question, parsedText: this.candidate.normalized.original };
  }

  private logEvent(route: ParseRoute, neededClarification: boolean): Promise<Id> {
    const event: ParseEventInput = {
      userId: this.context.userId,
      route,
      model: this.usage?.model ?? null,
      inputTokens: this.usage?.inputTokens ?? null,
      outputTokens: this.usage?.outputTokens ?? null,
      latencyMs: this.usage?.latencyMs ?? null,
      neededClarification,
    };
    // Route and token counts only, as M9 requires of the row itself — and the same is
    // true of this line, which adds how long writing it took.
    return timed(
      this.pipeline.deps.logger,
      this.pipeline.deps.clock,
      'parse.event_recorded',
      () => this.pipeline.deps.parseEvents.record(event, this.pipeline.deps.clock.now()),
      { route },
    );
  }

  /**
   * The merchant-memory key is what the user actually typed (minus amount/date),
   * so the next identical message hits the mapping without an LLM call. Not the
   * model's tidied merchant name — that would never match the user's shorthand.
   */
  private mappingKey(): string | null {
    const key = this.candidate.normalizedDescription;
    return key.length > 0 ? key : null;
  }

  private mappingProposal(category: CategoryRef | null, merchantDisplay: string | null): MappingProposal | null {
    const key = this.mappingKey();
    if (category === null || key === null || merchantDisplay === null) return null;
    if (!this.candidate.hasExactlyOneAmount) return null;
    if (key.split(' ').length > this.pipeline.deps.policy.maxMappingKeyWords) return null;
    if (isMultiCategoryMerchant(key) || isMultiCategoryMerchant(merchantDisplay)) return null;
    return { normalizedMerchant: key, displayMerchant: merchantDisplay, categoryId: category.id, categoryName: category.name };
  }
}

/**
 * Same money, written two ways ("5" and "5.00"). Text only — no float, and no
 * currency needed, since both strings come from the same extractors.
 */
function sameDecimalText(a: string, b: string): boolean {
  const trim = (d: string): string => (d.includes('.') ? d.replace(/0+$/, '').replace(/\.$/, '') : d);
  return trim(a) === trim(b);
}

/** A JSON number from the model → decimal text, without float formatting surprises. */
function decimalText(amount: number): string {
  if (!Number.isFinite(amount)) return 'NaN';
  // Shortest round-trip repr; exponent forms (1e-7) are rejected downstream as malformed.
  return String(amount);
}
