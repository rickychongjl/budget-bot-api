import type { LocalDate } from '../../src/core/ports/common';
import type { ParseRoute, TransactionDirection } from '../../src/core/ports/ledger-service';
import { LlmParseError } from '../../src/parsing/llm-parser';
import { llmResult, type ScriptedLlmResponse } from '../support/scripted-llm-parser';
import type { ClarifyReason } from '../../src/parsing/types';

/**
 * M6 evaluation set, version 1 (M6 checklist step 4). Realistic Australian
 * expense messages, hand-labelled against the fixture user in `fixture.ts`
 * (Sunday 6 Sep 2026, Brisbane, AUD, categories + confirmed mappings as listed there).
 *
 * Two runners consume this file:
 *   - `deterministic.eval.test.ts` — runs the whole pipeline with a SCRIPTED LLM
 *     (`llm` below is what the model "answers"), so it measures routing, extraction,
 *     validation and policy — everything except the model itself. Runs in CI.
 *   - `live-llm.eval.test.ts` — sends `live`-labelled cases to the real GPT-5.4
 *     nano and scores its answers. Skipped without `OPENAI_API_KEY`.
 *
 * Versioning: never edit a case's `text` in place — append a new case and bump
 * `EVAL_SET_VERSION` when the set changes meaningfully, so pass rates stay comparable.
 */
export const EVAL_SET_VERSION = 1;

export type EvalTag =
  | 'expense'
  | 'income'
  | 'refund'
  | 'currency'
  | 'date'
  | 'multi'
  | 'correction'
  | 'unknown-merchant'
  | 'multi-category'
  | 'typo'
  | 'shorthand'
  | 'mapping'
  | 'foreign'
  | 'validation'
  | 'llm-failure'
  | 'no-amount';

export interface EvalExpectation {
  kind: 'recorded' | 'confirm' | 'clarify';
  route: ParseRoute;
  llmCalled: boolean;
  direction?: TransactionDirection;
  /** Decimal text, e.g. "82.40". */
  amount?: string;
  occurredOn?: LocalDate;
  /** Category name; `null` asserts none (income). */
  category?: string | null;
  reason?: ClarifyReason;
  /** Whether a "remember this merchant?" proposal is offered. */
  proposal?: boolean;
}

export interface LiveExpectation {
  intent?: 'expense' | 'income' | 'refund';
  amount?: number | null;
  category?: string | null;
  needsClarification?: boolean;
}

export interface EvalCase {
  id: string;
  text: string;
  tags: readonly EvalTag[];
  expect: EvalExpectation;
  llm?: ScriptedLlmResponse;
  live?: LiveExpectation;
}

const recorded = (
  route: ParseRoute,
  amount: string,
  category: string | null,
  extra: Partial<EvalExpectation> = {},
): EvalExpectation => ({
  kind: 'recorded',
  route,
  llmCalled: route === 'llm',
  direction: 'expense',
  amount,
  category,
  occurredOn: '2026-09-06',
  proposal: false,
  ...extra,
});

const clarify = (route: ParseRoute, reason: ClarifyReason, llmCalled: boolean): EvalExpectation => ({
  kind: 'clarify',
  route,
  reason,
  llmCalled,
});

const apiDown = (): LlmParseError => new LlmParseError('api_error', 'scripted outage');

export const EVAL_CASES: readonly EvalCase[] = [
  // ---------------------------------------------------------------------------
  // Mapping route — merchant memory hits (no LLM call)
  // ---------------------------------------------------------------------------
  { id: 'map-001', text: 'woolies 82.40', tags: ['expense', 'mapping'], expect: recorded('mapping', '82.40', 'Groceries') },
  { id: 'map-002', text: '$82.40 at woolworths', tags: ['expense', 'mapping'], expect: recorded('mapping', '82.40', 'Groceries') },
  { id: 'map-003', text: 'spent 45 at coles yesterday', tags: ['expense', 'mapping', 'date'], expect: recorded('mapping', '45', 'Groceries', { occurredOn: '2026-09-05' }) },
  { id: 'map-004', text: 'Coles $120.55', tags: ['expense', 'mapping'], expect: recorded('mapping', '120.55', 'Groceries') },
  { id: 'map-005', text: 'aldi 63', tags: ['expense', 'mapping'], expect: recorded('mapping', '63', 'Groceries') },
  { id: 'map-006', text: 'coffee 4.5', tags: ['expense', 'mapping'], expect: recorded('mapping', '4.50', 'Coffee') },
  { id: 'map-007', text: 'coffee $5', tags: ['expense', 'mapping'], expect: recorded('mapping', '5', 'Coffee') },
  { id: 'map-008', text: 'netflix 22.99', tags: ['expense', 'mapping'], expect: recorded('mapping', '22.99', 'Subscriptions') },
  { id: 'map-009', text: 'rent 2k', tags: ['expense', 'mapping', 'shorthand'], expect: recorded('mapping', '2000', 'Rent') },
  { id: 'map-010', text: 'gym 25 on friday', tags: ['expense', 'mapping', 'date'], expect: recorded('mapping', '25', 'Health', { occurredOn: '2026-09-04' }) },
  { id: 'map-011', text: 'translink 5.30 this morning', tags: ['expense', 'mapping', 'date'], expect: recorded('mapping', '5.30', 'Transport') },
  { id: 'map-012', text: '7-eleven 50', tags: ['expense', 'mapping'], expect: recorded('mapping', '50', 'Fuel') },
  { id: 'map-013', text: 'opal top up 20', tags: ['expense', 'mapping'], expect: recorded('mapping', '20', 'Transport') },
  { id: 'map-014', text: 'Woolies 82.40', tags: ['expense', 'mapping'], expect: recorded('mapping', '82.40', 'Groceries') },
  { id: 'map-015', text: 'WOOLIES $82.40', tags: ['expense', 'mapping'], expect: recorded('mapping', '82.40', 'Groceries') },
  { id: 'map-016', text: 'uber eats 32.50', tags: ['expense', 'mapping'], expect: recorded('mapping', '32.50', 'Eating Out') },
  { id: 'map-017', text: 'spotify 12.99 today', tags: ['expense', 'mapping', 'date'], expect: recorded('mapping', '12.99', 'Subscriptions') },
  { id: 'map-018', text: '-50 groceries', tags: ['expense', 'mapping'], expect: recorded('mapping', '50', 'Groceries') },
  { id: 'map-019', text: 'coffee: $4', tags: ['expense', 'mapping'], expect: recorded('mapping', '4', 'Coffee') },
  { id: 'map-020', text: 'Coffee - $4.50', tags: ['expense', 'mapping'], expect: recorded('mapping', '4.50', 'Coffee') },
  { id: 'map-021', text: 'coffee $4.50!!', tags: ['expense', 'mapping'], expect: recorded('mapping', '4.50', 'Coffee') },
  { id: 'map-022', text: '$4.50 coffee ☕', tags: ['expense', 'mapping'], expect: recorded('mapping', '4.50', 'Coffee') },
  { id: 'map-023', text: '5 bucks coffee', tags: ['expense', 'mapping', 'currency'], expect: recorded('mapping', '5', 'Coffee') },
  { id: 'map-024', text: 'spent $12.5 on coffee', tags: ['expense', 'mapping', 'currency'], expect: recorded('mapping', '12.50', 'Coffee') },
  { id: 'map-025', text: 'paid 90 for groceries', tags: ['expense', 'mapping'], expect: recorded('mapping', '90', 'Groceries') },
  { id: 'map-026', text: 'just bought coffee 4.80', tags: ['expense', 'mapping'], expect: recorded('mapping', '4.80', 'Coffee') },

  // ---------------------------------------------------------------------------
  // Australian currency formats (mapping route so the format is what's tested)
  // ---------------------------------------------------------------------------
  { id: 'cur-001', text: '$1,250 rent', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '1250', 'Rent') },
  { id: 'cur-002', text: 'rent 1250 bucks', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '1250', 'Rent') },
  { id: 'cur-003', text: 'A$15 coffee', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '15', 'Coffee') },
  { id: 'cur-004', text: 'AUD 20 coffee', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '20', 'Coffee') },
  { id: 'cur-005', text: 'coffee 4.50 AUD', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '4.50', 'Coffee') },
  { id: 'cur-006', text: 'translink 50c', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '0.50', 'Transport') },
  { id: 'cur-007', text: 'coffee 4 dollars', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '4', 'Coffee') },
  { id: 'cur-008', text: 'woolies $1,024.10', tags: ['expense', 'currency', 'mapping'], expect: recorded('mapping', '1024.10', 'Groceries') },
  { id: 'cur-009', text: 'rent $1.5k', tags: ['expense', 'currency', 'mapping', 'shorthand'], expect: recorded('mapping', '1500', 'Rent') },
  { id: 'cur-010', text: 'coffee 4,50', tags: ['expense', 'currency', 'validation'], expect: clarify('mechanical', 'invalid_amount', false) },

  // ---------------------------------------------------------------------------
  // Australian date expressions
  // ---------------------------------------------------------------------------
  { id: 'date-001', text: 'coles 50 on 3/9', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '50', 'Groceries', { occurredOn: '2026-09-03' }) },
  { id: 'date-002', text: 'woolies 60 on 1 sep', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '60', 'Groceries', { occurredOn: '2026-09-01' }) },
  { id: 'date-003', text: 'aldi 40 last friday', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '40', 'Groceries', { occurredOn: '2026-09-04' }) },
  { id: 'date-004', text: 'coffee 4.50 on monday', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '4.50', 'Coffee', { occurredOn: '2026-08-31' }) },
  { id: 'date-005', text: 'netflix 22.99 on 2026-08-28', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '22.99', 'Subscriptions', { occurredOn: '2026-08-28' }) },
  { id: 'date-006', text: 'coles 90 25/12', tags: ['expense', 'date', 'validation'], expect: clarify('mapping', 'invalid_date', false) },
  { id: 'date-007', text: 'coffee 5 yesterday and today', tags: ['expense', 'date', 'validation'], expect: clarify('mapping', 'ambiguous_date', false) },
  { id: 'date-008', text: 'coles 70 day before yesterday', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '70', 'Groceries', { occurredOn: '2026-09-04' }) },
  { id: 'date-009', text: 'gym 25 2 days ago', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '25', 'Health', { occurredOn: '2026-09-04' }) },
  { id: 'date-010', text: 'aldi 55 on saturday', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '55', 'Groceries', { occurredOn: '2026-09-05' }) },
  { id: 'date-011', text: 'woolies 33 on the 2nd', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '33', 'Groceries', { occurredOn: '2026-09-02' }) },
  { id: 'date-012', text: 'coffee 4 on 30 aug', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '4', 'Coffee', { occurredOn: '2026-08-30' }) },
  { id: 'date-013', text: 'coffee 4 tomorrow', tags: ['expense', 'date', 'validation'], expect: clarify('mapping', 'invalid_date', false) },
  { id: 'date-014', text: 'coles 45 sept 1st', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '45', 'Groceries', { occurredOn: '2026-09-01' }) },
  { id: 'date-015', text: 'woolies 82.40 4/9', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '82.40', 'Groceries', { occurredOn: '2026-09-04' }) },
  { id: 'date-016', text: 'coles 50 3/9/26', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '50', 'Groceries', { occurredOn: '2026-09-03' }) },
  { id: 'date-017', text: 'coffee 4.20 last night', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '4.20', 'Coffee', { occurredOn: '2026-09-05' }) },
  { id: 'date-018', text: 'aldi 38 a week ago', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '38', 'Groceries', { occurredOn: '2026-08-30' }) },
  { id: 'date-019', text: 'woolies 77 on 31/08/2026', tags: ['expense', 'date', 'mapping'], expect: recorded('mapping', '77', 'Groceries', { occurredOn: '2026-08-31' }) },
  { id: 'date-020', text: 'coles 66 on 15 july', tags: ['expense', 'date', 'validation'], expect: clarify('mapping', 'invalid_date', false) },
  { id: 'date-021', text: 'coffee 4 on 31/9', tags: ['expense', 'date', 'validation'], expect: clarify('mechanical', 'invalid_date', false) },

  // ---------------------------------------------------------------------------
  // Explicit income — mechanical route (no LLM, no category)
  // ---------------------------------------------------------------------------
  { id: 'inc-001', text: '+2500 salary', tags: ['income'], expect: recorded('mechanical', '2500', null, { direction: 'income' }) },
  { id: 'inc-002', text: 'got paid 3200', tags: ['income'], expect: recorded('mechanical', '3200', null, { direction: 'income' }) },
  { id: 'inc-003', text: 'salary 4,250.00', tags: ['income', 'currency'], expect: recorded('mechanical', '4250', null, { direction: 'income' }) },
  { id: 'inc-004', text: 'centrelink payment 350', tags: ['income'], expect: recorded('mechanical', '350', null, { direction: 'income' }) },
  { id: 'inc-005', text: 'tax refund 1200', tags: ['income', 'refund'], expect: recorded('mechanical', '1200', null, { direction: 'income' }) },
  { id: 'inc-006', text: 'pay came in 1850.50', tags: ['income'], expect: recorded('mechanical', '1850.50', null, { direction: 'income' }) },
  { id: 'inc-007', text: 'income 500 from side gig', tags: ['income'], expect: recorded('mechanical', '500', null, { direction: 'income' }) },
  { id: 'inc-008', text: 'bonus 1000', tags: ['income'], expect: recorded('mechanical', '1000', null, { direction: 'income' }) },
  { id: 'inc-009', text: 'got paid $2,800.40 aud', tags: ['income', 'currency'], expect: recorded('mechanical', '2800.40', null, { direction: 'income' }) },
  { id: 'inc-010', text: '+80 from alex', tags: ['income'], expect: recorded('mechanical', '80', null, { direction: 'income' }) },
  { id: 'inc-011', text: 'payday! 3100', tags: ['income'], expect: recorded('mechanical', '3100', null, { direction: 'income' }) },
  { id: 'inc-012', text: 'got paid 1000 and spent 50', tags: ['income', 'multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'inc-013', text: 'dividend 42.15', tags: ['income'], expect: recorded('mechanical', '42.15', null, { direction: 'income' }) },

  // ---------------------------------------------------------------------------
  // Multiple amounts — must ask to split, never auto-split, never call the LLM
  // ---------------------------------------------------------------------------
  { id: 'multi-001', text: 'coffee 5 and lunch 16', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-002', text: '$4.50 coffee and $12 sandwich', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-003', text: 'petrol 60 groceries 120', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-004', text: 'woolies 80, coles 30', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-005', text: '2 coffees at 4.50 each', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-006', text: '3 x $12 tickets', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-007', text: 'lunch $18 plus $4 tip', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-008', text: 'bought 3 things 10 20 30', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-009', text: 'spent 20 at coles and 30 at woolies', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-010', text: 'coffee 4.50 x2', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-011', text: 'brekky 22 + coffee 5', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },
  { id: 'multi-012', text: 'dinner 85 split 4 ways', tags: ['multi'], expect: clarify('mechanical', 'multiple_amounts', false) },

  // ---------------------------------------------------------------------------
  // Corrections / deletions — need a previous transaction; never a new record
  // ---------------------------------------------------------------------------
  { id: 'corr-001', text: 'cancel the coffee from yesterday', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-002', text: 'delete last', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-003', text: 'actually it was 25 not 35', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-004', text: 'undo that', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-005', text: 'oops wrong amount', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-006', text: 'change the woolies one to 90', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-007', text: 'nvm', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-008', text: 'remove my last entry', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-009', text: 'that coffee should be 4.80', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-010', text: 'the coles one was actually groceries not eating out', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },
  { id: 'corr-011', text: 'scrap that', tags: ['correction'], expect: clarify('mechanical', 'correction_intent', false) },

  // ---------------------------------------------------------------------------
  // Foreign currency — no conversion in v1, clarify without an LLM call
  // ---------------------------------------------------------------------------
  { id: 'fx-001', text: 'usd 40 on steam', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },
  { id: 'fx-002', text: '€30 dinner in paris', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },
  { id: 'fx-003', text: '£12.50 tube', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },
  { id: 'fx-004', text: '50 nzd ferry', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },
  { id: 'fx-005', text: 'US$25 subscription', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },
  { id: 'fx-006', text: 'yen 500 ramen', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },
  { id: 'fx-007', text: 'coffee 4.50 usd', tags: ['foreign', 'currency'], expect: clarify('mechanical', 'foreign_currency', false) },

  // ---------------------------------------------------------------------------
  // Unknown / multi-category merchants — LLM route; Amazon-type never gets a mapping
  // ---------------------------------------------------------------------------
  {
    id: 'unk-001', text: 'amazon 45.99', tags: ['unknown-merchant', 'multi-category'],
    llm: llmResult({ intent: 'expense', amount: 45.99, currency: 'AUD', merchant: 'Amazon', category: 'Shopping', confidence: 0.9 }),
    expect: recorded('llm', '45.99', 'Shopping', { proposal: false }),
    live: { intent: 'expense', amount: 45.99 },
  },
  {
    id: 'unk-002', text: 'kmart 32', tags: ['unknown-merchant', 'multi-category'],
    llm: llmResult({ intent: 'expense', amount: 32, currency: 'AUD', merchant: 'Kmart', category: 'Shopping', confidence: 0.88 }),
    expect: recorded('llm', '32', 'Shopping', { proposal: false }),
    live: { intent: 'expense', amount: 32 },
  },
  {
    id: 'unk-003', text: 'bunnings 89.50', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 89.5, currency: 'AUD', merchant: 'Bunnings', category: 'Shopping', confidence: 0.7 }),
    expect: { kind: 'confirm', route: 'llm', llmCalled: true, amount: '89.50', category: 'Shopping', proposal: true },
    live: { intent: 'expense', amount: 89.5 },
  },
  {
    id: 'unk-004', text: 'spent 30 last night', tags: ['unknown-merchant', 'no-amount'],
    llm: llmResult({ intent: 'expense', amount: 30, currency: 'AUD', needsClarification: true, clarificationQuestion: 'What was the $30 for?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { intent: 'expense', amount: 30, needsClarification: true },
  },
  {
    id: 'unk-005', text: 'Alex gave me 80', tags: ['refund', 'income'],
    llm: llmResult({ intent: 'income', amount: 80, currency: 'AUD', needsClarification: true, clarificationQuestion: 'Was that a payment back for something you bought, or new money in?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { amount: 80, needsClarification: true },
  },
  {
    id: 'unk-006', text: 'lunch 15.50 at the new thai place', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 15.5, currency: 'AUD', merchant: 'Thai place', category: 'Eating Out', confidence: 0.92 }),
    expect: recorded('llm', '15.50', 'Eating Out', { proposal: false }),
    live: { intent: 'expense', amount: 15.5, category: 'Eating Out' },
  },
  {
    id: 'unk-007', text: 'bp 65.20 fuel', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 65.2, currency: 'AUD', merchant: 'BP', category: 'Fuel', confidence: 0.95 }),
    expect: recorded('llm', '65.20', 'Fuel', { proposal: true }),
    live: { intent: 'expense', amount: 65.2, category: 'Fuel' },
  },
  {
    id: 'unk-008', text: 'chemist warehouse 24.99', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 24.99, currency: 'AUD', merchant: 'Chemist Warehouse', category: 'Health', confidence: 0.9 }),
    expect: recorded('llm', '24.99', 'Health', { proposal: true }),
    live: { intent: 'expense', amount: 24.99, category: 'Health' },
  },
  {
    id: 'unk-009', text: 'mcdonalds 12.45', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 12.45, currency: 'AUD', merchant: "McDonald's", category: 'Eating Out', confidence: 0.97 }),
    expect: recorded('llm', '12.45', 'Eating Out', { proposal: true }),
    live: { intent: 'expense', amount: 12.45, category: 'Eating Out' },
  },
  {
    id: 'unk-010', text: 'woolworths 1234 brisbane 54.20', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 54.2, currency: 'AUD', merchant: 'Woolworths', category: 'Groceries', confidence: 0.93 }),
    expect: recorded('llm', '54.20', 'Groceries', { proposal: true }),
    live: { intent: 'expense', amount: 54.2, category: 'Groceries' },
  },
  {
    id: 'unk-011', text: 'ebay 19.95 phone case', tags: ['unknown-merchant', 'multi-category'],
    llm: llmResult({ intent: 'expense', amount: 19.95, currency: 'AUD', merchant: 'eBay', category: 'Shopping', confidence: 0.9 }),
    expect: recorded('llm', '19.95', 'Shopping', { proposal: false }),
    live: { intent: 'expense', amount: 19.95 },
  },
  {
    id: 'unk-012', text: 'big w 41', tags: ['unknown-merchant', 'multi-category'],
    llm: llmResult({ intent: 'expense', amount: 41, currency: 'AUD', merchant: 'Big W', category: 'Shopping', confidence: 0.86 }),
    expect: recorded('llm', '41', 'Shopping', { proposal: false }),
    live: { intent: 'expense', amount: 41 },
  },
  {
    id: 'unk-013', text: 'dan murphys 58', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 58, currency: 'AUD', merchant: "Dan Murphy's", category: 'Entertainment', confidence: 0.75 }),
    expect: { kind: 'confirm', route: 'llm', llmCalled: true, amount: '58', category: 'Entertainment', proposal: true },
    live: { intent: 'expense', amount: 58 },
  },
  {
    id: 'unk-014', text: 'electricity bill 212.40', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 212.4, currency: 'AUD', merchant: null, category: 'Utilities', confidence: 0.96 }),
    expect: recorded('llm', '212.40', 'Utilities', { proposal: false }),
    live: { intent: 'expense', amount: 212.4, category: 'Utilities' },
  },
  {
    id: 'unk-015', text: 'movie tickets 38 hoyts', tags: ['unknown-merchant'],
    llm: llmResult({ intent: 'expense', amount: 38, currency: 'AUD', merchant: 'Hoyts', category: 'Entertainment', confidence: 0.94 }),
    expect: recorded('llm', '38', 'Entertainment', { proposal: true }),
    live: { intent: 'expense', amount: 38, category: 'Entertainment' },
  },

  // ---------------------------------------------------------------------------
  // Server-side validation of LLM output — rejected even at confidence 0.99
  // ---------------------------------------------------------------------------
  {
    id: 'val-001', text: 'coffee at the airport 6.80', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 6.804, currency: 'AUD', merchant: 'Airport cafe', category: 'Coffee', confidence: 0.99 }),
    expect: clarify('llm', 'invalid_amount', true),
  },
  {
    id: 'val-002', text: 'servo 70', tags: ['validation', 'shorthand'],
    llm: llmResult({ intent: 'expense', amount: 70, currency: 'AUD', merchant: 'Servo', category: 'Petrol', confidence: 0.99 }),
    expect: clarify('llm', 'unknown_category', true),
    live: { intent: 'expense', amount: 70, category: 'Fuel' },
  },
  {
    id: 'val-003', text: 'dinner 60', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 65, currency: 'AUD', merchant: null, category: 'Eating Out', confidence: 0.99 }),
    expect: clarify('llm', 'invalid_amount', true),
    live: { intent: 'expense', amount: 60, category: 'Eating Out' },
  },
  {
    id: 'val-004', text: 'movies 24', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 24, currency: 'AUD', merchant: null, category: 'Entertainment', transactionDate: '2026-09-10', confidence: 0.99 }),
    expect: clarify('llm', 'invalid_date', true),
    live: { intent: 'expense', amount: 24, category: 'Entertainment' },
  },
  {
    id: 'val-005', text: 'parking 12', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 12, currency: 'USD', merchant: 'Parking', category: 'Transport', confidence: 0.99 }),
    expect: clarify('llm', 'foreign_currency', true),
    live: { intent: 'expense', amount: 12, category: 'Transport' },
  },
  {
    id: 'val-006', text: 'snacks 8', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 8, currency: 'AUD', merchant: null, category: 'Groceries', confidence: 0.6 }),
    expect: { kind: 'confirm', route: 'llm', llmCalled: true, amount: '8', category: 'Groceries', proposal: false },
  },
  {
    id: 'val-007', text: 'stuff 40', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 40, currency: 'AUD', merchant: null, category: 'Shopping', confidence: 0.3 }),
    expect: clarify('llm', 'low_confidence', true),
  },
  {
    id: 'val-008', text: 'lunch 14', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 14, currency: 'AUD', merchant: null, category: null, confidence: 0.9 }),
    expect: clarify('llm', 'missing_category', true),
    live: { intent: 'expense', amount: 14, category: 'Eating Out' },
  },
  {
    id: 'val-009', text: 'pizza 28.50', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: null, currency: 'AUD', merchant: null, category: 'Eating Out', confidence: 0.9 }),
    expect: clarify('llm', 'no_amount', true),
    live: { intent: 'expense', amount: 28.5, category: 'Eating Out' },
  },
  {
    id: 'val-010', text: 'lunch 14.20', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 14.2, currency: 'AUD', merchant: null, category: 'eating out', confidence: 0.9 }),
    expect: recorded('llm', '14.20', 'Eating Out', { proposal: false }),
  },
  {
    id: 'val-011', text: 'brunch 32', tags: ['validation'],
    llm: llmResult({ intent: 'expense', amount: 32, currency: 'AUD', merchant: 'Cafe', category: 'Eating Out', transactionDate: 'not-a-date', confidence: 0.9 }),
    expect: clarify('llm', 'invalid_date', true),
  },

  // ---------------------------------------------------------------------------
  // LLM failure paths — nothing recorded, parse_event still written
  // ---------------------------------------------------------------------------
  { id: 'fail-001', text: 'beer 9', tags: ['llm-failure'], llm: new LlmParseError('refusal', 'scripted refusal'), expect: clarify('llm', 'llm_unavailable', true) },
  { id: 'fail-002', text: 'haircut 45', tags: ['llm-failure'], llm: apiDown(), expect: clarify('llm', 'llm_unavailable', true) },
  { id: 'fail-003', text: 'vet 180', tags: ['llm-failure'], llm: new LlmParseError('incomplete', 'scripted max_output_tokens'), expect: clarify('llm', 'llm_unavailable', true) },
  { id: 'fail-004', text: 'phone bill 59', tags: ['llm-failure'], llm: new LlmParseError('invalid_output', 'scripted junk'), expect: clarify('llm', 'llm_unavailable', true) },

  // ---------------------------------------------------------------------------
  // Refunds / reimbursements
  // ---------------------------------------------------------------------------
  {
    id: 'ref-001', text: 'refund from kmart 32', tags: ['refund', 'multi-category'],
    llm: llmResult({ intent: 'refund', amount: 32, currency: 'AUD', merchant: 'Kmart', category: 'Shopping', confidence: 0.9 }),
    expect: recorded('llm', '32', 'Shopping', { direction: 'refund', proposal: false }),
    live: { intent: 'refund', amount: 32 },
  },
  { id: 'ref-002', text: 'woolies refunded me 15.60', tags: ['refund', 'mapping'], expect: recorded('mapping', '15.60', 'Groceries', { direction: 'refund' }) },
  {
    id: 'ref-003', text: 'got 40 back from the gym', tags: ['refund'],
    llm: llmResult({ intent: 'refund', amount: 40, currency: 'AUD', merchant: 'Gym', category: 'Health', confidence: 0.85 }),
    expect: recorded('llm', '40', 'Health', { direction: 'refund', proposal: false }),
    live: { intent: 'refund', amount: 40 },
  },
  {
    id: 'ref-004', text: 'sam paid me back 25 for dinner', tags: ['refund'],
    llm: llmResult({ intent: 'refund', amount: 25, currency: 'AUD', needsClarification: true, clarificationQuestion: 'Should I take $25 off an earlier dinner expense?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { amount: 25 },
  },
  {
    id: 'ref-005', text: 'reimbursement 120 from work', tags: ['refund', 'income'],
    llm: llmResult({ intent: 'income', amount: 120, currency: 'AUD', merchant: 'Work', category: null, confidence: 0.9 }),
    expect: recorded('llm', '120', null, { direction: 'income', proposal: false }),
    live: { amount: 120 },
  },
  {
    id: 'ref-006', text: 'coles refund 12.30', tags: ['refund', 'mapping'],
    expect: recorded('mapping', '12.30', 'Groceries', { direction: 'refund' }),
  },
  {
    id: 'ref-007', text: 'medicare rebate 78.40', tags: ['refund', 'income'],
    llm: llmResult({ intent: 'refund', amount: 78.4, currency: 'AUD', merchant: 'Medicare', category: 'Health', confidence: 0.9 }),
    expect: recorded('llm', '78.40', 'Health', { direction: 'refund', proposal: true }),
    live: { amount: 78.4 },
  },

  // ---------------------------------------------------------------------------
  // Spelling mistakes & shorthand — LLM route with a plausible model answer
  // ---------------------------------------------------------------------------
  {
    id: 'typo-001', text: 'wolies 45', tags: ['typo'],
    llm: llmResult({ intent: 'expense', amount: 45, currency: 'AUD', merchant: 'Woolworths', category: 'Groceries', confidence: 0.9 }),
    expect: recorded('llm', '45', 'Groceries', { proposal: true }),
    live: { intent: 'expense', amount: 45, category: 'Groceries' },
  },
  {
    id: 'typo-002', text: 'cofee 4.5', tags: ['typo'],
    llm: llmResult({ intent: 'expense', amount: 4.5, currency: 'AUD', merchant: 'Coffee', category: 'Coffee', confidence: 0.93 }),
    expect: recorded('llm', '4.50', 'Coffee', { proposal: true }),
    live: { intent: 'expense', amount: 4.5, category: 'Coffee' },
  },
  {
    id: 'typo-003', text: 'grocries 85', tags: ['typo'],
    llm: llmResult({ intent: 'expense', amount: 85, currency: 'AUD', merchant: null, category: 'Groceries', confidence: 0.92 }),
    expect: recorded('llm', '85', 'Groceries', { proposal: false }),
    live: { intent: 'expense', amount: 85, category: 'Groceries' },
  },
  {
    id: 'typo-004', text: 'ubr eats 32.50', tags: ['typo'],
    llm: llmResult({ intent: 'expense', amount: 32.5, currency: 'AUD', merchant: 'Uber Eats', category: 'Eating Out', confidence: 0.95 }),
    expect: recorded('llm', '32.50', 'Eating Out', { proposal: true }),
    live: { intent: 'expense', amount: 32.5, category: 'Eating Out' },
  },
  {
    id: 'short-001', text: 'maccas 12.45', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 12.45, currency: 'AUD', merchant: "McDonald's", category: 'Eating Out', confidence: 0.96 }),
    expect: recorded('llm', '12.45', 'Eating Out', { proposal: true }),
    live: { intent: 'expense', amount: 12.45, category: 'Eating Out' },
  },
  {
    id: 'short-002', text: 'grocs 110', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 110, currency: 'AUD', merchant: null, category: 'Groceries', confidence: 0.9 }),
    expect: recorded('llm', '110', 'Groceries', { proposal: false }),
    live: { intent: 'expense', amount: 110, category: 'Groceries' },
  },
  {
    id: 'short-003', text: 'brekky 18.50', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 18.5, currency: 'AUD', merchant: null, category: 'Eating Out', confidence: 0.9 }),
    expect: recorded('llm', '18.50', 'Eating Out', { proposal: false }),
    live: { intent: 'expense', amount: 18.5, category: 'Eating Out' },
  },
  {
    id: 'short-004', text: 'servo 60 fuel', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 60, currency: 'AUD', merchant: null, category: 'Fuel', confidence: 0.95 }),
    expect: recorded('llm', '60', 'Fuel', { proposal: false }),
    live: { intent: 'expense', amount: 60, category: 'Fuel' },
  },
  {
    id: 'short-005', text: "macca's run 15", tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 15, currency: 'AUD', merchant: "McDonald's", category: 'Eating Out', confidence: 0.94 }),
    expect: recorded('llm', '15', 'Eating Out', { proposal: true }),
    live: { intent: 'expense', amount: 15, category: 'Eating Out' },
  },
  {
    id: 'short-006', text: 'chemist 22.30', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 22.3, currency: 'AUD', merchant: 'Chemist', category: 'Health', confidence: 0.9 }),
    expect: recorded('llm', '22.30', 'Health', { proposal: true }),
    live: { intent: 'expense', amount: 22.3, category: 'Health' },
  },
  {
    id: 'short-007', text: 'arvo coffee 4.7 w/ sam', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 4.7, currency: 'AUD', merchant: null, category: 'Coffee', confidence: 0.9 }),
    expect: recorded('llm', '4.70', 'Coffee', { proposal: false }),
    live: { intent: 'expense', amount: 4.7, category: 'Coffee' },
  },
  {
    id: 'short-008', text: 'coffee five dollars', tags: ['shorthand', 'no-amount'],
    llm: llmResult({ intent: 'expense', amount: 5, currency: 'AUD', merchant: null, category: 'Coffee', confidence: 0.9 }),
    expect: recorded('llm', '5', 'Coffee', { proposal: false }),
    live: { intent: 'expense', amount: 5, category: 'Coffee' },
  },
  {
    id: 'short-009', text: 'ten dollars parking', tags: ['shorthand', 'no-amount'],
    llm: llmResult({ intent: 'expense', amount: 10, currency: 'AUD', merchant: 'Parking', category: 'Transport', confidence: 0.9 }),
    // No mechanical amount means no safe merchant key — nothing to propose remembering.
    expect: recorded('llm', '10', 'Transport', { proposal: false }),
    live: { intent: 'expense', amount: 10, category: 'Transport' },
  },
  {
    id: 'short-010', text: 'paid 50 for petrol', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 50, currency: 'AUD', merchant: null, category: 'Fuel', confidence: 0.95 }),
    expect: recorded('llm', '50', 'Fuel', { proposal: false }),
    live: { intent: 'expense', amount: 50, category: 'Fuel' },
  },
  {
    id: 'short-011', text: 'coffee 4.50 😅 again', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 4.5, currency: 'AUD', merchant: null, category: 'Coffee', confidence: 0.9 }),
    expect: recorded('llm', '4.50', 'Coffee', { proposal: false }),
    live: { intent: 'expense', amount: 4.5, category: 'Coffee' },
  },
  {
    id: 'short-012', text: 'lunch from coles 12', tags: ['shorthand'],
    llm: llmResult({ intent: 'expense', amount: 12, currency: 'AUD', merchant: 'Coles', category: 'Groceries', confidence: 0.8 }),
    expect: { kind: 'confirm', route: 'llm', llmCalled: true, amount: '12', category: 'Groceries', proposal: true },
    live: { intent: 'expense', amount: 12 },
  },

  // ---------------------------------------------------------------------------
  // No amount / not a transaction — the model should ask, the pipeline must not record
  // ---------------------------------------------------------------------------
  {
    id: 'none-001', text: 'coles', tags: ['no-amount'],
    llm: llmResult({ intent: 'expense', merchant: 'Coles', category: 'Groceries', needsClarification: true, clarificationQuestion: 'How much was it at Coles?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { needsClarification: true },
  },
  {
    id: 'none-002', text: 'hello', tags: ['no-amount'],
    llm: llmResult({ intent: 'expense', needsClarification: true, clarificationQuestion: 'What would you like to record?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { needsClarification: true },
  },
  {
    id: 'none-003', text: 'how much have i spent this week', tags: ['no-amount'],
    llm: llmResult({ intent: 'expense', needsClarification: true, clarificationQuestion: 'That is a question, not an expense — try /today.' }),
    expect: clarify('llm', 'model_asked', true),
    live: { needsClarification: true },
  },
  {
    id: 'none-004', text: 'thanks!', tags: ['no-amount'],
    llm: llmResult({ intent: 'expense', needsClarification: true, clarificationQuestion: 'Anything to record?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { needsClarification: true },
  },
  {
    id: 'none-005', text: 'coffee', tags: ['no-amount'],
    llm: llmResult({ intent: 'expense', category: 'Coffee', needsClarification: true, clarificationQuestion: 'How much was the coffee?' }),
    expect: clarify('llm', 'model_asked', true),
    live: { needsClarification: true },
  },
];
