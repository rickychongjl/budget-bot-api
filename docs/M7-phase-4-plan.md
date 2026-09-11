# Phase 4 — M7 Telegram Gateway

## Context

Phases 0–3 have merged to `main`: M1 platform, M2 identity + 5-step onboarding, M6 parsing (with M9's `parse_event`), M8 entitlement policy, M3/M4 ledger + budgets, M5 allowance + scheduler. Every core service is built and tested against ports. **Nothing has ever sent or received a Telegram message.** `src/index.ts` is still M1's hello-world (`/health` + a logging cron); `src/channels/telegram/index.ts` and `schema/platform.ts` are empty placeholders.

Phase 4 is M7, the integrator: the webhook in, replies out, the `MessageSender` M5 already calls, and turning `index.ts` into the real composition root. It is transport only — per M7's spec, "if a change here would alter a number the user sees, it belongs somewhere else."

Sources of truth read: `docs/00-MASTER-PLAN.md` (§3 scope, §5.3 routing, §5.7 production-only, §5.8 `/export` stub), `docs/M7-telegram-gateway.md` (incl. the "Handed over from M5" section), `docs/M11-telegram-commands-contracts.md` (command catalogue + routing order), M5's `build-log.md` entry.

Branch: `phase-4` exists locally (0 commits ahead of `main`), remote is `origin`. Work happens in a worktree off `phase-4`; one PR per stage below, each into `phase-4`, then `phase-4 → main` at the end — matching the phase-N pattern PRs #7 and #8 used.

---

## Two findings the specs don't cover

### 1. There is no pending-conversation state anywhere — M7 needs a second table

M6's `TransactionParsingPipeline.parse()` returns `confirm` / `clarify` outcomes (`src/parsing/types.ts:137`) but nothing persists "this user owes an answer." M11's routing step 4 (*an answer to an open clarification*) and `/cancel` (*abandon current uncommitted conversation*) both require it. M7's spec only names `inbound_update`.

**Decision:** add `pending_prompt` to `schema/platform.ts` (M7-owned): one open row per user — `user_id` (PK, cascade), `kind` (`confirm` | `clarify`), `parse_event_id`, `payload jsonb` (the serialised `ValidatedCandidate` / question), `created_at`. Cleared on answer, `/cancel`, or a later free-text message (which supersedes it). **Onboarding does not use it** — `OnboardingService` already persists its own step in `app_user.onboarding_step` and carries `options` + `step` in every `OnboardingPrompt`, so stale/forged callbacks are already detectable (`src/core/identity/onboarding.ts:48-64`).

### 2. Plain text, no `parse_mode`, bot-wide

M5's `escapeCategoryName` (`src/core/allowance/messages.ts:25`) **strips** markup characters rather than escaping them, and its header says "M7 escapes nothing further." That is only safe if sends carry no `parse_mode`. So: every `sendMessage` is plain text. This also settles M7's open decision #3 (`/stats` formatting → plain, as M11 recommends), makes the markdown-injection test trivially true, and unblocks hoisting the three copies of that strip function (M2 `escapeForPrompt`, M5 `escapeCategoryName`, M7's new one) into `core/shared/text.ts` — which M5's build-log entry explicitly deferred to "when M7 lands and there are three copies."

### Also: who deactivates on 403

`DefaultAllowanceService.computeAndSend` **already** calls `connections.deactivateConnection` when the sender returns `skipped/blocked` (`src/core/allowance/default-allowance-service.ts:173`). So `TelegramMessageSender` must only *classify* — never deactivate. M7's own inbound reply path does its own deactivation on `skipped`. Stated here so nobody wires it twice.

---

## Open decisions — defaults taken (M11 labels all three "low-stakes")

| Decision | Default |
|---|---|
| Unknown command | Short "I don't know that one — try /help" |
| Inline keyboard option cap | 4 buttons max, then plain-text prompt |
| `/stats` formatting | Plain text (see finding 2) |

**Decided by Ricky, 11 Sep 2026 (this planning session):**
- **Command set approved for registration, all 16:** `/start /today /budget /categories /settings /stats /delete /history /remind /help /cancel /export /upgrade /subscribe /subscription /paysupport`. `/export`'s menu description reads "coming soon" so the menu is honest about the one true stub.
- **`SUPPORT_CONTACT = rickychongjl@gmail.com`** in `wrangler.toml [vars]`, shown by `/paysupport`.
- **PR shape: one PR per stage (4A→4D) into `phase-4`, then `phase-4 → main`.**

### What is a stub and what isn't — verified against the live Notion M11 page (last edited 5 Sep 23:31, unchanged since the local snapshot)

| Command | Live M11 says | Built as |
|---|---|---|
| `/export` | "Deferred — Story 7; stub only this pass" | **Stub** — `NOT_YET_AVAILABLE`. `LedgerService.exportCsv` already refuses the same way. |
| `/history` | Only the *Edit* controls are "Premium proposed; gate open"; master plan §5.8: "pagination/read path was never blocked" | **Real** paginated read via `LedgerService.history(userId, page)` with next/prev inline keyboard (`hist:<cursor>`). Edit buttons omitted; tapping nothing is stubbed. |
| `/upgrade`, `/subscribe` | "If unconfigured, return unavailable without generating a dummy invoice" | **Real tier line** (`entitlements.tierOf`) + M8's `BILLING_NOT_CONFIGURED_MESSAGE` (`core/entitlements/billing.ts`). No hardcoded string in M7. `pre_checkout` / `successful_payment` events → `billing.onPurchase` → `not_configured` → same message. |
| `/subscription` | "No subscription is a normal state with an upgrade option" | **Real empty state**: tier + `NO_SUBSCRIPTION` wording + pointer to `/upgrade`. Not a stub. |
| `/paysupport` | "Support destination … remain to be configured"; "never gated by Premium or daily allowance quota" | **Real static reply** naming a support contact from a new `SUPPORT_CONTACT` Wrangler var (plain var, not a secret). Needs a value from Ricky. |

**Admission-exempt commands (live M11: "the management route must also work when ordinary product messages are capped"; `/help` has "no onboarding prerequisite"):** `/help`, `/paysupport`, `/subscription` skip `admitMessage` entirely — they cost no quota and remain reachable at the cap. `/cancel` is *not* exempt (M11 doesn't list it; it's a product action). M11 flags finalising this routing as a pre-billing item; taking it now is cheap and matches both pages' intent — flagged in the build-log entry.

---

## Stage 4A — Composition root + outbound delivery

Closes M5's four handover items in M7's stated order. Ships value alone: the already-built 07:00 reminder actually delivers.

**New — `src/channels/telegram/`**
- `telegram-api-client.ts` — thin `fetch` wrapper over `https://api.telegram.org/bot<token>/<method>`. Methods: `sendMessage`, `answerCallbackQuery`, `editMessageReplyMarkup`. Returns a typed `{ ok, status, retryAfter?, description? }`; the token is a constructor arg and never appears in a thrown error or log line. Takes an injectable `fetch` for tests.
- `telegram-message-sender.ts` — `TelegramMessageSender implements MessageSender` (`src/core/shared/messaging.ts`). Classification is the contract M5 maps onto row states: 403 → `{status:'skipped', reason:'blocked'}`; 429 → `{status:'retryable', retryAfterSeconds}` from `parameters.retry_after`; 5xx / network error → `{status:'retryable'}`; 400 → `{status:'permanent'}`; 200 → `{status:'sent'}`. No sleeping, no deactivating.

**Modify — `src/index.ts`** → real composition root, following each module's `index.ts` wiring comment verbatim:
```
db = createDatabase(env.HYPERDRIVE.connectionString)      // infrastructure/database/client.ts
identity = new DefaultIdentityService({repo, clock, ledger})
entitlements = createEntitlementService({repository, capacity, timezoneOf, clock})
budgets = new DefaultBudgetService({repository, settingsOf, clock})
allowance = new DefaultAllowanceService({repository, budgets, ledger, settingsOf, connections: identity, sender, clock})
ledger = new DefaultLedgerService({repository, periods: budgets, settingsOf, clock, allowance})
categories = new DefaultCategoryService({repository, entitlements, budgets, settingsOf, clock, allowance})
reminders = new DefaultReminderSelectionService({repository: allowanceRepository, budgets, entitlements})
onboarding = new OnboardingService({identity, entitlements, categories, budgets, reminders, clock})
```
Seams that are easy to miss (both called out in M7's handover): `capacity = { countActiveCategories: DrizzleLedgerRepository's executor-bound reader (`drizzle-ledger-repository.ts:442`), countReminderCategories: createReminderCapacityReader(allowanceRepository) }`; and `allowance` passed to **both** ledger and category services — `categoryArchived` is not a no-op. There is a circular dep (identity needs ledger for `deleteAccount`; ledger needs `settingsOf` from identity) — resolve with a lazy `settingsOf = (id) => identity.getSettings(id)` closure, which is how every module's wiring comment already writes it. Build per request inside a `createApp(env)` factory, not at module scope (Hyperdrive binding is per-request).
- `POST /internal/send-allowance` — header `X-Internal-Dispatch-Secret` compared against `env.INTERNAL_DISPATCH_SECRET` (constant-time), body `{userId}`, calls `allowance.computeAndSend(userId)`, returns the `SendOutcome` as JSON. 401 otherwise.
- `scheduled` — replace hello-world: `allowance.findDue(controller.scheduledTime, 50)` → `ctx.waitUntil(Promise.allSettled(due.map(u => fetch(self, '/internal/send-allowance', …))))`. `controller.scheduledTime`, never `Date.now()`. 50 = Workers Free subrequest ceiling.

**Modify — `src/channels/telegram/index.ts`** barrel exports `TelegramMessageSender`, `TelegramApiClient`.

---

## Stage 4B — Webhook spine, dedup, routing skeleton

**Schema — `src/infrastructure/database/schema/platform.ts`**: `inbound_update (channel, update_id) PK, received_at` exactly as M7 §"Webhook handling"; plus `pending_prompt` (finding 1). `npm run db:generate` → `0005_*.sql`, commit with snapshot.

**New — `infrastructure/database/repositories/drizzle-gateway-repository.ts`** implementing a `GatewayRepository` port defined in `channels/telegram/gateway-repository.ts` (M7 owns these tables; the port lives with M7, the Drizzle impl under infrastructure, per CLAUDE.md): `claimUpdate(channel, updateId): Promise<boolean>` (`insert … on conflict do nothing`, rowCount === 1), `findPendingPrompt`, `setPendingPrompt`, `clearPendingPrompt`.

**New — `channels/telegram/update-parser.ts`**: raw Telegram `Update` JSON → discriminated union `TelegramEvent`: `text_message` | `callback_query` | `non_text_message` | `pre_checkout` | `successful_payment` | `unsupported`. Private-chat check here (`chat.type === 'private'`; anything else → the "please DM me" reply per M11's shared contract, no account data). Zod for the shape — already a dependency.

**New — `channels/telegram/webhook-handler.ts`**: `handle(request, ctx)`:
1. `X-Telegram-Bot-Api-Secret-Token` !== `env.TELEGRAM_WEBHOOK_SECRET` → 401, body not read, nothing logged.
2. Parse body; `claimUpdate('telegram', update_id)` false → 200, stop.
3. Return 200.
4. `ctx.waitUntil(dispatcher.dispatch(event))` — all real work.

**New — `channels/telegram/dispatcher.ts`** (the thing `waitUntil` runs), M11's order — **not** M7's page order:
1. `identity.resolve('telegram', from.id)`; null → only `/start` (calls `identity.register`) and `/help` may proceed, everything else → `ONBOARDING_REQUIRED` reply.
2. `entitlements.admitMessage(userId, update_id, sentAt)` — first thing after resolution **except for the admission-exempt set** (`/help`, `/paysupport`, `/subscription` — see "What is a stub" above). `refused` → send `result.message`, stop. `duplicate` → stop silently.
3. `callback_query` / `pre_checkout` / `successful_payment` → routed explicitly (callbacks to onboarding, confirm/clarify, or command sub-actions by a `kind:` prefix in `callback_data`; payment events → `NOT_YET_AVAILABLE`). Always `answerCallbackQuery`.
4. `non_text_message` → "only text supported."
5. Text starting `/` and in the catalogue → `command-router.ts`, **even if `pending_prompt` exists** (the M11 revision — explicit test).
6. `onboarding_step !== 'done'` → `onboarding.answer(userId, {value: text})`.
7. Open `pending_prompt` → answer path (4D).
8. Else free text → M6 (4D).

Every branch ends in exactly one `send`; `skipped` → `identity.deactivateConnection`. Any thrown error → one plain apology, logged via `observability/log.ts` with `parse_event_id`/`update_id` only — never text, never token.

**New — `channels/telegram/command-router.ts`**: `Map<string, CommandHandler>` where each entry carries `{ name, description, exemptFromAdmission, requiresOnboarding, handle }` — the same table feeds `setMyCommands` (4E) and `/help`. Argument tokeniser supporting quoted multiword names (`/budget "Eating Out" 300`). Lands with `/help`, `/cancel` (clears `pending_prompt`; onboarding is *not* cancelled — it's resumable by design), `/export` (stub), and the billing trio (`/upgrade`+`/subscribe` → tier + M8's `BILLING_NOT_CONFIGURED_MESSAGE`; `/subscription` → tier + `NO_SUBSCRIPTION`; `/paysupport` → `env.SUPPORT_CONTACT`) — the cheapest end-to-end proof the spine works. Unknown → short reply + `/help`.

**New — `channels/telegram/render.ts`**: `renderRefusal(code, message)`, `renderOnboardingReply(OnboardingReply)` → `{text, replyMarkup}` (options → inline keyboard, `callback_data = "ob:<step>:<value>"`, >4 options → numbered plain-text list), money via M5's `formatMoney`, `paginate(text, 4096)`. Hoist the strip function to `core/shared/text.ts` as `sanitiseDisplayText`; repoint M2 and M5 to it in a **separate small commit** on the same PR (CLAUDE.md: no rename sweep inside a feature change — a dedicated commit keeps the diff reviewable).

**Modify — `src/index.ts`**: `app.post('/telegram/webhook', c => webhookHandler.handle(c.req.raw, c.executionCtx))`. Add `SUPPORT_CONTACT: string` to `Env` and a `[vars]` entry in `wrangler.toml` (not a secret — it's shown to users).

---

## Stage 4C — Command catalogue

Each handler in `channels/telegram/commands/<name>.ts`, calling the owning service, rendering, returning one `OutboundMessage`. No arithmetic, no policy.

| Command | Calls | Notes |
|---|---|---|
| `/start` | `onboarding.start(userId)` | Returning user gets `summary` kind; render `AccountSummary` |
| `/today [category]` | `allowance.availableToday(userId, categoryId?)` | M5's `renderAllowanceLine` per view; counts toward quota (already does — admission runs first) |
| `/budget [category] [amount]` | `budgets.currentBudgets` / `budgets.setCap` | Amount → minor units via M3's `toMinorUnits` against `settings.currencyCode`; no partial write on bad input |
| `/categories` | `categories.list/create/rename/archive` | Sub-actions via inline keyboard `cat:<action>:<id>`; archive refusal message from M3 |
| `/settings` | `identity.getSettings/updateSettings` | Timezone displayed, never editable — `TIMEZONE_IMMUTABLE` on attempt |
| `/stats [category]` | `budgets.currentBudgets` + `ledger.spendInPeriod` | Plain text, paginated |
| `/delete` | `ledger.deleteLast` → `allowance.availableToday` | `null` → `NO_TRANSACTIONS`; confirmation includes updated allowance line — **call `availableToday` directly, `ledgerChanged` is a no-op** |
| `/remind [category]` | `reminders.enabledCategoryIds/enable/disable` | Offer only categories with an active budget (`budgets.activeBudgets`) so M5's `NO_BUDGET` never surfaces after the fact |
| `/help [command]` | the router's own table | Tier labels per M11; admission-exempt |
| `/history` | `ledger.history(userId, {cursor, limit})` | Paginated read, `hist:<cursor>` next/prev keyboard, 4096 pagination; no Edit buttons (deferred) |

Refusals: one `catch` in the dispatcher maps `RefusalError` (`core/shared/errors.ts`) and `EntitlementRefusal` → `renderRefusal`. Every one of the 17 `RefusalCode`s gets a line in `render.ts`; unknown thrown errors → apology.

Category lookup by name for `/today`, `/budget`, `/stats`, `/remind` → `categories.findByName` (M3 owns normalisation via `normalizeCategoryName`).

---

## Stage 4D — Free-text path

- Wire `createParsingPipeline({db, clock, openAiApiKey: env.OPENAI_API_KEY, ledger, allowance, logger})` (`src/infrastructure/create-parsing-pipeline.ts`) in the composition root.
- Dispatcher step 8: build `UserParseContext` (categories, currency, timezone, today) → `pipeline.parse(text, ctx)`:
  - `recorded` → confirmation: what was recorded, then `availableToday` on its own line. If `mappingProposal` → append "remember X as Y?" inline keyboard `map:<yes|no>`.
  - `confirm` → store `pending_prompt{kind:'confirm', payload: candidate}`; reply with candidate summary + `pc:yes` / `pc:no` keyboard + free-text fallback.
  - `clarify` → store `pending_prompt{kind:'clarify'}`; reply with `question`.
- Step 7 (open prompt): `confirm` + yes/text-yes → `pipeline.recordConfirmed(...)`; no → clear. `clarify` + text → clear the prompt and re-`parse` with the answer appended to the original text (the pipeline has no dedicated answer method — check whether it needs one; if a clean "answer" call turns out to be needed that's an M6 contract addition, flag it, don't hack it).
- `map:yes` callback → `pipeline.confirmMerchantMapping(...)`.
- Every reply on this path is one message (M11 "one reply per input step").

---

## Stage 4E — Go-live (Ricky's hands, my checklist)

**Telegram-side command menu is built here, scripted, not clicked.** `POST /internal/register-commands` (same `INTERNAL_DISPATCH_SECRET` guard as `/internal/send-allowance`) calls the Bot API `setMyCommands` with a list derived from `command-router.ts`'s catalogue (name + one-line description per handler, stubs included so they show as reachable). One source of truth: the registered `/` menu cannot drift from the handlers that exist, which is M11's DoD line "catalogue reflects what was implemented." Lives in the Worker because the token already lives there as a secret — nothing to copy onto a laptop, no new dev dependency. Idempotent; rerun after any command change. BotFather itself is only needed once, to create the bot and get the token. Same route also does `setWebhook` (step 5) for the same reason.

1. Sign off command names (Ricky) → `curl -X POST …/internal/register-commands`.
2. `wrangler hyperdrive create` → id into `wrangler.toml` (currently `REPLACE_WITH_HYPERDRIVE_ID`).
3. `wrangler secret put` × 5 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_DISPATCH_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`).
4. `npm run db:migrate` against the Neon prod branch (0000–0005).
5. `npm run deploy`, then `setWebhook` with `secret_token` — a deliberate step, never on cold start.
6. **Before trusting the cron:** `curl -X POST /internal/send-allowance` with your own `userId` and watch your chat. This is M5's own open question #1 — first real delivery is against production, no staging to rehearse on (§5.7).
7. Update `docs/M11-…md` catalogue to what actually shipped; append the M7 entry to `docs/build-log.md` in the existing Built / Assumed / Open questions / Verification shape.

---

## Files summary

New: `channels/telegram/{telegram-api-client,telegram-message-sender,update-parser,webhook-handler,dispatcher,command-router,render,gateway-repository}.ts`, `channels/telegram/commands/*.ts`, `infrastructure/database/repositories/drizzle-gateway-repository.ts`, `core/shared/text.ts`, migration `0005`.
Modified: `src/index.ts` (rewritten), `channels/telegram/index.ts`, `schema/platform.ts`, `schema/index.ts`, `core/identity/default-identity-service.ts` + `core/allowance/messages.ts` (repoint to shared strip), `docs/build-log.md`, `docs/M11-…md`.

---

## Testing — following the repo's conventions, plus the pattern M7 establishes

**Idioms to keep (from the existing suites):** no mocking framework — hand-written recording doubles with a `readonly calls[]` and assertions on counts; a `createHarness(now)` factory per module under `test/unit/<module>/harness.ts` wiring real services over `InMemoryStore` + `TestClock`; outbound HTTP stubbed by **injecting `fetch?: typeof fetch`** and recording calls (the `OpenAiLlmParser` seam, `test/unit/llm-parser.test.ts:33-45`) — never `globalThis` patching; PGlite integration suites that execute the committed migration `.sql` via `?raw` imports (`test/integration/allowance.test.ts:1-49`) and reset with `delete from app_user`; Neon (`describe.skipIf(!DATABASE_URL)`) only for what PGlite can't prove — real concurrency.

**Pattern M7 establishes (no precedent in the repo):** test the webhook by calling `app.fetch(new Request(...), env, ctx)` directly with a hand-built `Env` and a hand-built `ExecutionContext` whose `waitUntil` collects promises so the test can `await` background work. No `@cloudflare/vitest-pool-workers` — nothing justifies a new test runtime. `TelegramMessageSender` and `TelegramApiClient` take `fetch?: typeof fetch`; a `test/support/fake-telegram-api.ts` records every Bot API call and scripts responses by status (`403`, `429 + retry_after`, `500`, `400`, `200`).

### Unit — `test/unit/telegram/`
- `harness.ts` — `createHarness(now)` wiring the dispatcher over in-memory repositories for every module (reuse the existing `InMemory*Repository`s and `InMemoryStore`), `FakeTelegramApi`, an in-memory `GatewayRepository`, `TestClock`.
- `telegram-message-sender.test.ts` — **the classification matrix**: 403 → `skipped/blocked`; 429 → `retryable` with `retryAfterSeconds` from `parameters.retry_after`; 5xx and a thrown network error → `retryable`; 400 → `permanent`; 200 → `sent`. Assert the sender **never** calls deactivate (M5 does). Assert the token never appears in any thrown error message.
- `webhook-handler.test.ts` — wrong/missing secret → 401 and the body was never read (fake `Request` whose `.json()` throws); valid → 200 returned before `waitUntil` work settles; duplicate `update_id` → 200 and dispatcher not called.
- `dispatcher.test.ts` — M11 routing order, one test per branch. **Explicitly:** `/cancel`, `/help`, `/subscription`, `/paysupport` each routed to the command while a `pending_prompt` row exists (the regression M7's spec warns about). Refused admission → exactly one message = M8's `result.message`. Unresolved user + non-`/start` → `ONBOARDING_REQUIRED`. Group chat → private-chat instruction, no account data. `skipped` send → `deactivateConnection` called once. Thrown error → one apology, no second message.
- `update-parser.test.ts` — realistic Telegram update JSON fixtures for each event kind, plus garbage → `unsupported`.
- `command-router.test.ts` — tokeniser (`/budget "Eating Out" 300`), unknown command → short reply, each stub → `NOT_YET_AVAILABLE` text.
- `render.test.ts` — merchant named `*Woolworths*` / `[x](y)` / `<b>` renders literally via `sanitiseDisplayText`; `paginate` splits at 4096 on a line boundary, never mid-word; onboarding prompt with 5 options → numbered plain-text list, with 4 → inline keyboard; every `RefusalCode` has a rendering (iterate the union via a `satisfies Record<RefusalCode, …>` table so a new code fails typecheck, not at runtime).
- `commands/*.test.ts` — per handler: calls the owning service with the right args, renders its result, adds no arithmetic. `/delete` asserts `availableToday` is called (not reliant on `ledgerChanged`). `/remind` offers only budgeted categories.
- `composition-root.test.ts` — `createApp(env)` constructs without throwing given a stub `Env`; `/health` still 200; `/internal/send-allowance` 401 without the header, calls `computeAndSend` with it; `scheduled` passes `controller.scheduledTime` (not the clock) to `findDue` and issues ≤ 50 subrequests.

### Integration — `test/integration/gateway.test.ts` (PGlite, always runs)
Executes `0000`, `0003`, `0004`, `0005` via `?raw`. Proves: `inbound_update` PK — two `claimUpdate` calls with the same `(channel, update_id)` return `true` then `false`, and `Promise.all` of two concurrent claims yields exactly one `true`; `pending_prompt` one-per-user upsert + cascade on `delete from app_user`. Add `0005` to `allowance.test.ts` / `ledger-budgets.test.ts` only if the migration touches a table they read (it shouldn't).

### E2E tier — deliberately manual
`vitest.config.ts` says "e2e — one deployed-Worker webhook round trip — added with M7." With production-only (§5.7) there is no staging Worker to point it at, so **no automated e2e project is added**; stage 4E's manual checklist (`/internal/send-allowance` against Ricky's own chat, then a real `/start`) is the e2e tier for this pass. Update the config comment to say so.

### Existing tests that must keep passing
M5's `default-allowance-service.test.ts` asserts on `FakeMessageSender.callCount` — the composition root must not change M5's send count. M2's and M5's suites cover the strip function being hoisted; they are the regression guard for that commit.

## Verification — run before each PR

```bash
npm run typecheck          # must be clean; the RefusalCode render table is enforced here
npm test                   # unit + PGlite integration; baseline 417 passed / 0 skipped before 4A
npm run test:integration   # requires DATABASE_URL (.env.local) — report clearly if not run
npm run db:generate        # 4B only; inspect and commit 0005_*.sql + snapshot
```

Manual, after 4A deploys (Ricky): `curl -X POST https://<worker>/internal/send-allowance -H 'X-Internal-Dispatch-Secret: …' -d '{"userId":"…"}'` → the bundled reminder arrives in your Telegram chat, and `daily_allowance_send` rows flip to `sent`. After 4B deploys: `setWebhook`, send `/help`, get the catalogue back; send `/help` twice fast — both answered, one `inbound_update` row each. After 4C/4D: walk `/start` end-to-end in under 5 minutes (DoD §8), log an expense in free text, confirm `/today` reflects it.

Each PR appends its section to `docs/build-log.md` (Built / Assumed / Open questions / Verification, matching M5's entry) and the final PR updates M11's catalogue table to what shipped.
