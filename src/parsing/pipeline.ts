import type { Clock } from '../core/shared/clock';
import type { Id, Instant, LocalDate, UserId } from '../core/shared/common';
import type { DailyAllowanceService } from '../core/allowance/allowance-service';
import type { LedgerService, ParseRoute, Transaction, ValidatedCandidate } from '../core/ledger/ledger-service';
import { NoopLogger, type Logger } from '../observability/log';
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
    const normalized = this.normalizer.normalize(text);
    const candidate = this.mechanicalParser.parse(normalized, today);
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
   */
  async answerClarification(
    context: UserParseContext,
    original: string,
    reason: ClarifyReason,
    answer: string,
  ): Promise<ParseOutcome> {
    return this.parse(mergeClarificationAnswer(original, reason, answer), context);
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
    const transaction = await this.ledger.record(userId, { ...candidate, parseEventId });
    // M5 recalculation trigger (M3 checklist 2e / M6 checklist 3). Income never
    // offsets a cap, so only categorised expenses/refunds need it.
    if (candidate.direction !== 'income' && candidate.categoryId !== null) {
      await this.allowance.availableToday(userId, candidate.categoryId);
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
 * Known cost of the replacing branch, accepted rather than hidden: a user who answers
 * "the 30th" to "which day was it?" has dropped the merchant and amount along with
 * the bad date, and will be asked for them next. Each question converges — nothing
 * loops — but it can take two round trips. Reconstructing the good half of the
 * original would mean re-running the mechanical parse and trusting its residual
 * description, which is exactly what the decimal-comma case shows cannot be trusted.
 */
export function mergeClarificationAnswer(
  original: string,
  reason: ClarifyReason,
  answer: string,
): string {
  const trimmedAnswer = answer.trim();
  const trimmedOriginal = original.trim();
  // An empty answer is not an answer; re-parsing the original asks again, which is
  // the honest outcome and costs no model call the first guard would not have cost.
  if (trimmedAnswer.length === 0) return trimmedOriginal;
  if (REPLACING_REASONS.has(reason)) return trimmedAnswer;
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

    if (result.needsClarification) {
      return this.clarify('llm', 'model_asked', result.clarificationQuestion ?? 'Can you tell me the amount, what it was for, and which category?');
    }
    if (result.confidence < this.pipeline.deps.policy.confirmThreshold) {
      return this.clarify('llm', 'low_confidence', result.clarificationQuestion ?? 'I\'m not sure I got that — what was the amount and category?');
    }

    const merchantDisplay = result.merchant?.trim() || null;
    const fields: CandidateFields = {
      direction: result.intent,
      amountDecimal: result.amount === null ? null : decimalText(result.amount),
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
    if (result.confidence < this.pipeline.deps.policy.recordThreshold) {
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
    return { kind: 'clarify', route, parseEventId, reason, question };
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
    return this.pipeline.deps.parseEvents.record(event, this.pipeline.deps.clock.now());
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

/** A JSON number from the model → decimal text, without float formatting surprises. */
function decimalText(amount: number): string {
  if (!Number.isFinite(amount)) return 'NaN';
  // Shortest round-trip repr; exponent forms (1e-7) are rejected downstream as malformed.
  return String(amount);
}
