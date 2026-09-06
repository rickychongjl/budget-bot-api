/**
 * M6 — NLP Parsing & Merchant Memory (Phase 1). Folds in M9's fixed pieces.
 *
 * This barrel is the module's public surface (CLAUDE.md, "Public module exports") —
 * contracts and technology-free implementations only. Nothing here imports Drizzle,
 * the OpenAI SDK, or any other concrete client.
 *
 * The hybrid pipeline, one focused component per stage (M6 checklist step 2):
 *   normalizer.ts                  MessageNormalizer / DefaultMessageNormalizer
 *   mechanical-parser.ts           MechanicalTransactionParser
 *                                    / DefaultMechanicalTransactionParser
 *   merchant-mapping-repository.ts MerchantMappingRepository (merchant_category_mapping)
 *   llm-parser.ts                  LlmParser — the provider-neutral port
 *   validator.ts                   TransactionCandidateValidator
 *                                    / DefaultTransactionCandidateValidator
 *   parse-event-repository.ts      ParseEventRepository + ParseEventCorrectionHook
 *   pipeline.ts                    TransactionParsingPipeline (routing + confidence policy)
 *
 * The adapters that satisfy those ports live under `src/infrastructure/`:
 *   infrastructure/llm/openai-parser.ts                              (GPT-5.4 nano)
 *   infrastructure/database/repositories/drizzle-merchant-mapping-repository.ts
 *   infrastructure/database/repositories/drizzle-parse-event-repository.ts
 * and `infrastructure/create-parsing-pipeline.ts` is the production wiring M7 calls.
 *
 * Test doubles for every port live in `test/support/` (CLAUDE.md, "Testing").
 */
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
