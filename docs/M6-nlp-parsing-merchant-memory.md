# M6 — NLP Parsing & Merchant Memory

**Phase:** 1 (parallel, after Phase 0 lands) — fold M9's fixed pieces into this agent's PR
**Notion status:** Agreed v1 technical direction, 30 Aug 2026 — model choice/prices should be rechecked before production launch
**One-line scope:** Converts natural-language messages into reliable transaction records while keeping cost low, never silently guessing, and learning each user's merchant preferences over time.

---

## Depends on
- **M1** for the provider-neutral LLM port and repo layout (`parsing/`).
- **M2** for the user's category list and currency default (context passed to the LLM).
- **M3** for what a "validated candidate" ultimately becomes (this module hands off to `LedgerService.record`, doesn't write transactions itself).

## Depended on by
- **M7** calls this module for every free-text message once it's routed past commands/clarifications.
- **M9**'s `parse_event` table is populated by this module on every parse (fold this into the same PR — see below).

---

## Owns
- The hybrid parsing pipeline (mechanical rules → merchant memory → LLM → validation → clarification)
- Merchant mapping storage and lifecycle
- (Folded in from M9 for this pass) the `parse_event` table and the logging rules that apply to every LLM call

## Does not own
- Recording the transaction — **M3**.
- Deciding categories/caps exist — **M4** via M3.
- Telegram-specific anything — **M7**.

---

## End-to-end flow
1. Channel adapter (M7) converts a Telegram update into a shared internal message.
2. Normaliser: trim whitespace, standardise symbols/case/currency forms.
3. Mechanical extractors: amounts, explicit signs, currency tokens, recognisable dates.
4. Merchant-memory lookup: exact/safe normalised match previously confirmed by this user.
5. Routing decision: accept an unquestionably structured result, or send to the LLM with safe context.
6. LLM parser returns schema-constrained fields, not prose.
7. Application validator: amounts, dates, categories, required fields, conflicts.
8. Confidence policy: record, ask for confirmation, or ask a targeted clarification.
9. Hand the validated candidate to M3 (`LedgerService.record`); M3/M5 handle persistence and allowance recalculation.
10. Return the confirmation shape to M7 for rendering.

### Illustrative routing (port to TypeScript, not C# — see M1's note on this)
```typescript
const candidate = mechanicalParser.parse(message);

if (candidate.isExplicitIncome && candidate.hasExactlyOneAmount) {
  return recordIncome(candidate);
}
if (candidate.hasExactlyOneAmount) {
  const mapping = await merchantMappings.find(userId, candidate.normalizedDescription);
  if (mapping !== null) return recordExpense(candidate, mapping.categoryId);
}
return await llmParser.parse(message, userContext);
```
All routes still pass full application validation and the confirmation/clarification policy before saving — one amount or a merchant match alone never bypasses conflict/required-field checks.

The provider-neutral `llmParser.parse` calls `openai.responses.parse` with `model: "gpt-5.4-nano"`, `reasoning: { effort: "none" }`, and a Zod schema via `zodTextFormat` matching the LLM contract below. Handle refusals, incomplete responses, and API failures without recording a transaction. `OPENAI_API_KEY` stays server-side only.

## LLM contract
```json
{
  "intent": "expense",
  "amount": 82.40,
  "currency": "AUD",
  "merchant": "Woolworths",
  "category": "Groceries",
  "transaction_date": "2026-08-30",
  "confidence": 0.96,
  "needs_clarification": false,
  "clarification_question": null
}
```
The server is authoritative — reject malformed amounts, impossible dates, unsupported categories, missing required fields, and any business-rule violation even when model confidence is high.

## Clarification policy — never guess
Clarify rather than guess for: `Alex gave me 80` (income/refund/reimbursement?), `spent 30 last night` (missing category/merchant), `coffee 5 and lunch 16` (multiple transactions — ask to split, per this pass's scope), `cancel the coffee from yesterday` (needs resolving a previous transaction), a merchant like Amazon that spans categories. Low LLM confidence is one signal among several — missing fields, conflicting extractors, and failed server validation also force clarification.

## Merchant memory
```sql
-- MerchantCategoryMapping — implement as a real table, e.g. merchant_category_mapping
id, user_id, normalized_merchant, display_merchant, category_id,
source ('user_confirmed' | 'user_corrected'), times_used,
created_at, updated_at, last_used_at
unique (user_id, normalized_merchant)
```
**Lifecycle:** LLM proposes merchant+category → bot records/confirms the proposed transaction → user explicitly confirms or corrects → mapping inserted/updated → future safe matches skip the LLM call entirely. Never create a permanent mapping from an unconfirmed LLM guess, and never force a mapping for merchants that commonly span categories (Amazon, etc.).
Suggested confirmation copy: *"Recorded $82.40 at Woolworths under Groceries. Always categorise Woolworths as Groceries?"*
**Lookup precedence:** user-confirmed mapping → unquestionably explicit command/format → LLM structured interpretation → user clarification.

## Normalisation — conservative in v1
Lowercase, trim, collapse whitespace, strip identity-preserving punctuation, remove already-extracted amount/currency, retain the original text on the transaction. **Do not aggressively merge similar merchants** (e.g. `WOOLWORTHS 1234 BRISBANE` → `woolworths`) until it's driven by tested examples — false matches cost more than an extra cheap LLM call.

## Cost strategy
Illustrative: ~US$1.63 per 10,000 parses at rates checked 30 Aug 2026 (500 in / 50 out tokens) — **re-measure from actual production token usage**, don't trust the illustrative figure past launch. Cost-control order: mechanical rules → confirmed merchant memory → small structured-output model → clarification instead of an expensive fallback. Do not auto-escalate to a larger model in v1.

---

## `parse_event` (folded in from M9 — build in this PR, not a separate agent)
```sql
create table parse_event (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references app_user(id) on delete set null,
  route                text not null check (route in ('command','mechanical','mapping','llm')),
  model                text,
  input_tokens         integer,
  output_tokens        integer,
  latency_ms           integer,
  needed_clarification boolean not null default false,
  was_corrected        boolean not null default false,
  created_at           timestamptz not null default now()
);
create index parse_event_created on parse_event (created_at);
```
**Binding logging rules, from M9, apply here specifically because this is where the LLM call happens:**
- The LLM prompt carries only the message text, the user's category names, and their currency. Nothing else — no Telegram identifier, no internal user id, no prior conversation history.
- `parse_event` holds no message text — routes, token counts, latencies, booleans only. This is what makes `user_id` safely nullable and survives account deletion.
- Logs never contain bot tokens, webhook secrets, channel identifiers, or raw message content. A stack trace with a request body in it is a defect, not a debugging convenience.
- `was_corrected` is set later (by M3, when the user fixes a transaction) — wire that write path even though it's a cross-module callback; it's the only honest measure of parser accuracy, separate from the model's self-reported confidence.

---

## Task checklist
1. Migration for `merchant_category_mapping` and `parse_event` (`infrastructure/database/schema/observability.ts` for the latter, per M1's file split).
2. Implement `IMessageNormalizer`, `IMechanicalTransactionParser`, `IMerchantMappingRepository`, `ILlmTransactionParser`, `ITransactionCandidateValidator` as separate, focused components — not one large `if/else` chain.
3. Wire the routing decision exactly as the illustrative code above, calling into M3 (`LedgerService.record`) and M5 (allowance recalculation trigger) at the end, not owning persistence itself.
4. Build the versioned evaluation set (100–200 realistic Australian expense messages) covering: clear expenses/income, AU currency/date expressions, multiple amounts, refunds/reimbursements, corrections/deletions, unknown/multi-category merchants, spelling mistakes/shorthand.
5. Instrument every parse with a `parse_event` row; wire the `was_corrected` callback from M3's `correct`.
6. Track (dashboard/query, doesn't need to be pretty yet): % handled without an LLM, parse acceptance/clarification rates, corrections by field, merchant-mapping hit rate, LLM latency/tokens/cost, invalid/failed structured responses.

## Invariants to enforce
- Every parse produces a `parse_event` row containing no message text.
- No permanent merchant mapping is created without explicit user confirmation.
- The LLM prompt never contains anything beyond message text + category names + currency.
- Server-side validation rejects a bad LLM output even at high reported confidence.

## Tests to write
- Eval set pass rate, tracked as a number (not a guess) before setting confidence/validation thresholds.
- Amount validation: exponent mismatch (`82.404` for AUD) is rejected pre-persistence.
- Merchant mapping created only after explicit confirmation; an LLM guess alone never writes one.
- `parse_event` never contains `raw_text` or any Telegram identifier, even in a failure path.

## Open decisions (non-blocking, decide from eval results not guesses)
- [ ] Exact supported deterministic date/amount formats — expand from eval-set findings.
- [ ] Confidence/validation thresholds — set from the eval set, not chosen upfront.
- [ ] Merchant-mapping confirmation/removal command surface — coordinate with M11's `/categories`-adjacent commands.

## Out of scope for this pass
- Multiple transactions in one message (ask to split — M3/M6 shared scope decision, already resolved for this pass).
- Aggressive merchant alias merging.
- A second LLM provider — the port makes it possible later, don't build it now.

## Related
- Notion: [M6 — NLP Parsing & Merchant Memory](https://app.notion.com/p/3ccef5e61bdd8110ad9cc3651aebd249), [M9 — Observability, Privacy & Retention](https://app.notion.com/p/3d1ef5e61bdd815090b9c909ed5f5069) (fixed pieces only — see `M9-observability-privacy-retention.md` for the parts *not* built this pass)
- Called by M7. Calls into M3.
