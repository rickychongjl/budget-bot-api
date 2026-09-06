/**
 * M6 — NLP Parsing & Merchant Memory (Phase 1). Folds in M9's fixed pieces.
 *
 * The hybrid pipeline: normaliser -> mechanical extractors -> merchant-memory lookup
 * -> `LlmParser` (`./llm-parser.ts`, GPT-5.4 nano behind the port) ->
 * application validator -> confidence/clarification policy -> hand a
 * `ValidatedCandidate` to `LedgerService.record`. Owns `merchant_category_mapping`
 * (add `infrastructure/database/schema/merchant.ts` + the barrel) and writes a
 * `parse_event` row (`infrastructure/database/schema/observability.ts`) on every
 * parse — routes/tokens/latencies/booleans only, never message text.
 *
 * The contract below is fixed; the pipeline implementation and the OpenAI-backed
 * `LlmParser` (`infrastructure/llm/`) are empty until the M6 agent's PR.
 */
export type { LlmParseResult, LlmParser, LlmParserContext } from './llm-parser';
