import { TestClock } from '../../src/core/testing/test-clock';
import { DefaultMechanicalTransactionParser } from '../../src/parsing/mechanical-parser';
import { DefaultMessageNormalizer } from '../../src/parsing/normalizer';
import { TransactionParsingPipeline, type ParsingPolicy } from '../../src/parsing/pipeline';
import type { CategoryRef, UserParseContext } from '../../src/parsing/types';
import { DefaultTransactionCandidateValidator } from '../../src/parsing/validator';
import { InMemoryMerchantMappingRepository } from '../support/in-memory-merchant-mapping-repository';
import { InMemoryParseEventRepository } from '../support/in-memory-parse-event-repository';
import { RecordingAllowanceService } from '../support/recording-allowance-service';
import { RecordingLedgerService } from '../support/recording-ledger-service';
import { ScriptedLlmParser, type ScriptedLlmResponse } from '../support/scripted-llm-parser';

/**
 * One fixed user for every parser test and the eval set, so expectations can be
 * written by hand:
 *   - "now" is 2026-09-06T02:00:00Z = Sunday 6 Sep 2026, 12:00 in Brisbane (no DST).
 *   - AUD, account created 2026-08-01 (the backdating floor).
 *   - A realistic category set and a handful of merchant mappings the user has
 *     already confirmed (so the mapping route is exercised, not just the LLM route).
 */
export const NOW_ISO = '2026-09-06T02:00:00Z';
export const TODAY = '2026-09-06';
export const USER_ID = '00000000-0000-4000-8000-000000000001';

export const CATEGORIES: readonly CategoryRef[] = [
  { id: 'cat-groceries', name: 'Groceries' },
  { id: 'cat-eating-out', name: 'Eating Out' },
  { id: 'cat-coffee', name: 'Coffee' },
  { id: 'cat-transport', name: 'Transport' },
  { id: 'cat-fuel', name: 'Fuel' },
  { id: 'cat-rent', name: 'Rent' },
  { id: 'cat-utilities', name: 'Utilities' },
  { id: 'cat-entertainment', name: 'Entertainment' },
  { id: 'cat-health', name: 'Health' },
  { id: 'cat-shopping', name: 'Shopping' },
  { id: 'cat-subscriptions', name: 'Subscriptions' },
];

export const categoryId = (name: string): string => {
  const c = CATEGORIES.find((x) => x.name === name);
  if (c === undefined) throw new Error(`fixture: no category ${name}`);
  return c.id;
};

/** Mappings this user confirmed earlier — key is what they type, not a canonical name. */
export const CONFIRMED_MAPPINGS: readonly { key: string; display: string; category: string }[] = [
  { key: 'woolies', display: 'Woolworths', category: 'Groceries' },
  { key: 'woolworths', display: 'Woolworths', category: 'Groceries' },
  { key: 'coles', display: 'Coles', category: 'Groceries' },
  { key: 'aldi', display: 'ALDI', category: 'Groceries' },
  { key: 'groceries', display: 'Groceries', category: 'Groceries' },
  { key: 'coffee', display: 'Coffee', category: 'Coffee' },
  { key: 'netflix', display: 'Netflix', category: 'Subscriptions' },
  { key: 'spotify', display: 'Spotify', category: 'Subscriptions' },
  { key: 'translink', display: 'Translink', category: 'Transport' },
  { key: 'opal top up', display: 'Opal', category: 'Transport' },
  { key: '7-eleven', display: '7-Eleven', category: 'Fuel' },
  { key: 'gym', display: 'Gym', category: 'Health' },
  { key: 'rent', display: 'Rent', category: 'Rent' },
  { key: 'uber eats', display: 'Uber Eats', category: 'Eating Out' },
];

export const CONTEXT: UserParseContext = {
  userId: USER_ID,
  currencyCode: 'AUD',
  timezone: 'Australia/Brisbane',
  categories: CATEGORIES,
  accountCreatedOn: '2026-08-01',
};

export interface Harness {
  clock: TestClock;
  pipeline: TransactionParsingPipeline;
  llm: ScriptedLlmParser;
  mappings: InMemoryMerchantMappingRepository;
  parseEvents: InMemoryParseEventRepository;
  ledger: RecordingLedgerService;
  allowance: RecordingAllowanceService;
  context: UserParseContext;
}

export function makeHarness(options: { llm?: ScriptedLlmResponse; policy?: Partial<ParsingPolicy>; seedMappings?: boolean } = {}): Harness {
  const clock = new TestClock(NOW_ISO);
  const normalizer = new DefaultMessageNormalizer();
  const mappings = new InMemoryMerchantMappingRepository();
  if (options.seedMappings ?? true) {
    for (const m of CONFIRMED_MAPPINGS) {
      mappings.seed({
        userId: USER_ID,
        normalizedMerchant: m.key,
        displayMerchant: m.display,
        categoryId: categoryId(m.category),
        source: 'user_confirmed',
      });
    }
  }
  const parseEvents = new InMemoryParseEventRepository();
  const ledger = new RecordingLedgerService(() => clock.now());
  const allowance = new RecordingAllowanceService();
  const llm = new ScriptedLlmParser(options.llm);
  const pipeline = new TransactionParsingPipeline({
    clock,
    normalizer,
    mechanicalParser: new DefaultMechanicalTransactionParser(normalizer),
    merchantMappings: mappings,
    llmParser: llm,
    validator: new DefaultTransactionCandidateValidator(normalizer),
    parseEvents,
    ledger,
    allowance,
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
  });
  return { clock, pipeline, llm, mappings, parseEvents, ledger, allowance, context: CONTEXT };
}
