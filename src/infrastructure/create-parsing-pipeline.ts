import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Clock } from '../core/ports/clock';
import type { DailyAllowanceService } from '../core/ports/daily-allowance-service';
import type { LedgerService } from '../core/ports/ledger-service';
import type { Logger } from '../observability/log';
import { DefaultMechanicalTransactionParser } from '../parsing/mechanical-parser';
import { DefaultMessageNormalizer } from '../parsing/normalizer';
import { TransactionParsingPipeline, type ParsingPolicy } from '../parsing/pipeline';
import { DefaultTransactionCandidateValidator } from '../parsing/validator';
import { DrizzleMerchantMappingRepository } from './database/repositories/drizzle-merchant-mapping-repository';
import { DrizzleParseEventRepository } from './database/repositories/drizzle-parse-event-repository';
import { OpenAiLlmParser } from './llm/openai-parser';

/**
 * Production wiring for M6's pipeline: the only place where the technology-free
 * parsing module meets its concrete Drizzle and OpenAI adapters.
 *
 * It lives under `infrastructure/` because that is the direction CLAUDE.md permits
 * (`infrastructure → core`, never the reverse) — `src/parsing/` must stay free of
 * Drizzle and the OpenAI SDK. Strictly speaking this composition belongs in
 * `src/index.ts`, the composition root; it stays a named factory until M7 wires
 * parsing into the Worker (see `docs/build-log.md`).
 */
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

/** M7 calls this once per request with the Worker's bindings. */
export function createParsingPipeline(options: CreateParsingPipelineOptions): TransactionParsingPipeline {
  const normalizer = new DefaultMessageNormalizer();
  return new TransactionParsingPipeline({
    clock: options.clock,
    normalizer,
    mechanicalParser: new DefaultMechanicalTransactionParser(normalizer),
    merchantMappings: new DrizzleMerchantMappingRepository(options.db),
    llmParser: new OpenAiLlmParser({
      apiKey: options.openAiApiKey,
      clock: options.clock,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    }),
    validator: new DefaultTransactionCandidateValidator(normalizer),
    parseEvents: new DrizzleParseEventRepository(options.db),
    ledger: options.ledger,
    allowance: options.allowance,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
  });
}
