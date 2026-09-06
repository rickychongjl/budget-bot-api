import type { CurrencyCode } from '../core/ports/common';

/**
 * M6 — the provider-neutral LLM port, owned by the module that consumes it
 * (CLAUDE.md "Ports and interfaces": module-owned contracts live in the owning
 * feature folder, not in a global `core/ports` dumping ground). The concrete
 * provider client lives in `src/infrastructure/llm/openai-parser.ts`.
 *
 * GPT-5.4 nano is the v1 choice; this port is what makes swapping a provider later
 * possible without touching the pipeline (M1 "Out of scope").
 *
 * Privacy rule, binding from the first line of code (M9): the prompt carries ONLY
 * the message text, the user's category names, and their currency. No Telegram id,
 * no internal user id, no conversation history — and no "today's date" either, which
 * is why relative dates ("yesterday") are resolved mechanically before/after the
 * call, never by the model. That constraint is encoded in `LlmParserContext` —
 * there is nowhere to put anything else.
 */

/**
 * Cost/latency facts about one call, for `parse_event` (M9). Never the prompt or
 * the completion text. Optional because a fake/scripted parser has no usage.
 */
export interface LlmUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

/** Schema-constrained fields the model returns — never prose. Mirrors M6's LLM contract. */
export interface LlmParseResult {
  intent: 'expense' | 'income' | 'refund';
  amount: number | null;
  currency: string | null;
  merchant: string | null;
  category: string | null;
  /** ISO `YYYY-MM-DD`. */
  transactionDate: string | null;
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  usage?: LlmUsage;
}

export interface LlmParserContext {
  categoryNames: readonly string[];
  currencyCode: CurrencyCode;
}

/**
 * Thrown (never swallowed into a recorded transaction) when the provider refuses,
 * returns an incomplete/unparseable response, or the API call fails. `usage` is
 * still attached where known so the failed call is costed in `parse_event`.
 */
export class LlmParseError extends Error {
  constructor(
    readonly code: 'refusal' | 'incomplete' | 'invalid_output' | 'api_error',
    message: string,
    readonly usage?: LlmUsage,
  ) {
    super(message);
    this.name = 'LlmParseError';
  }
}

export interface LlmParser {
  /**
   * Returns structured fields for the application validator to accept or reject —
   * the server is authoritative even at high reported confidence. Implementations
   * handle refusals, incomplete responses, and API failures by throwing
   * `LlmParseError`, never by inventing a result.
   */
  parse(messageText: string, context: LlmParserContext): Promise<LlmParseResult>;
}
