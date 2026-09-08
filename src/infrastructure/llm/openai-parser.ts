import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Clock } from '../../core/shared/clock';
import type { Logger } from '../../observability/log';
import { NoopLogger } from '../../observability/log';
import { LlmParseError, type LlmParseResult, type LlmParser, type LlmParserContext, type LlmUsage } from '../../parsing/llm-parser';

/**
 * Stage 6 (M6 "End-to-end flow"): the schema-constrained LLM parser behind M6's
 * provider-neutral `LlmParser` port. GPT-5.4 nano via `openai.responses.parse`,
 * `reasoning: { effort: 'none' }`, a Zod schema matching the LLM contract
 * (M6 "LLM contract") — never prose.
 *
 * This is a concrete external-provider client, so it lives under `infrastructure/llm/`
 * (CLAUDE.md target structure); everything OpenAI-shaped — the SDK, the Zod schema,
 * the instructions, the snake_case wire contract — is confined to this file.
 *
 * Privacy (M9, binding): the request body carries the message text, the category
 * names, and the currency code. `buildPrompt` is exported so a test can assert that
 * is ALL it carries. No date is sent either — relative dates are resolved
 * mechanically (see `dates.ts`), so the model is told to return `null` for them.
 *
 * `OPENAI_API_KEY` is read from the Worker's secret binding by the caller and handed
 * in as a constructor argument; it is never logged (the logger only ever sees the
 * error class, HTTP status, and token counts).
 */
export const LLM_MODEL = 'gpt-5.4-nano';

/** Exactly M6's LLM contract, field for field. Strict structured output: every key required, nullable where the contract allows. */
export const LlmContractSchema = z.object({
  intent: z.enum(['expense', 'income', 'refund']),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  merchant: z.string().nullable(),
  category: z.string().nullable(),
  transaction_date: z.string().nullable(),
  confidence: z.number(),
  needs_clarification: z.boolean(),
  clarification_question: z.string().nullable(),
});
export type LlmContract = z.infer<typeof LlmContractSchema>;

export const INSTRUCTIONS = [
  'You extract ONE personal-finance transaction from a short chat message written by someone in Australia.',
  'Return only the structured fields. Never add prose.',
  'Rules:',
  '- amount: the single monetary amount as a plain number (no symbols). If there is no amount, or more than one distinct transaction amount, set amount to null and needs_clarification to true.',
  '- currency: the ISO 4217 code if the message states one (e.g. USD, NZD); otherwise the provided default currency.',
  '- merchant: the shop, service, or counterparty as written, tidied for capitalisation. null if none.',
  '- category: EXACTLY one of the provided category names, or null if none clearly fits. Never invent a category.',
  '- transaction_date: an ISO YYYY-MM-DD date ONLY if the message contains an explicit calendar date. For relative expressions (today, yesterday, last Friday) or no date, return null — you do not know what today is.',
  '- intent: expense (money out), income (money in that is not tied to an earlier expense, e.g. salary), refund (money back for an earlier expense). If money-in is ambiguous between income and refund, set needs_clarification to true.',
  '- confidence: 0 to 1, your honest confidence that amount, intent and category are all right.',
  '- needs_clarification: true when the amount, intent, or category cannot be determined without guessing, when the message describes several transactions, or when it is a correction/deletion of a previous entry rather than a new one.',
  '- clarification_question: one short, specific question in plain Australian English when needs_clarification is true; otherwise null.',
].join('\n');

/** The user-turn payload — everything the model sees besides `INSTRUCTIONS`. */
export function buildPrompt(messageText: string, context: LlmParserContext): string {
  return [
    `Default currency: ${context.currencyCode}`,
    `Categories: ${context.categoryNames.length > 0 ? context.categoryNames.join(', ') : '(none yet)'}`,
    'Message:',
    messageText,
  ].join('\n');
}

export interface OpenAiLlmParserOptions {
  apiKey: string;
  clock: Clock;
  logger?: Logger;
  model?: string;
  /** Test seam — a `fetch` the SDK uses instead of the global one. */
  fetch?: typeof fetch;
  /** Milliseconds; the SDK aborts the request after this. */
  timeoutMs?: number;
}

export class OpenAiLlmParser implements LlmParser {
  private readonly client: OpenAI;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly model: string;

  constructor(options: OpenAiLlmParserOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 1,
      timeout: options.timeoutMs ?? 15_000,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
    this.clock = options.clock;
    this.logger = options.logger ?? new NoopLogger();
    this.model = options.model ?? LLM_MODEL;
  }

  async parse(messageText: string, context: LlmParserContext): Promise<LlmParseResult> {
    const startedAt = this.clock.now();
    const usage = (input: number | null, output: number | null): LlmUsage => ({
      model: this.model,
      inputTokens: input,
      outputTokens: output,
      latencyMs: Math.max(0, this.clock.now() - startedAt),
    });

    let response;
    try {
      response = await this.client.responses.parse({
        model: this.model,
        reasoning: { effort: 'none' },
        instructions: INSTRUCTIONS,
        input: buildPrompt(messageText, context),
        text: { format: zodTextFormat(LlmContractSchema, 'transaction') },
        max_output_tokens: 300,
        store: false,
      });
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : null;
      // Never the request body, never the key: class name + status only.
      this.logger.log('warn', 'llm_parse_api_error', {
        errorClass: error instanceof Error ? error.name : typeof error,
        status: status ?? null,
      });
      throw new LlmParseError('api_error', 'LLM API call failed', usage(null, null));
    }

    const u = usage(response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null);

    if (response.status !== undefined && response.status !== 'completed') {
      const reason = response.incomplete_details?.reason ?? response.status;
      this.logger.log('warn', 'llm_parse_incomplete', { reason, ...usageFields(u) });
      throw new LlmParseError('incomplete', `LLM response ${reason}`, u);
    }

    for (const item of response.output) {
      if (item.type === 'message') {
        for (const content of item.content) {
          if (content.type === 'refusal') {
            this.logger.log('warn', 'llm_parse_refusal', usageFields(u));
            throw new LlmParseError('refusal', 'LLM refused', u);
          }
        }
      }
    }

    const parsed = response.output_parsed;
    if (parsed === null || parsed === undefined) {
      this.logger.log('warn', 'llm_parse_invalid_output', usageFields(u));
      throw new LlmParseError('invalid_output', 'LLM returned no parseable output', u);
    }
    return fromContract(parsed, u);
  }
}

function usageFields(u: LlmUsage): { model: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number } {
  return { model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, latencyMs: u.latencyMs };
}

/** Contract (snake_case, what the model emits) → port result (camelCase). */
export function fromContract(c: LlmContract, usage?: LlmUsage): LlmParseResult {
  return {
    intent: c.intent,
    amount: c.amount,
    currency: c.currency,
    merchant: c.merchant,
    category: c.category,
    transactionDate: c.transaction_date,
    confidence: c.confidence,
    needsClarification: c.needs_clarification,
    clarificationQuestion: c.clarification_question,
    ...(usage !== undefined ? { usage } : {}),
  };
}
