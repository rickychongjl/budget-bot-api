# M7 — Telegram Gateway

**Phase:** 4 (integrator, last — but webhook/dedup scaffolding can start in Phase 1 against Phase 0's interface stubs)
**Notion status:** Agreed v1 direction, 4 Sep 2026 — required for the Telegram alpha. **One real conflict: M11 (5 Sep) explicitly revises this page's routing order — see "Routing" below.**
**Reconciled 5 Sep (round 5):** aligned with M11's latest — **`/export` is now deferred (Story 7)**, stubbed the same way as the billing commands. Everything else here (routing order, tier caps, quota) already matched M11; this pass only adds the `/export` stub.
**One-line scope:** Transport. Receives Telegram updates, proves they're genuine, turns them into an internal message, formats replies back. Holds no budgeting rules, no parsing rules, no money maths. The only module that knows Telegram exists.

---

## Depends on
- **M1** for the `MessageSender`/`InboundMessage` port stubs.
- **M2** to resolve `channel_connection` → internal user.
- **M6** for understanding free-text messages.
- **M8** to admit/refuse a message against quota before doing any real work.
- **M5** for scheduled allowance delivery (this module implements the `MessageSender` M5 calls).
- **M11** for the full command catalogue, tier eligibility per command, and — critically — the routing order (see below).

## Depended on by
- Every command-owning module (M2–M6, M8) is *called* by this module; nothing calls back into M7 except M5's scheduled delivery.

---

## Owns
- The webhook endpoint and its security
- Table `inbound_update`
- Runtime command routing (catalogue lives in M11; this module implements it)
- Reply formatting, keyboards, Telegram's limits
- Outbound delivery on M5's behalf

## Does not own
- Understanding message text — **M6**. Any money/category/period/allowance decision — M3/M4/M5. Who the user is beyond a `channel_connection` lookup — **M2**.

**The rule that keeps this module thin:** if a change here would alter a number the user sees, it belongs somewhere else. This module may decide *how* a figure is rendered; never *what* the figure is.

---

## Shared ports every channel adapter must implement
```typescript
interface InboundMessage {
  channel: Channel
  externalId: string
  chatId: string
  text: string
  sentAt: Instant
  updateId: string
}
interface MessageSender {
  send(connection: ChannelConnection, message: OutboundMessage): Promise<SendResult>
}
```
This is what makes a second channel a new adapter later, not a rewrite — but WhatsApp is explicitly out of scope for this pass; don't build a second adapter speculatively.

## Webhook handling
Telegram retries any non-2xx response, aggressively. **Always return 200 fast; do the real work in `ctx.waitUntil()`.**
```
1. Verify X-Telegram-Bot-Api-Secret-Token against the secret set at setWebhook.
     Mismatch/missing -> 401, no processing, no logging of the body.
2. insert into inbound_update (channel, update_id) ... on conflict do nothing
     Zero rows affected -> retry -> return 200, stop.
3. Return 200.
4. Background: resolve user -> admit against quota (M8) -> route -> reply.
```
```sql
create table inbound_update (
  channel     text not null,
  update_id   text not null,
  received_at timestamptz not null default now(),
  primary key (channel, update_id)
);
```
**Deduplication is a DB constraint, not an in-memory cache** — Workers may run two deliveries of the same retry in different isolates, so an in-memory guard doesn't survive. **The secret token isn't optional** — the webhook URL alone isn't a credential; it leaks into logs, proxies, screenshots. **Returning 200 before processing is deliberate** — processing can include an LLM call taking a second-plus; holding the webhook open invites a retry that could race the first attempt's own dedupe write.

## Routing — build to M11's order, not this page's original order
The page's routing (as originally written) is:
1. Not-a-text-message → "only text supported" reply.
2. An answer to an open clarification → route to M6 as an answer.
3. A command (starts with `/`) → command table.
4. Anything else → M6 as a logging attempt.

**M11 (5 Sep) explicitly revises step 2 vs. step 3: recognised slash commands and explicit callbacks take precedence over a pending clarification.** Build to M11's order:
1. Not-a-text-message (and not a recognised callback/payment event) → "only text supported."
2. **Callback queries, pre-checkout, and successful-payment updates are routed explicitly, before the media fallback** — they are not ordinary text answers.
3. A recognised slash command or callback → command table, **even if a clarification is pending** (M11's revision).
4. An answer to an open clarification (only reached if nothing above matched) → route to M6 as an answer.
5. Anything else → M6 as a logging attempt.
`/cancel`, `/help`, `/subscription`, `/paysupport` must all remain reachable during a pending prompt per M11 — this is exactly the case the original ordering got wrong for.

## Command surface
Full catalogue, inputs/outputs, tier rules, and draft contracts live in **M11** — this module implements that surface and stays transport-only. Don't duplicate the catalogue here; read `M11-telegram-commands-contracts.md` before wiring any individual command. For this pass, `/upgrade`, `/subscribe`, `/subscription`, `/paysupport`, and now **`/export`** (round 5: deferred, Story 7) are stubbed to return "not yet available" rather than wired to real behaviour (real Stars checkout for the billing commands; real CSV streaming for `/export`, once M3/M2 build it — see master plan scope). `/history`'s interactive editing was already deferred and stays that way.

## Reply formatting
- One message per user action (payment receipts/confirmations are a separate async event — M11 scopes the "never two messages" rule to a single response step, not the whole conversation).
- Confirmations lead with what was recorded, then the updated allowance on its own line.
- Amounts render from minor units using the user's `currency_code`; this module renders, never computes.
- Clarifications use inline keyboard buttons for plausible answers + a free-text fallback.
- Telegram caps a message at 4096 characters — `/history` and `/stats` paginate, never truncate.
- **Escape user-supplied text before formatting** — a merchant literally named `*Woolworths*` must not corrupt the message's markup.

## Outbound delivery
This module is the only code calling the Telegram Bot API; it implements `MessageSender`, used by M5 for scheduled sends.
- **403 blocked by user** → deactivate `channel_connection` (via M2), report `skipped`. Never retry.
- **429 rate limited** → report `retryable` with `retry_after`. Don't sleep inside the invocation.
- **5xx/network** → report `retryable`.
- **400** → report `permanent` — a bug in the message we built, retrying won't fix it.

## Error surface
A user never sees a stack trace, error code, or the word "exception." Three outcomes only: understood-and-done → confirmation; understood-but-ambiguous → one clarification question; something broke → one plain apology, entry not silently lost.

## Configuration
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as Wrangler secrets, **different per environment** — staging and production never share a bot token. `setWebhook` is a deliberate deployment step, never called on cold start.

---

## Handed over from M5 (Phase 3) — added 11 Sep 2026

M5 landed complete on `phase-3`, but with **delivery deliberately deferred to this
module** (agreed with Ricky, 11 Sep). M5 is built against the ports and fully tested;
nothing in it reaches Telegram yet. These four items are M7's, and until they land the
07:00 reminder computes correctly and sends nothing.

1. **`MessageSender` against the Telegram Bot API** — `channels/telegram/telegram-message-sender.ts`,
   checklist item 5 below. M5 is its only caller today and depends on the exact
   classification in "Outbound delivery": 403 → `{status:'skipped', reason:'blocked'}`,
   429/5xx → `{status:'retryable', retryAfterSeconds?}`, 400 → `{status:'permanent'}`.
   M5 maps those onto its own row states, so a misclassification silently turns a
   retryable failure into a dead bundle. `test/support/fake-message-sender.ts` is the
   only implementation in the repo right now.

2. **Make `src/index.ts` a real composition root.** It currently wires nothing — no
   `createDatabase(env.HYPERDRIVE.connectionString)`, no repositories, no services, just
   `/health` and a hello-world `scheduled`. Every module's `index.ts` header carries its
   intended wiring; `core/allowance/index.ts` has M5's, including the
   `createReminderCapacityReader` seam M8's `CapacityReader` needs. This was already
   logged as M7's in M3/M4's build-log entry; M5 did not change it.

3. **`POST /internal/send-allowance`**, guarded by a shared-secret header against
   `INTERNAL_DISPATCH_SECRET` (already declared in `Env`), never routed publicly. Body
   carries a `userId`; the handler calls `allowance.computeAndSend(userId)` and returns
   the outcome. One user per invocation is the point — each gets a fresh 10ms CPU budget.

4. **Replace the hello-world `scheduled` body** with the fan-out:
   `allowance.findDue(controller.scheduledTime, 50)` → one self-subrequest to
   `/internal/send-allowance` per due user. Pass `controller.scheduledTime`, not
   `Date.now()`, so a delayed invocation still resolves the window it was scheduled for.
   The 50 is the Workers Free subrequest ceiling; `wrangler.toml` already has
   `crons = ["*/15 * * * *"]`.

**What M5 already handles, so M7 must not re-implement it:** which users are due
(`findDue` — one indexed query doing per-user timezone maths in SQL), bundling every
reminder-eligible category into one message, revalidation at dispatch, the once-only
guarantee, the 3-attempt retry budget, and all allowance wording (`renderBundledReminder`
/ `renderAllowanceLine`). M7 delivers the string M5 hands it and reports the result.

**Wiring detail that is easy to miss:** `DefaultLedgerService` and
`DefaultCategoryService` both take an optional `allowance` dependency — pass
`DefaultAllowanceService` in as both. It satisfies `AllowanceNotifier` structurally.
`ledgerChanged` is a no-op (below), but `categoryArchived` is not: it clears
`reminder_enabled` and retires the day's pending row. Omit it and archiving a category
leaves its reminder flag set. Nothing wrong is delivered — dispatch revalidation and
`countReminderCategories` both filter archived rows — but `/remind` would list a
category that can never fire.

**One M5 decision M7 inherits:** `AllowanceNotifier.ledgerChanged` is a documented no-op,
because `available_today` is derived rather than stored. M7's command handlers that need
an allowance line (`/today`, a `/delete` confirmation, a correction) call
`availableToday` directly — do not expect `ledgerChanged` to have refreshed anything.

**Also inherited:** M5's `/remind` contract refuses `NO_BUDGET` for a category with no
active budget — a reminder needs a cap to divide. `/remind` should offer only budgeted
categories rather than surfacing that refusal after the fact.

---

## Task checklist
1. Migration for `inbound_update` (`infrastructure/database/schema/platform.ts` per M1's file split).
2. Webhook handler: secret verification → dedup insert → 200 → `ctx.waitUntil` background processing.
3. Implement routing per M11's revised order (above), not the page's original order.
4. Implement each command from M11's catalogue, calling the owning module's service — this module contains no business logic itself.
5. Implement `MessageSender` against the Telegram Bot API, with the failure classification above.
6. Implement reply rendering: currency formatting from minor units, markdown escaping, 4096-char pagination for `/history`/`/stats`.
7. Wire M8's admission check as the very first thing after user resolution, before parsing/routing dispatch — a message that fails admission gets a typed refusal reply, not silent drop.
8. Stub billing commands (`/upgrade`, `/subscribe`, `/subscription`, `/paysupport`) and, as of round 5, **`/export`** to return "not yet available."

## Invariants to enforce
- No business rule lives in this module — if a PR to this module changes a number the user sees, that's a sign the logic belongs elsewhere.
- Every update is processed at most once (`inbound_update` primary key).
- The webhook always returns within a few milliseconds.
- Bot tokens/secrets never appear in logs, error messages, or `parse_event`.
- Telegram identifiers never leave this module except into `channel_connection`.

## Tests to write
- Duplicate webhook delivery (same `update_id`, two isolates) results in exactly one processed action.
- A slash command sent while a clarification is pending is routed to the command, not swallowed as a clarification answer (this is the M11 behaviour change — test it explicitly, it's easy to regress back to the page's original order).
- Markdown injection via a merchant name doesn't corrupt a reply.
- 403/429/5xx/400 delivery failures each produce the documented outcome (deactivate / retry / retry / no-retry).
- End-to-end: a realistic Telegram update posted to staging produces the expected reply (M1's e2e test tier).

## Open decisions (need your call per master plan §5.4, not an engineering default)
- [ ] Unknown command: full `/help` dump, or a short "I don't know that one"?
- [ ] Inline keyboard option count before falling back to plain text.
- [ ] `/stats`: plain text only, or Telegram-native formatting (weigh against the escaping risk above).
- [ ] `inbound_update` retention — owned by M9, not blocking this module.

## Out of scope for this pass
- Real Stars checkout wiring (stub only).
- Real `/export` CSV delivery (stub only, round 5 — see M11 and M3's plans).
- A second channel adapter.

## Related
- Notion: [M7 — Telegram Gateway](https://app.notion.com/p/3d1ef5e61bdd818d95faea944c854957)
- Authoritative command contract: **M11**. Calls M2, M6, M8. Called by M5 (delivery).
