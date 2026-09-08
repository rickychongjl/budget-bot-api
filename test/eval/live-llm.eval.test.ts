import { describe, expect, it } from 'vitest';
import { LlmParseError } from '../../src/parsing/llm-parser';
import { SystemClock } from '../../src/core/shared/clock';
import { OpenAiLlmParser } from '../../src/infrastructure/llm/openai-parser';
import { EVAL_CASES, EVAL_SET_VERSION } from './cases.v1';
import { CATEGORIES } from './fixture';

/**
 * Live eval: the real GPT-5.4 nano against every `live`-labelled case. Skipped
 * unless `OPENAI_API_KEY` is set (never in CI by default — it costs money and is
 * non-deterministic). Prints field-level accuracy and the confidence distribution —
 * this is the number M6's "Open decisions" says to set the thresholds from.
 *
 * It asserts nothing about the model's accuracy (that would be a guess); it only
 * asserts that every response was schema-valid or a classified failure.
 */
const apiKey = process.env.OPENAI_API_KEY;

describe.skipIf(!apiKey)(`M6 eval set v${EVAL_SET_VERSION} — live LLM`, () => {
  it('scores the model on the live-labelled cases', { timeout: 300_000 }, async () => {
    const parser = new OpenAiLlmParser({ apiKey: apiKey!, clock: new SystemClock() });
    const cases = EVAL_CASES.filter((c) => c.live !== undefined);
    const context = { categoryNames: CATEGORIES.map((c) => c.name), currencyCode: 'AUD' };

    let intentOk = 0, intentN = 0, amountOk = 0, amountN = 0, categoryOk = 0, categoryN = 0, clarifyOk = 0, clarifyN = 0;
    let failures = 0, inputTokens = 0, outputTokens = 0, latencyMs = 0;
    const confidences: number[] = [];
    const notes: string[] = [];

    for (const c of cases) {
      const live = c.live!;
      try {
        const r = await parser.parse(c.text, context);
        confidences.push(r.confidence);
        inputTokens += r.usage?.inputTokens ?? 0;
        outputTokens += r.usage?.outputTokens ?? 0;
        latencyMs += r.usage?.latencyMs ?? 0;
        if (live.intent !== undefined) { intentN++; if (r.intent === live.intent) intentOk++; else notes.push(`${c.id} intent ${r.intent}≠${live.intent}`); }
        if (live.amount !== undefined) { amountN++; if (r.amount === live.amount) amountOk++; else notes.push(`${c.id} amount ${r.amount}≠${live.amount}`); }
        if (live.category !== undefined) {
          categoryN++;
          if ((r.category ?? null)?.toLowerCase() === (live.category ?? null)?.toLowerCase()) categoryOk++;
          else notes.push(`${c.id} category ${r.category}≠${live.category}`);
        }
        if (live.needsClarification !== undefined) { clarifyN++; if (r.needsClarification === live.needsClarification) clarifyOk++; else notes.push(`${c.id} needsClarification ${r.needsClarification}≠${live.needsClarification}`); }
      } catch (error) {
        expect(error).toBeInstanceOf(LlmParseError);
        failures++;
        notes.push(`${c.id} ${(error as LlmParseError).code}`);
      }
    }

    const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${a}/${b} = ${((a / b) * 100).toFixed(1)}%`);
    const sorted = [...confidences].sort((a, b) => a - b);
    const q = (p: number): string => (sorted.length === 0 ? 'n/a' : String(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]));
    console.log(
      [
        `M6 live eval v${EVAL_SET_VERSION}: ${cases.length} cases, ${failures} failures`,
        `  intent             ${pct(intentOk, intentN)}`,
        `  amount             ${pct(amountOk, amountN)}`,
        `  category           ${pct(categoryOk, categoryN)}`,
        `  needsClarification ${pct(clarifyOk, clarifyN)}`,
        `  confidence p10/p50/p90: ${q(0.1)} / ${q(0.5)} / ${q(0.9)}`,
        `  tokens in/out: ${inputTokens}/${outputTokens}, mean latency ${cases.length > 0 ? Math.round(latencyMs / cases.length) : 0}ms`,
        ...notes.map((n) => `  ${n}`),
      ].join('\n'),
    );
  });
});
