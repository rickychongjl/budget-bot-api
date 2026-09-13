import { describe, expect, it } from 'vitest';
import { LlmParseError } from '../../src/parsing/llm-parser';
import { mergeClarificationAnswer } from '../../src/parsing/pipeline';
import type { ClarifyReason } from '../../src/parsing/types';
import { llmResult } from '../support/scripted-llm-parser';
import { USER_ID, categoryId, makeHarness } from '../eval/fixture';

const woolworthsGuess = llmResult({
  intent: 'expense',
  amount: 82.4,
  currency: 'AUD',
  merchant: 'Woolworths',
  category: 'Groceries',
  confidence: 0.96,
  usage: { model: 'gpt-5.4-nano', inputTokens: 480, outputTokens: 52, latencyMs: 0 },
});

describe('TransactionParsingPipeline — merchant memory lifecycle', () => {
  it('an LLM guess alone never writes a mapping; the proposal only becomes a row after explicit confirmation', async () => {
    const h = makeHarness({ llm: woolworthsGuess, seedMappings: false });
    const first = await h.pipeline.parse('woolies 82.40', h.context);
    expect(first.kind).toBe('recorded');
    if (first.kind !== 'recorded') return;
    expect(first.route).toBe('llm');
    expect(first.mappingProposal).toEqual({
      normalizedMerchant: 'woolies',
      displayMerchant: 'Woolworths',
      categoryId: categoryId('Groceries'),
      categoryName: 'Groceries',
    });
    expect(h.mappings.saves).toHaveLength(0);
    expect(await h.mappings.find(USER_ID, 'woolies')).toBeNull();

    // Same message again, still no confirmation: still the LLM route.
    await h.pipeline.parse('woolies 82.40', h.context);
    expect(h.llm.calls).toHaveLength(2);

    // User says "yes, always".
    const proposal = first.mappingProposal;
    if (proposal === null) throw new Error('expected a proposal');
    expect(await h.pipeline.confirmMerchantMapping(USER_ID, proposal, 'user_confirmed')).toEqual({ saved: true });
    expect(h.mappings.saves).toHaveLength(1);
    expect(h.mappings.saves[0]).toMatchObject({ userId: USER_ID, normalizedMerchant: 'woolies', source: 'user_confirmed' });

    // Third time: merchant memory, no model call, mapping usage bumped.
    const third = await h.pipeline.parse('woolies 82.40', h.context);
    expect(third).toMatchObject({ kind: 'recorded', route: 'mapping', mappingProposal: null });
    expect(h.llm.calls).toHaveLength(2);
    expect((await h.mappings.find(USER_ID, 'woolies'))?.timesUsed).toBe(1);
  });

  it('a correction upserts the mapping with source user_corrected', async () => {
    const h = makeHarness();
    await h.pipeline.confirmMerchantMapping(USER_ID, { normalizedMerchant: 'coles', displayMerchant: 'Coles', categoryId: categoryId('Eating Out'), categoryName: 'Eating Out' }, 'user_corrected');
    const row = await h.mappings.find(USER_ID, 'coles');
    expect(row).toMatchObject({ categoryId: categoryId('Eating Out'), source: 'user_corrected' });
  });

  it('refuses a permanent mapping for a multi-category merchant even when the user asks', async () => {
    const h = makeHarness();
    const result = await h.pipeline.confirmMerchantMapping(USER_ID, { normalizedMerchant: 'amazon', displayMerchant: 'Amazon', categoryId: categoryId('Shopping'), categoryName: 'Shopping' }, 'user_confirmed');
    expect(result).toEqual({ saved: false, reason: 'multi_category_merchant' });
    expect(h.mappings.saves).toHaveLength(0);
  });

  it('never applies a seeded mapping for a multi-category merchant', async () => {
    const h = makeHarness({ llm: llmResult({ intent: 'expense', amount: 20, currency: 'AUD', merchant: 'Amazon', category: 'Shopping', confidence: 0.9 }) });
    h.mappings.seed({ userId: USER_ID, normalizedMerchant: 'amazon', displayMerchant: 'Amazon', categoryId: categoryId('Shopping'), source: 'user_confirmed' });
    const outcome = await h.pipeline.parse('amazon 20', h.context);
    expect(outcome.route).toBe('llm');
    expect(h.llm.calls).toHaveLength(1);
  });
});

describe('TransactionParsingPipeline — confidence policy', () => {
  it('asks to confirm between the thresholds and records via recordConfirmed', async () => {
    const h = makeHarness({ llm: llmResult({ intent: 'expense', amount: 89.5, currency: 'AUD', merchant: 'Bunnings', category: 'Shopping', confidence: 0.7 }) });
    const outcome = await h.pipeline.parse('bunnings 89.50', h.context);
    expect(outcome.kind).toBe('confirm');
    if (outcome.kind !== 'confirm') return;
    expect(h.ledger.recorded).toHaveLength(0);
    expect(h.parseEvents.events).toHaveLength(1);
    expect(h.parseEvents.events[0]!.neededClarification).toBe(false);

    const recorded = await h.pipeline.recordConfirmed(h.context, outcome.candidate, outcome.parseEventId, outcome.mappingProposal);
    expect(recorded.kind).toBe('recorded');
    expect(h.ledger.recorded).toHaveLength(1);
    expect(h.ledger.recorded[0]!.candidate.amountMinorUnits).toBe(8950n);
    expect(h.allowance.recalculated).toEqual([{ userId: USER_ID, categoryId: categoryId('Shopping') }]);
    // Same parse event — no second row for the confirmation.
    expect(h.parseEvents.events).toHaveLength(1);
  });

  it('thresholds are configurable', async () => {
    const h = makeHarness({ llm: llmResult({ intent: 'expense', amount: 89.5, currency: 'AUD', merchant: 'Bunnings', category: 'Shopping', confidence: 0.7 }), policy: { recordThreshold: 0.6 } });
    expect((await h.pipeline.parse('bunnings 89.50', h.context)).kind).toBe('recorded');
  });
});

describe('TransactionParsingPipeline — parse_event', () => {
  it('writes token usage and latency from the LLM route, no text', async () => {
    const h = makeHarness({ llm: woolworthsGuess, seedMappings: false });
    await h.pipeline.parse('woolies 82.40', h.context);
    expect(h.parseEvents.events).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        route: 'llm',
        model: 'gpt-5.4-nano',
        inputTokens: 480,
        outputTokens: 52,
        latencyMs: 0,
        neededClarification: false,
        wasCorrected: false,
      }),
    ]);
    const values = JSON.stringify(Object.values(h.parseEvents.events[0]!));
    expect(values).not.toMatch(/woolies|82\.40|Woolworths|Groceries/);
  });

  it('still writes a row (with usage) on a refusal / API failure and records nothing', async () => {
    const h = makeHarness({ llm: new LlmParseError('refusal', 'no', { model: 'gpt-5.4-nano', inputTokens: 300, outputTokens: 0, latencyMs: 0 }), seedMappings: false });
    const outcome = await h.pipeline.parse('something weird 12', h.context);
    expect(outcome).toMatchObject({ kind: 'clarify', reason: 'llm_unavailable', route: 'llm' });
    expect(h.ledger.recorded).toHaveLength(0);
    expect(h.parseEvents.events).toEqual([
      expect.objectContaining({ route: 'llm', model: 'gpt-5.4-nano', inputTokens: 300, neededClarification: true }),
    ]);
    expect(JSON.stringify(Object.values(h.parseEvents.events[0]!))).not.toContain('weird');
  });

  it('exposes the was_corrected hook for M3', async () => {
    const h = makeHarness();
    const outcome = await h.pipeline.parse('woolies 82.40', h.context);
    await h.pipeline.onTransactionCorrected(outcome.parseEventId);
    expect(h.parseEvents.events[0]!.wasCorrected).toBe(true);
  });

  it('never gives the LLM more than text + category names + currency', async () => {
    const h = makeHarness({ llm: woolworthsGuess, seedMappings: false });
    await h.pipeline.parse('woolies 82.40', h.context);
    expect(h.llm.calls).toEqual([
      { text: 'woolies 82.40', context: { categoryNames: h.context.categories.map((c) => c.name), currencyCode: 'AUD' } },
    ]);
  });
});

describe('TransactionParsingPipeline — ledger / allowance hand-off', () => {
  it('records explicit income mechanically without a category and without an allowance trigger', async () => {
    const h = makeHarness();
    const outcome = await h.pipeline.parse('+2500 salary', h.context);
    expect(outcome).toMatchObject({ kind: 'recorded', route: 'mechanical' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ direction: 'income', amountMinorUnits: 250000n, categoryId: null, parseRoute: 'mechanical', rawText: '+2500 salary' });
    expect(h.allowance.recalculated).toEqual([]);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('records a mapped expense and triggers the per-category recalculation', async () => {
    const h = makeHarness();
    await h.pipeline.parse('coles $120.55 yesterday', h.context);
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({
      direction: 'expense',
      amountMinorUnits: 12055n,
      categoryId: categoryId('Groceries'),
      occurredOn: '2026-09-05',
      merchantDisplay: 'Coles',
      normalizedMerchant: 'coles',
      parseRoute: 'mapping',
    });
    expect(h.allowance.recalculated).toEqual([{ userId: USER_ID, categoryId: categoryId('Groceries') }]);
  });
});

describe('TransactionParsingPipeline — answerClarification', () => {
  /**
   * The whole rule, in one table. `satisfies Record<ClarifyReason, …>` is
   * load-bearing: a new reason added to the union without a decision here fails
   * `npm run typecheck` rather than silently defaulting to one of the two
   * behaviours — and defaulting wrongly is what loops a conversation.
   */
  const STRATEGY = {
    multiple_amounts: 'replace',
    invalid_amount: 'replace',
    foreign_currency: 'replace',
    ambiguous_date: 'replace',
    invalid_date: 'replace',
    correction_intent: 'replace',
    no_amount: 'append',
    missing_category: 'append',
    unknown_category: 'append',
    ambiguous_intent: 'append',
    multi_category_merchant: 'append',
    low_confidence: 'append',
    model_asked: 'append',
    llm_unavailable: 'append',
  } satisfies Record<ClarifyReason, 'replace' | 'append'>;

  it.each(Object.entries(STRATEGY))('%s %ss the original', (reason, strategy) => {
    const merged = mergeClarificationAnswer('woolies 82.40', reason as ClarifyReason, 'groceries');
    expect(merged).toBe(strategy === 'replace' ? 'groceries' : 'woolies 82.40 groceries');
  });

  it('treats an empty answer as no answer and re-parses the original', () => {
    expect(mergeClarificationAnswer('woolies 82.40', 'missing_category', '   ')).toBe('woolies 82.40');
  });

  /**
   * The second half of the rule, which the reason alone cannot express: `model_asked`
   * is "the model asked something", and one of the things it asks is to disambiguate
   * an amount the message already carried. Restating that amount must supersede, or
   * the merged text carries the same money twice.
   */
  it('lets an answer that restates the amount stand alone, whatever the reason says', () => {
    expect(mergeClarificationAnswer('coffee 5', 'model_asked', 'one coffee for 5 dollars', true)).toBe(
      'one coffee for 5 dollars',
    );
    expect(mergeClarificationAnswer('coffee 5', 'model_asked', 'one coffee for 5 dollars')).toBe(
      'coffee 5 one coffee for 5 dollars',
    );
  });

  it('appends the answer for a missing category, and writes its own parse_event', async () => {
    const h = makeHarness({ seedMappings: false });
    h.llm.enqueue(
      llmResult({ intent: 'expense', amount: 30, currency: 'AUD', confidence: 0.95 }),
      llmResult({ intent: 'expense', amount: 30, currency: 'AUD', category: 'Groceries', confidence: 0.95 }),
    );

    const asked = await h.pipeline.parse('spent 30', h.context);
    expect(asked).toMatchObject({ kind: 'clarify', reason: 'missing_category' });

    const answered = await h.pipeline.answerClarification(h.context, 'spent 30', 'missing_category', 'groceries');

    expect(h.llm.calls[1]!.text).toBe('spent 30 groceries');
    expect(answered).toMatchObject({ kind: 'recorded' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ amountMinorUnits: 3000n, categoryId: categoryId('Groceries') });
    // One row per parse, the answered attempt included — M9's invariant does not get
    // an exemption for the second half of a conversation.
    expect(h.parseEvents.events).toHaveLength(2);
  });

  it('lets the answer stand alone when the original had two amounts', async () => {
    const h = makeHarness();

    const asked = await h.pipeline.parse('coffee 5 and lunch 16', h.context);
    expect(asked).toMatchObject({ kind: 'clarify', reason: 'multiple_amounts' });

    const answered = await h.pipeline.answerClarification(h.context, 'coffee 5 and lunch 16', 'multiple_amounts', 'coffee 5');

    // Appending would still have carried two amounts and asked the same question.
    expect(answered).toMatchObject({ kind: 'recorded', route: 'mapping' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ amountMinorUnits: 500n, categoryId: categoryId('Coffee') });
    expect(h.llm.calls).toHaveLength(0);
  });

  /**
   * The production transcript of 13 Sep 2026, verbatim. "coffee 5" carries one bare
   * amount, so the mechanical layer passes it; the model then asks the question it is
   * told to ask about a bare number ("one coffee for $5, or two $5 coffees?"). Both
   * answers restate that same $5.
   *
   * Before the restatement rule, `model_asked` appended: round two parsed "coffee 5
   * one coffee for 5 dollars" and round three "coffee 5 one coffee for 5 dollars one
   * transaction for $5" — two *explicit* amounts — and `mechanicalGuard` refused the
   * whole conversation with "I found more than one amount", about a single $5 the
   * user had said three times. Each further answer made it worse.
   */
  it('never accumulates a restated amount across rounds, however many the model asks', async () => {
    const h = makeHarness({ seedMappings: false });
    const asksAboutTheAmount = (question: string): ReturnType<typeof llmResult> =>
      llmResult({ intent: 'expense', needsClarification: true, clarificationQuestion: question });
    h.llm.enqueue(
      asksAboutTheAmount('Is this one coffee for $5, or two separate $5 coffee purchases?'),
      asksAboutTheAmount('Is this one transaction for $5, or two separate coffees of $5 each?'),
      llmResult({ intent: 'expense', amount: 5, currency: 'AUD', merchant: 'Coffee', category: 'Coffee', confidence: 0.95 }),
    );

    const first = await h.pipeline.parse('coffee 5', h.context);
    expect(first).toMatchObject({ kind: 'clarify', reason: 'model_asked', parsedText: 'coffee 5' });

    const second = await h.pipeline.answerClarification(h.context, 'coffee 5', 'model_asked', 'one coffee for 5 dollars');
    // The answer states money of its own, so it supersedes rather than accumulating.
    expect(h.llm.calls[1]!.text).toBe('one coffee for 5 dollars');
    expect(second).toMatchObject({ kind: 'clarify', reason: 'model_asked', parsedText: 'one coffee for 5 dollars' });

    const third = await h.pipeline.answerClarification(
      h.context,
      'one coffee for 5 dollars',
      'model_asked',
      'one transaction for $5',
    );

    expect(h.llm.calls[2]!.text).toBe('one transaction for $5');
    expect(third).toMatchObject({ kind: 'recorded' });
    expect(h.ledger.recorded).toHaveLength(1);
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({
      amountMinorUnits: 500n,
      categoryId: categoryId('Coffee'),
    });
  });

  /**
   * The other side of the same rule. An answer is only a restatement when there was
   * something to restate: "12.50" answering "how much was it?" is the missing piece,
   * and replacing would throw away the merchant the question was never about.
   */
  it('still appends an amount to a message that had none', async () => {
    const h = makeHarness();
    h.llm.enqueue(
      llmResult({ intent: 'expense', amount: null, merchant: 'Woolworths', category: 'Groceries', confidence: 0.9 }),
    );

    const asked = await h.pipeline.parse('woolies', h.context);
    expect(asked).toMatchObject({ kind: 'clarify', reason: 'no_amount' });

    const answered = await h.pipeline.answerClarification(h.context, 'woolies', 'no_amount', '12.50');

    expect(answered).toMatchObject({ kind: 'recorded', route: 'mapping' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ amountMinorUnits: 1250n, categoryId: categoryId('Groceries') });
  });

  /**
   * A bare number the original did not already state is not a restatement — it is
   * the very token the model could not tell from a quantity. "2" answering "one
   * coffee or two?" is a count, and a category called "Cafe 63" is a name; neither
   * may quietly become the transaction's amount by standing alone.
   */
  it('does not treat an unrelated bare number in the answer as a restated amount', async () => {
    const h = makeHarness({ seedMappings: false });
    h.llm.enqueue(llmResult({ intent: 'expense', amount: 30, currency: 'AUD', confidence: 0.95 }));

    await h.pipeline.parse('spent 30', h.context);
    const answered = await h.pipeline.answerClarification(h.context, 'spent 30', 'missing_category', 'cafe 63');

    expect(answered).toMatchObject({ kind: 'clarify', parsedText: 'spent 30 cafe 63' });
  });

  /** A bare number that repeats the one already stated is a restatement by definition. */
  it('treats a bare repeat of the amount already stated as a restatement', async () => {
    const h = makeHarness({ seedMappings: false });
    h.llm.enqueue(
      llmResult({ intent: 'expense', needsClarification: true, clarificationQuestion: 'One coffee, or two?' }),
      llmResult({ intent: 'expense', amount: 5, currency: 'AUD', merchant: 'Coffee', category: 'Coffee', confidence: 0.95 }),
    );

    await h.pipeline.parse('coffee 5', h.context);
    const answered = await h.pipeline.answerClarification(h.context, 'coffee 5', 'model_asked', 'just the one, 5');

    expect(h.llm.calls[1]!.text).toBe('just the one, 5');
    expect(answered).toMatchObject({ kind: 'recorded' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ amountMinorUnits: 500n });
  });

  it('lets the answer stand alone when the original had a decimal comma', async () => {
    const h = makeHarness();

    const asked = await h.pipeline.parse('coffee 4,50', h.context);
    expect(asked).toMatchObject({ kind: 'clarify', reason: 'invalid_amount' });

    const answered = await h.pipeline.answerClarification(h.context, 'coffee 4,50', 'invalid_amount', 'coffee 4.50');

    expect(answered).toMatchObject({ kind: 'recorded', route: 'mapping' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ amountMinorUnits: 450n });
  });
});
