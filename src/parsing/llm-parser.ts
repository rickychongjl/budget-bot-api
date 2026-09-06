import type { CurrencyCode } from '../core/shared/common';

/**
 * M6 — the provider-neutral LLM port (M1 §2 repo layout: `ports/ ... llm parser`).
 * GPT-5.4 nano is the v1 choice; this port is what makes swapping a provider later
 * possible without touching core modules (M1 "Out of scope").
 *
 * Privacy rule, binding from the first line of code (M9): the prompt carries ONLY
 * the message text, the user's category names, and their currency. No Telegram id,
 * no internal user id, no conversation history. That constraint is encoded in
 * `LlmParserContext` — there is nowhere to put anything else.
 */

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
}

export interface LlmParserContext {
  categoryNames: readonly string[];
  currencyCode: CurrencyCode;
}

export interface LlmParser {
  /**
   * Returns structured fields for the application validator to accept or reject —
   * the server is authoritative even at high reported confidence. Implementations
   * handle refusals, incomplete responses, and API failures without recording
   * anything.
   */
  parse(messageText: string, context: LlmParserContext): Promise<LlmParseResult>;
}
