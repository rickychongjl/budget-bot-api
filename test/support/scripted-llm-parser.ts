import { LlmParseError, type LlmParseResult, type LlmParser, type LlmParserContext } from '../../src/parsing/llm-parser';

export type ScriptedLlmResponse =
  | LlmParseResult
  | LlmParseError
  | ((text: string, ctx: LlmParserContext) => LlmParseResult);

/**
 * An `LlmParser` that answers from a script instead of a model. Records every
 * call so tests can assert the prompt context (and that it is only text +
 * categories + currency) and count LLM-route usage.
 */
export class ScriptedLlmParser implements LlmParser {
  readonly calls: { text: string; context: LlmParserContext }[] = [];
  private queue: ScriptedLlmResponse[] = [];
  private fallback: ScriptedLlmResponse;

  constructor(fallback?: ScriptedLlmResponse) {
    this.fallback = fallback ?? new LlmParseError('api_error', 'no scripted response');
  }

  enqueue(...responses: ScriptedLlmResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  setFallback(response: ScriptedLlmResponse): this {
    this.fallback = response;
    return this;
  }

  async parse(text: string, context: LlmParserContext): Promise<LlmParseResult> {
    this.calls.push({ text, context });
    const next = this.queue.shift() ?? this.fallback;
    if (next instanceof LlmParseError) throw next;
    return typeof next === 'function' ? next(text, context) : next;
  }
}

/** A convenient way to write an `LlmParseResult` in a test. */
export function llmResult(partial: Partial<LlmParseResult> & Pick<LlmParseResult, 'intent'>): LlmParseResult {
  return {
    amount: null,
    currency: null,
    merchant: null,
    category: null,
    transactionDate: null,
    confidence: 0.95,
    needsClarification: false,
    clarificationQuestion: null,
    ...partial,
  };
}
