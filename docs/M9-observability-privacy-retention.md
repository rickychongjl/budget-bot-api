# M9 — Observability, Privacy & Retention

**Phase:** fold the fixed pieces into M6's PR (Phase 1); the rest is a deliberate stub, not this pass
**Notion status:** Stub by design — scope and boundaries only. The `parse_event` table and the privacy rules are fixed now because they're cheap to build in and expensive to retrofit; metrics, dashboards, and retention jobs are designed before public beta, not now.
**One-line scope:** Knowing whether the parser is working and what it costs, without ever holding data that would embarrass the product if it leaked.

---

## Depends on
- **M1** for schema conventions.
- **M2** for `app_user` (nullable FK — survives account deletion).

## Depended on by
- **M6** populates `parse_event` on every parse — this is why M9's fixed pieces are folded into M6's PR rather than run as a separate workstream.
- Every module's logging is bound by the rules here, even though this module owns no code most other modules call directly.

---

## Owns (this pass — the fixed pieces only)
- Table `parse_event`
- What may/may not be logged, anywhere in the system

## Owns (later — not this pass)
- Retention/cleanup for `parse_event`, `inbound_update`, soft-deleted transactions
- Metrics: deterministic-parse rate, merchant-mapping hit rate, clarification rate, correction rate, LLM latency/tokens/cost

## Does not own
- Account deletion — **M2**. Usage counters that gate behaviour — **M8** (a different thing from metrics that merely *measure*).

---

## Rules fixed now — binding on every module from the first line of code
- **The LLM prompt carries the message text, the user's category names, and their currency. Nothing else.** No Telegram identifier, no internal user id, no prior conversation history. (Enforced in M6.)
- **`parse_event` holds no message text.** Routes, token counts, latencies, boolean outcomes only — this is what makes `user_id` safely nullable and lets the table survive account deletion.
- **Logs never contain** bot tokens, webhook secrets, channel identifiers, or raw message content. A stack trace that includes a request body is a defect, in any module, not a debugging convenience.
- **Data stays in Australia** — the Neon project is in Sydney (M1's decision, not this module's, but this module is the one that has to keep re-checking it holds).

## Schema (build this now, as part of M6's PR)
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
`was_corrected` is set later by M3 when the user fixes a transaction — the only honest measure of parser accuracy in production, distinct from the model's self-reported confidence.

## Why this is a stub, deliberately
Metrics matter once there's traffic to measure — building dashboards before the first user just produces graphs of zero. The table exists from day one because the events can't be reconstructed retrospectively; the analysis on top of it can wait.

---

## Task checklist (this pass)
1. Migration for `parse_event` (`infrastructure/database/schema/observability.ts`) — done as part of M6's PR, not a separate one.
2. Add a lightweight logging lint/review step (even a code-review checklist item is enough for this pass) confirming no PR introduces a log line with message text, bot tokens, webhook secrets, or Telegram identifiers.
3. Confirm `parse_event.user_id`'s `on delete set null` actually fires correctly against M2's cascade delete (test this specifically — it's the one row that's supposed to survive account deletion).

## Task checklist (explicitly deferred — do not build this pass)
- Retention periods and cleanup jobs for `parse_event`, `inbound_update`, and soft-deleted transactions. `inbound_update` in particular grows with every message and nothing reads rows older than a few minutes — worth a cheap TTL-style cleanup once there's real volume, but not before.
- Metrics dashboards — SQL against Neon vs. Workers Analytics Engine, undecided, doesn't need deciding yet.
- Alerting — what's worth waking a solo founder for, and by what channel.
- The public `/privacy` page's wording (M10 owns the page; this module owns making sure the wording matches what the system actually does — revisit once the system actually does something).
- Uptime expectations, stated honestly for a solo-operated service.

## Invariants to enforce (this pass)
- `parse_event` never contains message text, under any route.
- No log line anywhere contains a bot token, webhook secret, channel identifier, or raw message content.

## Related
- Notion: [M9 — Observability, Privacy & Retention](https://app.notion.com/p/3d1ef5e61bdd815090b9c909ed5f5069)
- Build as part of M6. Full design revisit before public beta.
