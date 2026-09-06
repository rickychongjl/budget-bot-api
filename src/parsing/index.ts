/**
 * M6 — NLP Parsing & Merchant Memory (Phase 1). Folds in M9's fixed pieces.
 *
 * The hybrid pipeline: normaliser -> mechanical extractors -> merchant-memory lookup
 * -> `LlmParser` (`core/ports/llm-parser.ts`, GPT-5.4 nano behind the port) ->
 * application validator -> confidence/clarification policy -> hand a
 * `ValidatedCandidate` to `LedgerService.record`. Owns `merchant_category_mapping`
 * (add `db/schema/merchant.ts` + the barrel) and writes a `parse_event` row
 * (`db/schema/observability.ts`) on every parse — routes/tokens/latencies/booleans
 * only, never message text.
 *
 * Empty until the M6 agent's PR.
 */
export {};
