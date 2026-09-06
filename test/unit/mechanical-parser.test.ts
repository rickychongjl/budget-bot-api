import { describe, expect, it } from 'vitest';
import { DefaultMechanicalTransactionParser } from '../../src/parsing/mechanical-parser';
import { DefaultMessageNormalizer } from '../../src/parsing/normalizer';
import { TODAY } from '../eval/fixture';

const normalizer = new DefaultMessageNormalizer();
const parser = new DefaultMechanicalTransactionParser(normalizer);
const parse = (text: string, today = TODAY) => parser.parse(normalizer.normalize(text), today);

describe('MechanicalTransactionParser — amounts', () => {
  it('extracts AU money forms as decimal text, never floats', () => {
    expect(parse('$82.40 woolies').amounts.map((a) => a.decimal)).toEqual(['82.40']);
    expect(parse('woolies 82.4').amounts.map((a) => a.decimal)).toEqual(['82.4']);
    expect(parse('$1,250 rent').amounts.map((a) => a.decimal)).toEqual(['1250']);
    expect(parse('rent 2k').amounts.map((a) => a.decimal)).toEqual(['2000']);
    expect(parse('rent $1.5k').amounts.map((a) => a.decimal)).toEqual(['1500']);
    expect(parse('bus 50c').amounts.map((a) => a.decimal)).toEqual(['0.50']);
    expect(parse('5 bucks coffee').amounts.map((a) => a.decimal)).toEqual(['5']);
    expect(parse('coffee 4 dollars').amounts.map((a) => a.decimal)).toEqual(['4']);
  });

  it('keeps over-precise decimals so the validator can reject them', () => {
    expect(parse('coffee 82.404').amounts.map((a) => a.decimal)).toEqual(['82.404']);
  });

  it('treats bare integers as quantities when an explicit amount exists', () => {
    const c = parse('2 coffees $9');
    expect(c.amounts.map((a) => a.decimal)).toEqual(['9']);
    expect(c.hasExactlyOneAmount).toBe(true);
  });

  it('ignores digits glued to words and known unit suffixes', () => {
    expect(parse('7-eleven 50').amounts.map((a) => a.decimal)).toEqual(['50']);
    expect(parse('h2o 3').amounts.map((a) => a.decimal)).toEqual(['3']);
    expect(parse('2 x 4.50 coffee').hasMultipleAmounts).toBe(true);
    expect(parse('gym 25 2 days ago').amounts.map((a) => a.decimal)).toEqual(['25']);
    expect(parse('coles 70 day before yesterday').amounts.map((a) => a.decimal)).toEqual(['70']);
  });

  it('flags several amounts, multipliers and decimal commas', () => {
    expect(parse('coffee 5 and lunch 16').hasMultipleAmounts).toBe(true);
    expect(parse('$4.50 coffee and $12 sandwich').hasMultipleAmounts).toBe(true);
    expect(parse('2 coffees at 4.50 each').hasMultipleAmounts).toBe(true);
    expect(parse('coffee 4,50').hasAmbiguousDecimalComma).toBe(true);
    expect(parse('$1,250 rent').hasAmbiguousDecimalComma).toBe(false);
  });

  it('records explicit currency tokens', () => {
    expect(parse('usd 40 steam').currencyTokens).toEqual(['USD']);
    expect(parse('€30 dinner').currencyTokens).toEqual(['EUR']);
    expect(parse('£12.50 tube').currencyTokens).toEqual(['GBP']);
    expect(parse('50 nzd ferry').currencyTokens).toEqual(['NZD']);
    expect(parse('US$25 sub').currencyTokens).toEqual(['USD']);
    expect(parse('coffee 4.50 AUD').currencyTokens).toEqual(['AUD']);
    expect(parse('coffee $4.50').currencyTokens).toEqual([]);
  });
});

describe('MechanicalTransactionParser — dates (today = Sunday 2026-09-06)', () => {
  const on = (text: string) => parse(text).dates.map((d) => d.localDate);

  it('resolves relative expressions', () => {
    expect(on('coffee 4 today')).toEqual(['2026-09-06']);
    expect(on('coffee 4 yesterday')).toEqual(['2026-09-05']);
    expect(on('coffee 4 last night')).toEqual(['2026-09-05']);
    expect(on('coffee 4 day before yesterday')).toEqual(['2026-09-04']);
    expect(on('coffee 4 3 days ago')).toEqual(['2026-09-03']);
    expect(on('coffee 4 a week ago')).toEqual(['2026-08-30']);
    expect(on('coffee 4 tomorrow')).toEqual(['2026-09-07']);
  });

  it('resolves weekdays to the most recent occurrence', () => {
    expect(on('coffee 4 on friday')).toEqual(['2026-09-04']);
    expect(on('coffee 4 last friday')).toEqual(['2026-09-04']);
    expect(on('coffee 4 on sunday')).toEqual(['2026-09-06']);
    expect(on('coffee 4 last sunday')).toEqual(['2026-08-30']);
    expect(on('coffee 4 monday')).toEqual(['2026-08-31']);
    expect(on('coffee 4 sat')).toEqual([]); // bare abbreviation: too ambiguous
    expect(on('coffee 4 on sat')).toEqual(['2026-09-05']);
  });

  it('parses day-first numeric and month-name forms', () => {
    expect(on('coles 50 on 3/9')).toEqual(['2026-09-03']);
    expect(on('coles 50 3/9/26')).toEqual(['2026-09-03']);
    expect(on('coles 50 31/08/2026')).toEqual(['2026-08-31']);
    expect(on('coles 50 on 2026-08-28')).toEqual(['2026-08-28']);
    expect(on('coles 50 on 1 sep')).toEqual(['2026-09-01']);
    expect(on('coles 50 sept 1st')).toEqual(['2026-09-01']);
    expect(on('coles 50 on 30 aug')).toEqual(['2026-08-30']);
    expect(on('coles 50 on the 2nd')).toEqual(['2026-09-02']);
    // Year-less dates in the future roll back a year (validator then rejects them as before the floor).
    expect(on('coles 50 25/12')).toEqual(['2025-12-25']);
  });

  it('does not mistake decimals for dates', () => {
    expect(on('coffee 2.5')).toEqual([]);
    expect(parse('coffee 2.5').amounts.map((a) => a.decimal)).toEqual(['2.5']);
  });

  it('flags impossible dates and conflicting dates', () => {
    expect(parse('coffee 4 on 31/9').invalidDateTokens).toEqual(['31/9']);
    expect(parse('coffee 4 on 30 feb').invalidDateTokens).toEqual(['30 feb']);
    expect(parse('coffee 5 yesterday and today').hasConflictingDates).toBe(true);
    expect(parse('coles 45 sept 1st').invalidDateTokens).toEqual([]);
  });
});

describe('MechanicalTransactionParser — markers & description', () => {
  it('detects explicit income but not ambiguous money-in', () => {
    expect(parse('+2500 salary').isExplicitIncome).toBe(true);
    expect(parse('got paid 3200').isExplicitIncome).toBe(true);
    expect(parse('tax refund 1200').isExplicitIncome).toBe(true);
    expect(parse('paid 50 for petrol').isExplicitIncome).toBe(false);
    expect(parse('Alex gave me 80').isExplicitIncome).toBe(false);
    expect(parse('sam paid me back 25').isExplicitIncome).toBe(false);
  });

  it('detects corrections', () => {
    for (const t of ['cancel the coffee from yesterday', 'delete last', 'actually it was 25 not 35', 'nvm', 'that coffee should be 4.80']) {
      expect(parse(t).isCorrection, t).toBe(true);
    }
    expect(parse('coffee 4.50').isCorrection).toBe(false);
  });

  it('computes the merchant-memory key from what the user typed', () => {
    expect(parse('woolies 82.40').normalizedDescription).toBe('woolies');
    expect(parse('$82.40 at woolworths').normalizedDescription).toBe('woolworths');
    expect(parse('spent 45 at coles yesterday').normalizedDescription).toBe('coles');
    expect(parse('Coffee - $4.50').normalizedDescription).toBe('coffee');
    expect(parse('coffee: $4').normalizedDescription).toBe('coffee');
    expect(parse('-50 groceries').normalizedDescription).toBe('groceries');
    expect(parse('lunch 15.50 at the new thai place').normalizedDescription).toBe('lunch at the new thai place');
    expect(parse('spent 30 last night').normalizedDescription).toBe('');
    expect(parse('+2500 salary').normalizedDescription).toBe('salary');
    expect(parse('WOOLWORTHS 1234 BRISBANE 54.20').normalizedDescription).toBe('woolworths 1234 brisbane');
  });
});
