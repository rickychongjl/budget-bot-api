import { describe, expect, it } from 'vitest';
import { formatMinorUnits, toMinorUnits } from '../../src/core/domain/money';
import type { ParseOutcome } from '../../src/parsing/types';
import baseline from './baseline.json';
import { EVAL_CASES, EVAL_SET_VERSION, type EvalCase, type EvalTag } from './cases.v1';
import { CATEGORIES, TODAY, USER_ID, makeHarness } from './fixture';

/**
 * Deterministic eval: the whole pipeline against `cases.v1.ts` with a scripted LLM.
 * Measures — and prints — the pass rate as a number (M6 "Tests to write": "tracked as
 * a number, not a guess"). The ratchet in `baseline.json` is the last committed
 * measurement; the run fails if the rate drops below it.
 *
 * Also asserts the M6/M9 invariants across EVERY case, pass or fail:
 *   - exactly one `parse_event` per parse, never containing message text;
 *   - no merchant mapping is ever created by parsing alone;
 *   - a message with several amounts is never recorded (ask to split).
 */

interface CaseResult {
  id: string;
  tags: readonly EvalTag[];
  passed: boolean;
  failures: string[];
}

async function runCase(c: EvalCase): Promise<{ result: CaseResult; outcome: ParseOutcome; h: ReturnType<typeof makeHarness> }> {
  const h = makeHarness(c.llm !== undefined ? { llm: c.llm } : {});
  const outcome = await h.pipeline.parse(c.text, h.context);
  const failures: string[] = [];
  const e = c.expect;

  if (outcome.kind !== e.kind) failures.push(`kind: expected ${e.kind}, got ${outcome.kind}${outcome.kind === 'clarify' ? ` (${outcome.reason})` : ''}`);
  if (outcome.route !== e.route) failures.push(`route: expected ${e.route}, got ${outcome.route}`);
  const llmCalled = h.llm.calls.length > 0;
  if (llmCalled !== e.llmCalled) failures.push(`llmCalled: expected ${e.llmCalled}, got ${llmCalled}`);

  if (outcome.kind === 'clarify' && e.kind === 'clarify' && e.reason !== undefined && outcome.reason !== e.reason) {
    failures.push(`reason: expected ${e.reason}, got ${outcome.reason}`);
  }

  const candidate =
    outcome.kind === 'recorded' ? h.ledger.recorded[0]?.candidate : outcome.kind === 'confirm' ? outcome.candidate : undefined;
  if (candidate !== undefined && e.kind !== 'clarify') {
    if (e.direction !== undefined && candidate.direction !== e.direction) failures.push(`direction: expected ${e.direction}, got ${candidate.direction}`);
    if (e.amount !== undefined) {
      const want = toMinorUnits(e.amount, 'AUD');
      if (candidate.amountMinorUnits !== want) failures.push(`amount: expected ${e.amount}, got ${formatMinorUnits(candidate.amountMinorUnits, 'AUD')}`);
    }
    if (e.occurredOn !== undefined && candidate.occurredOn !== e.occurredOn) failures.push(`occurredOn: expected ${e.occurredOn}, got ${candidate.occurredOn}`);
    if (e.category !== undefined) {
      const wantId = e.category === null ? null : CATEGORIES.find((x) => x.name === e.category)?.id ?? 'MISSING';
      if (candidate.categoryId !== wantId) failures.push(`category: expected ${e.category}, got ${candidate.categoryId}`);
    }
    if (e.proposal !== undefined && outcome.kind !== 'clarify') {
      const has = outcome.mappingProposal !== null;
      if (has !== e.proposal) failures.push(`proposal: expected ${e.proposal}, got ${has}`);
    }
  } else if (e.kind !== 'clarify' && candidate === undefined) {
    failures.push('no candidate reached the ledger/confirm step');
  }

  return { result: { id: c.id, tags: c.tags, passed: failures.length === 0, failures }, outcome, h };
}

describe(`M6 eval set v${EVAL_SET_VERSION} — deterministic tiers`, () => {
  it('has unique ids and a sane size', () => {
    const ids = new Set(EVAL_CASES.map((c) => c.id));
    expect(ids.size).toBe(EVAL_CASES.length);
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(100);
    expect(EVAL_CASES.length).toBeLessThanOrEqual(200);
  });

  it('measures the pass rate and holds the invariants on every case', async () => {
    const results: CaseResult[] = [];
    for (const c of EVAL_CASES) {
      const { result, outcome, h } = await runCase(c);
      results.push(result);

      // --- invariants, regardless of pass/fail --------------------------------
      expect(h.parseEvents.events, `${c.id}: exactly one parse_event`).toHaveLength(1);
      const event = h.parseEvents.events[0]!;
      const serialised = JSON.stringify(Object.values(event)).toLowerCase();
      for (const word of c.text.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)) {
        expect(serialised, `${c.id}: parse_event must not contain message text ("${word}")`).not.toContain(word);
      }
      expect(event.userId).toBe(USER_ID);
      expect(event.route).toBe(outcome.route);
      expect(event.neededClarification).toBe(outcome.kind === 'clarify');
      if (h.llm.calls.length > 0 && c.llm !== undefined && typeof c.llm === 'object' && 'usage' in c.llm) {
        expect(event.model).toBe(c.llm.usage?.model ?? null);
      }
      expect(h.mappings.saves, `${c.id}: parsing alone must never create a mapping`).toHaveLength(0);
      if (c.tags.includes('multi')) {
        expect(h.ledger.recorded, `${c.id}: multiple amounts must never be recorded`).toHaveLength(0);
        expect(outcome.kind).toBe('clarify');
      }
      for (const call of h.llm.calls) {
        expect(Object.keys(call.context).sort()).toEqual(['categoryNames', 'currencyCode']);
        expect(JSON.stringify(call)).not.toContain(USER_ID);
      }
      if (outcome.kind === 'recorded') {
        expect(h.ledger.recorded).toHaveLength(1);
        expect(h.ledger.recorded[0]!.candidate.rawText).toBe(c.text);
        if (outcome.transaction.direction !== 'income' && outcome.transaction.categoryId !== null) {
          expect(h.allowance.recalculated).toEqual([{ userId: USER_ID, categoryId: outcome.transaction.categoryId }]);
        }
      } else {
        expect(h.ledger.recorded, `${c.id}: ${outcome.kind} must not record`).toHaveLength(0);
      }
    }

    // --- the number ---------------------------------------------------------
    const passed = results.filter((r) => r.passed).length;
    const rate = passed / results.length;
    const byTag = new Map<EvalTag, { passed: number; total: number }>();
    for (const r of results) {
      for (const t of r.tags) {
        const s = byTag.get(t) ?? { passed: 0, total: 0 };
        s.total += 1;
        if (r.passed) s.passed += 1;
        byTag.set(t, s);
      }
    }
    const lines = [
      `M6 eval v${EVAL_SET_VERSION} (today=${TODAY}): ${passed}/${results.length} = ${(rate * 100).toFixed(1)}% (baseline ${(baseline.deterministicPassRate * 100).toFixed(1)}%)`,
      ...[...byTag.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([tag, s]) => `  ${tag.padEnd(18)} ${String(s.passed).padStart(3)}/${String(s.total).padEnd(3)} ${((s.passed / s.total) * 100).toFixed(0)}%`),
      ...results.filter((r) => !r.passed).map((r) => `  FAIL ${r.id}: ${r.failures.join('; ')}`),
    ];
    console.log(lines.join('\n'));

    expect(rate, 'pass rate fell below the committed baseline — investigate before lowering baseline.json').toBeGreaterThanOrEqual(
      baseline.deterministicPassRate,
    );
  });
});
