/**
 * M6 — NLP Parsing & Merchant Memory (Phase 1). Folds in M9's fixed pieces.
 *
 * The hybrid pipeline, one focused component per stage (M6 checklist step 2):
 *   normalizer.ts                  IMessageNormalizer
 *   mechanical-parser.ts           IMechanicalTransactionParser
 *   merchant-mapping-repository.ts IMerchantMappingRepository  (merchant_category_mapping)
 *   llm-parser.ts                  ILlmTransactionParser        (GPT-5.4 nano behind the port)
 *   validator.ts                   ITransactionCandidateValidator
 *   parse-event-repository.ts      IParseEventRepository + ParseEventCorrectionHook (parse_event)
 *   pipeline.ts                    TransactionParsingPipeline  (routing + confidence policy)
 *
 * `createParsingPipeline` is the production wiring; `testing/` holds in-memory
 * doubles for every port.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Clock } from '../core/ports/clock';
import type { DailyAllowanceService } from '../core/ports/daily-allowance-service';
import type { LedgerService } from '../core/ports/ledger-service';
import type { Logger } from '../observability/log';
import { OpenAiLlmTransactionParser } from './llm-parser';
import { MechanicalTransactionParser } from './mechanical-parser';
import { DrizzleMerchantMappingRepository } from './merchant-mapping-repository';
import { MessageNormalizer } from './normalizer';
import { DrizzleParseEventRepository } from './parse-event-repository';
import { TransactionParsingPipeline, type ParsingPolicy } from './pipeline';
import { TransactionCandidateValidator } from './validator';

export * from './types';
export * from './dates';
export * from './normalizer';
export * from './mechanical-parser';
export * from './merchant-mapping-repository';
export * from './parse-event-repository';
export * from './llm-parser';
export * from './validator';
export * from './multi-category-merchants';
export * from './pipeline';

export interface CreateParsingPipelineOptions {
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
  clock: Clock;
  /** `env.OPENAI_API_KEY` — a Wrangler secret; passed through, never logged. */
  openAiApiKey: string;
  ledger: LedgerService;
  allowance: DailyAllowanceService;
  logger?: Logger;
  policy?: Partial<ParsingPolicy>;
}

/** Production wiring. M7 calls this once per request with the Worker's bindings. */
export function createParsingPipeline(options: CreateParsingPipelineOptions): TransactionParsingPipeline {
  const normalizer = new MessageNormalizer();
  return new TransactionParsingPipeline({
    clock: options.clock,
    normalizer,
    mechanicalParser: new MechanicalTransactionParser(normalizer),
    merchantMappings: new DrizzleMerchantMappingRepository(options.db),
    llmParser: new OpenAiLlmTransactionParser({
      apiKey: options.openAiApiKey,
      clock: options.clock,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    }),
    validator: new TransactionCandidateValidator(normalizer),
    parseEvents: new DrizzleParseEventRepository(options.db),
    ledger: options.ledger,
    allowance: options.allowance,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
  });
}
