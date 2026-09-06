import { describe, expect, it } from 'vitest';
import { MechanicalTransactionParser } from '../../src/parsing/mechanical-parser';
import { MessageNormalizer } from '../../src/parsing/normalizer';
import { TransactionCandidateValidator, type CandidateFields } from '../../src/parsing/validator';
import { CONTEXT, TODAY } from '../eval/fixture';

const normalizer = new MessageNormalizer();
const mechanical = new MechanicalTransactionParser(normalizer);
const validator = new TransactionCandidateValidator(normalizer);
const NOW = Date.parse('2026-09-06T02:00:00Z');

const llmFields = (over: Partial<CandidateFields>): CandidateFields => ({
  direction: 'expense',
  amountDecimal: '82.40',
  currencyCode: 'AUD',
  transactionDate: null,
  categoryName: 'Groceries',
  merchantDisplay: 'Woolworths',
  normalizedMerchant: 'woolies',
  route: 'llm',
  confidence: 0.99,
  ...over,
});

const validate = (text: string, fields: CandidateFields) =>
  validator.validate({ fields, mechanical: mechanical.parse(normalizer.normalize(text), TODAY), context: CONTEXT, today: TODAY, now: NOW });

describe('TransactionCandidateValidator', () => {
  it('accepts a good candidate and converts to minor units', () => {
    const r = validate('woolies 82.40', llmFields({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate.amountMinorUnits).toBe(8240n);
    expect(r.candidate.categoryId).toBe('cat-groceries');
    expect(r.candidate.occurredOn).toBe(TODAY);
    expect(r.candidate.occurredAt).toBe(NOW);
    expect(r.candidate.rawText).toBe('woolies 82.40');
    expect(r.candidate.parseConfidence).toBe(0.99);
  });

  it('rejects an exponent mismatch before persistence even at confidence 0.99', () => {
    const r = validate('woolies 82.404', llmFields({ amountDecimal: '82.404' }));
    expect(r).toMatchObject({ ok: false, reason: 'invalid_amount' });
  });

  it('rejects an amount the mechanical pass never saw (extractor conflict)', () => {
    expect(validate('dinner 60', llmFields({ amountDecimal: '65', categoryName: 'Eating Out' }))).toMatchObject({ ok: false, reason: 'invalid_amount' });
  });

  it('rejects a foreign currency — no conversion in v1', () => {
    expect(validate('parking 12', llmFields({ amountDecimal: '12', currencyCode: 'USD', categoryName: 'Transport' }))).toMatchObject({ ok: false, reason: 'foreign_currency' });
    expect(validate('coffee 4.50 usd', llmFields({ amountDecimal: '4.50', currencyCode: null, categoryName: 'Coffee' }))).toMatchObject({ ok: false, reason: 'foreign_currency' });
  });

  it('rejects unsupported / missing categories for expenses but not income', () => {
    expect(validate('servo 70', llmFields({ amountDecimal: '70', categoryName: 'Petrol' }))).toMatchObject({ ok: false, reason: 'unknown_category' });
    expect(validate('lunch 14', llmFields({ amountDecimal: '14', categoryName: null }))).toMatchObject({ ok: false, reason: 'missing_category' });
    const income = validate('got paid 3200', llmFields({ direction: 'income', amountDecimal: '3200', categoryName: null, route: 'mechanical' }));
    expect(income.ok).toBe(true);
    if (income.ok) expect(income.candidate.categoryId).toBeNull();
  });

  it('matches category names case-insensitively', () => {
    expect(validate('lunch 14.20', llmFields({ amountDecimal: '14.20', categoryName: 'eating out' })).ok).toBe(true);
  });

  it('rejects impossible, future, and pre-account dates', () => {
    expect(validate('brunch 32', llmFields({ amountDecimal: '32', transactionDate: 'not-a-date' }))).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(validate('movies 24', llmFields({ amountDecimal: '24', transactionDate: '2026-09-10' }))).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(validate('coles 90 25/12', llmFields({ amountDecimal: '90' }))).toMatchObject({ ok: false, reason: 'invalid_date' });
    expect(validate('coffee 4 tomorrow', llmFields({ amountDecimal: '4', categoryName: 'Coffee' }))).toMatchObject({ ok: false, reason: 'invalid_date' });
  });

  it('prefers the mechanical date and places backdated entries at local noon', () => {
    const r = validate('coles 50 on 3/9', llmFields({ amountDecimal: '50', transactionDate: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate.occurredOn).toBe('2026-09-03');
    expect(new Date(r.candidate.occurredAt).toISOString()).toBe('2026-09-03T02:00:00.000Z');
    // A model date that disagrees with the mechanical one is a conflict, not a tie-break.
    expect(validate('coles 50 on 3/9', llmFields({ amountDecimal: '50', transactionDate: '2026-09-02' }))).toMatchObject({ ok: false, reason: 'ambiguous_date' });
  });

  it('requires an amount', () => {
    expect(validate('pizza', llmFields({ amountDecimal: null }))).toMatchObject({ ok: false, reason: 'no_amount' });
  });
});
