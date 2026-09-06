import { describe, expect, it } from 'vitest';
import { LlmParseError } from '../../src/core/ports/llm-parser';
import { TestClock } from '../../src/core/testing/test-clock';
import type { LogFields, LogLevel, Logger } from '../../src/observability/log';
import { INSTRUCTIONS, LLM_MODEL, OpenAiLlmTransactionParser, buildPrompt } from '../../src/parsing/llm-parser';

/**
 * Drives the real OpenAI SDK through a fake `fetch`, so the request body we send
 * and the SDK's structured-output parsing are both exercised — no network.
 */
const API_KEY = 'sk-test-0123456789abcdefghijklmnop';
const CONTEXT = { categoryNames: ['Groceries', 'Coffee'], currencyCode: 'AUD' };

function responseBody(overrides: Record<string, unknown> = {}, contentText = JSON.stringify({
  intent: 'expense', amount: 82.4, currency: 'AUD', merchant: 'Woolworths', category: 'Groceries',
  transaction_date: null, confidence: 0.96, needs_clarification: false, clarification_question: null,
})): Record<string, unknown> {
  return {
    id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: LLM_MODEL, error: null, incomplete_details: null,
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: contentText, annotations: [] }] }],
    usage: { input_tokens: 480, output_tokens: 52, total_tokens: 532, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    ...overrides,
  };
}

class CapturingLogger implements Logger {
  readonly lines: { level: LogLevel; event: string; fields: LogFields }[] = [];
  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.lines.push({ level, event, fields });
  }
}

function harness(body: Record<string, unknown> | (() => Response)) {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const logger = new CapturingLogger();
  const clock = new TestClock('2026-09-06T02:00:00Z');
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    clock.advance(120);
    if (typeof body === 'function') return body();
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const parser = new OpenAiLlmTransactionParser({ apiKey: API_KEY, clock, logger, fetch: fetchFn });
  return { parser, requests, logger };
}

describe('OpenAiLlmTransactionParser', () => {
  it('calls responses.parse with gpt-5.4-nano, effort none, and a strict JSON schema of the contract', async () => {
    const { parser, requests } = harness(responseBody());
    const result = await parser.parse('woolies 82.40', CONTEXT);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toMatch(/\/responses$/);
    expect(req.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.4-nano');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.store).toBe(false);
    const format = (body.text as { format: Record<string, unknown> }).format;
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    const schema = format.schema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['amount', 'category', 'clarification_question', 'confidence', 'currency', 'intent', 'merchant', 'needs_clarification', 'transaction_date'],
    );
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);

    expect(result).toEqual({
      intent: 'expense', amount: 82.4, currency: 'AUD', merchant: 'Woolworths', category: 'Groceries',
      transactionDate: null, confidence: 0.96, needsClarification: false, clarificationQuestion: null,
      usage: { model: 'gpt-5.4-nano', inputTokens: 480, outputTokens: 52, latencyMs: 120 },
    });
  });

  it('sends only the message text, category names and currency — nothing else (M9)', async () => {
    const { parser, requests } = harness(responseBody());
    await parser.parse('woolies 82.40', CONTEXT);
    const body = requests[0]!.body as { instructions: string; input: string };
    expect(body.instructions).toBe(INSTRUCTIONS);
    expect(body.input).toBe(buildPrompt('woolies 82.40', CONTEXT));
    expect(body.input).toBe('Default currency: AUD\nCategories: Groceries, Coffee\nMessage:\nwoolies 82.40');
    // The whole request body, minus the schema/instructions, is exactly those three things.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/telegram|user_id|userId|chat_id|chatId|external_id|\d{4}-\d{2}-\d{2}/i);
  });

  it('throws LlmParseError on refusal, incomplete, invalid output and API errors — never a result', async () => {
    const refusal = harness(responseBody({
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }],
    }));
    await expect(refusal.parser.parse('x', CONTEXT)).rejects.toMatchObject({ name: 'LlmParseError', code: 'refusal', usage: { inputTokens: 480 } });

    const incomplete = harness(responseBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    await expect(incomplete.parser.parse('x', CONTEXT)).rejects.toMatchObject({ code: 'incomplete' });

    const invalid = harness(responseBody({}, '{"intent":"expense"'));
    await expect(invalid.parser.parse('x', CONTEXT)).rejects.toBeInstanceOf(LlmParseError);

    const wrongShape = harness(responseBody({}, JSON.stringify({ intent: 'party', amount: 'lots' })));
    await expect(wrongShape.parser.parse('x', CONTEXT)).rejects.toBeInstanceOf(LlmParseError);

    const down = harness(() => new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'content-type': 'application/json' } }));
    await expect(down.parser.parse('x', CONTEXT)).rejects.toMatchObject({ code: 'api_error' });
    expect(down.logger.lines.map((l) => l.event)).toContain('llm_parse_api_error');
  });

  it('never logs the API key, the message text, or the categories', async () => {
    const down = harness(() => new Response('{"error":{"message":"secret text woolies"}}', { status: 500, headers: { 'content-type': 'application/json' } }));
    await down.parser.parse('woolies 82.40', CONTEXT).catch(() => undefined);
    const refusal = harness(responseBody({
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }],
    }));
    await refusal.parser.parse('woolies 82.40', CONTEXT).catch(() => undefined);
    for (const line of [...down.logger.lines, ...refusal.logger.lines]) {
      const text = JSON.stringify(line);
      expect(text).not.toContain(API_KEY);
      expect(text).not.toMatch(/woolies|82\.40|Groceries/);
    }
  });
});
