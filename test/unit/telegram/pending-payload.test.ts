import { describe, expect, it } from 'vitest';
import {
  decodePendingPayload,
  encodePendingPayload,
  type ClarifyPayload,
  type ConfirmPayload,
  type MappingPayload,
} from '../../../src/channels/telegram/pending-payload';
import type { ValidatedCandidate } from '../../../src/core/ledger/ledger-service';

/**
 * The codec is the only thing standing between a `bigint` amount and a jsonb column
 * that cannot hold one, and between a stale row and an unhandled exception inside
 * `waitUntil` — where a throw means the user simply hears nothing back.
 *
 * So this file asserts two properties and not much else: what goes in comes out
 * unchanged, and anything else comes out `null`.
 */

const CANDIDATE: ValidatedCandidate = {
  direction: 'expense',
  amountMinorUnits: 8950n,
  currencyCode: 'AUD',
  occurredAt: Date.parse('2026-09-11T02:00:00Z'),
  occurredOn: '2026-09-11',
  categoryId: 'cat-shopping',
  merchantDisplay: 'Bunnings',
  normalizedMerchant: 'bunnings',
  rawText: 'bunnings 89.50',
  parseRoute: 'llm',
  parseConfidence: 0.7,
};

const CONFIRM: ConfirmPayload = {
  kind: 'confirm',
  candidate: CANDIDATE,
  parseEventId: 'pe-1',
  categoryName: 'Shopping',
  mappingProposal: {
    normalizedMerchant: 'bunnings',
    displayMerchant: 'Bunnings',
    categoryId: 'cat-shopping',
    categoryName: 'Shopping',
  },
};

const CLARIFY: ClarifyPayload = {
  kind: 'clarify',
  original: 'spent 30 last night',
  reason: 'missing_category',
  question: 'Which category is that?',
  parseEventId: 'pe-2',
};

const MAPPING: MappingPayload = {
  kind: 'mapping',
  proposal: {
    normalizedMerchant: 'woolies',
    displayMerchant: 'Woolworths',
    categoryId: 'cat-groceries',
    categoryName: 'Groceries',
  },
};

/** What the column actually stores: whatever survives a JSON round trip. */
function throughJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('round trip', () => {
  it('carries a confirm payload through JSON with the amount still a bigint', () => {
    const stored = throughJson(encodePendingPayload(CONFIRM));

    expect(decodePendingPayload('confirm', stored)).toEqual(CONFIRM);
    expect(decodePendingPayload('confirm', stored)).toMatchObject({
      candidate: { amountMinorUnits: 8950n },
    });
  });

  it('writes the amount as decimal text, because JSON.stringify throws on a bigint', () => {
    // The failure this prevents is not subtle: without the codec the dispatcher
    // throws while *writing* the prompt, after M6 has already logged a parse event.
    expect(() => JSON.stringify(CONFIRM)).toThrow(TypeError);

    const encoded = encodePendingPayload(CONFIRM) as { candidate: { amountMinorUnits: unknown } };
    expect(encoded.candidate.amountMinorUnits).toBe('8950');
    expect(() => JSON.stringify(encoded)).not.toThrow();
  });

  it('keeps an absent optional absent rather than turning it into null', () => {
    const bare: ValidatedCandidate = {
      direction: 'income',
      amountMinorUnits: 250000n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-11T02:00:00Z'),
      occurredOn: '2026-09-11',
      categoryId: null,
      rawText: '+2500 salary',
      parseRoute: 'mechanical',
    };
    const payload: ConfirmPayload = { ...CONFIRM, candidate: bare, mappingProposal: null };

    const decoded = decodePendingPayload('confirm', throughJson(encodePendingPayload(payload)));

    expect(decoded).toEqual(payload);
    // `exactOptionalPropertyTypes` is on: a null here would be a different candidate
    // from the one M6 validated, and M3 is the thing that would notice.
    expect(decoded && 'merchantDisplay' in (decoded as ConfirmPayload).candidate).toBe(false);
  });

  it('carries a clarify payload, message text included', () => {
    const stored = throughJson(encodePendingPayload(CLARIFY));

    expect(decodePendingPayload('clarify', stored)).toEqual(CLARIFY);
  });

  it('carries a mapping payload', () => {
    const stored = throughJson(encodePendingPayload(MAPPING));

    expect(decodePendingPayload('mapping', stored)).toEqual(MAPPING);
  });
});

describe('anything else decodes to null', () => {
  it.each([
    ['not an object', 'nonsense'],
    ['null', null],
    ['an empty object', {}],
    ['a payload missing its candidate', { kind: 'confirm', parseEventId: 'pe-1', categoryName: null, mappingProposal: null }],
  ])('%s', (_name, raw) => {
    expect(decodePendingPayload('confirm', raw)).toBeNull();
  });

  it('refuses an amount that is a number rather than decimal text', () => {
    const encoded = encodePendingPayload(CONFIRM) as { candidate: Record<string, unknown> };
    encoded.candidate.amountMinorUnits = 8950;

    expect(decodePendingPayload('confirm', throughJson(encoded))).toBeNull();
  });

  it('refuses an amount that is not an integer', () => {
    const encoded = encodePendingPayload(CONFIRM) as { candidate: Record<string, unknown> };
    encoded.candidate.amountMinorUnits = '89.50';

    expect(decodePendingPayload('confirm', throughJson(encoded))).toBeNull();
  });

  it('refuses a clarify reason M6 does not have', () => {
    expect(decodePendingPayload('clarify', { ...CLARIFY, reason: 'vibes' })).toBeNull();
  });

  it('refuses a payload whose own kind disagrees with the row it was read from', () => {
    // The row's `kind` is the discriminator the dispatcher routes on, so a payload
    // that claims to be something else is not a payload we can act on.
    expect(decodePendingPayload('clarify', throughJson(encodePendingPayload(CONFIRM)))).toBeNull();
    expect(decodePendingPayload('mapping', throughJson(encodePendingPayload(CLARIFY)))).toBeNull();
    expect(decodePendingPayload('confirm', throughJson(encodePendingPayload(MAPPING)))).toBeNull();
  });
});
