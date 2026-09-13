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

  it('lets the answer stand alone when the original had a decimal comma', async () => {
    const h = makeHarness();

    const asked = await h.pipeline.parse('coffee 4,50', h.context);
    expect(asked).toMatchObject({ kind: 'clarify', reason: 'invalid_amount' });

    const answered = await h.pipeline.answerClarification(h.context, 'coffee 4,50', 'invalid_amount', 'coffee 4.50');

    expect(answered).toMatchObject({ kind: 'recorded', route: 'mapping' });
    expect(h.ledger.recorded[0]!.candidate).toMatchObject({ amountMinorUnits: 450n });
  });
});
