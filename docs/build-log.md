# Build log

Each agent appends its entry here — what it built, what it assumed, and any open
question it hit. Read between PR reviews (master plan §7). Newest last.

---

## M1 — Platform, Data & Configuration — 2026-09-06

**Branch:** `setup-m1` · **Phase:** 0 (must merge before Phase 1 branches)

### Built

- **Repo scaffold** matching M1 §2 exactly: `src/{index.ts, channels/telegram, parsing,
  core/{identity,ledger,budgets,allowance,entitlements,domain,ports,testing},
  observability, db/{client.ts,schema,migrations}}`, `wrangler.toml` at root. Each
  not-yet-built module directory has an `index.ts` stub naming its owner, phase, port,
  and schema file.
- **Split schema** under `src/db/schema/` — one file per owning module
  (`identity, category, budget, transaction, allowance, entitlement, observability,
  platform`), each currently `export {}` with a header documenting the tables it will
  hold and the M1 §4 conventions, barrel-exported from `index.ts`. `drizzle-kit
  generate` is a clean no-op ("No schema changes, nothing to migrate") — the trivial
  first migration M1's DoD allows.
- **Typed port stubs** in `src/core/ports/`, each lifted from the named module's own
  plan doc:
  - `IdentityService` (M2), `LedgerService` (M3), `BudgetService` (M4),
    `EntitlementService` (M8), `InboundMessage` / `MessageSender` + `ChannelConnection`
    / `OutboundMessage` / `SendResult` (M7) — interfaces verbatim from each "Public
    interface" / "Shared ports" section.
  - `DailyAllowanceService` (M5) — the **per-category / bundled-delivery revision**
    from master plan §5.2, not the page's original per-user shape (`findDue` returns
    `(user, category)` pairs; `AllowanceView` is per category with `daysLeft`).
  - `Clock` (M1) — `now(): Instant`; real `SystemClock` wraps `Date.now()`, settable
    `TestClock` in `core/testing/`.
  - `LlmParser` (M6) — provider-neutral; the context type structurally can't carry
    anything beyond message text + category names + currency (M9 privacy rule).
  - Shared primitives in `common.ts`: `UserId`, `Id`, `Instant` (epoch ms UTC),
    `LocalDate`, `MinorUnits` (`bigint`), `CurrencyCode`, `Channel`, `Tier`,
    `RefusalCode` (M11's table).
- **Domain stubs** in `src/core/domain/` — `money.ts` (`toMinorUnits` etc.),
  `period.ts` (`periodFor`), `allowance.ts` (`computeDailyTarget`). All throw
  `new Error('not implemented')` with the reference formula from M3/M4/M5 in the
  doc comment. Compiler enforces the signatures now; owning modules fill the bodies.
- **`src/index.ts`** — Hono app with `/health`, plus a `scheduled` handler that logs
  one hello-world line per cron tick (M1 DoD: proves scheduler wiring before M5).
  `Env` interface enumerates the Hyperdrive binding + the five secrets.
- **`wrangler.toml`** — production only, `nodejs_compat`, `workers_dev = false`,
  `[observability] enabled`, cron `*/15 * * * *` (M5's cadence — Adelaide/Darwin are
  UTC+9:30), Hyperdrive binding with a placeholder id. No secrets. Validated with
  `wrangler deploy --dry-run` (bundle OK, 62.8 KiB).
- **`src/db/client.ts`** — `createDatabase()`: `postgres.js` (`prepare: false`,
  `max: 5`) + Drizzle, per M1 §1 (native driver over Hyperdrive, *not* the Neon
  serverless driver).
- **CI** (`.github/workflows/ci.yml`) — `test` job (typecheck + `vitest`) on every PR
  and push to main; `integration` job creates a per-PR Neon branch, runs
  `db:migrate`, runs `test:integration`, deletes the branch `if: always()`. Gated on
  repo var `NEON_PROJECT_ID` so it skips (not fails) until the Neon project exists.
- **Deploy** (`.github/workflows/deploy.yml`) — on push to main: typecheck + test →
  production `db:migrate` (must succeed) → `wrangler deploy`, in that order (M1 §5).
  Gated on `DEPLOY_ENABLED=true`.
- **Tests** — `test/unit/clock.test.ts` (SystemClock/TestClock behaviour),
  `test/unit/scaffold.test.ts` (port surface imports; domain stubs throw). 9 tests
  pass. `test/integration/` has a README only; `passWithNoTests` keeps it green.
- Config: `tsconfig.json` (strict + `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `vitest.config.ts`,
  `drizzle.config.ts`, `.gitignore`, `.dev.vars.example`, `README.md`.

### Assumed

- **`Instant` = `number`** (epoch milliseconds, UTC), not a branded type or class —
  keeps `TestClock` and domain maths ergonomic. `LocalDate` / `LocalTime` are
  `string` (`YYYY-MM-DD` / `HH:MM`). If M4/M5 want a richer temporal type, change it
  in `common.ts` — one place.
- **DTO shapes the plan docs reference but don't define** (`ResolvedUser`,
  `ValidatedCandidate`, `Transaction`, `TransactionPatch`, `Page<T>`, `DueSend`,
  `SendOutcome`, `GatedAction`, `DowngradeEligibility`, `AccountExport`, …) are given
  a reasonable shape derived from the corresponding SQL table / prose, with a comment
  that the owning module may refine. Only the *method signatures* are contractual;
  these supporting types are expected to firm up in Phase 1.
- **`ResolvedUser` carries `isNew: boolean`** so onboarding can branch without a
  second round-trip. Not in M2's doc; flag if unwanted.
- **`GatedAction` is a discriminated union** (`create_category` / `reactivate_category`
  / `enable_reminder` / `request_downgrade`) rather than a bare string — M8 can widen.
- **`wrangler.toml`, not `.jsonc`** — M1 §2 names `wrangler.toml` explicitly.
- **`compatibility_date = "2026-09-01"`**, `nodejs_compat` on (M1 notes Node built-ins
  are only partly available — check before adding a dependency that needs them).
- **CI/deploy gating via repo variables** (`NEON_PROJECT_ID`, `DEPLOY_ENABLED`) so the
  workflows are committed and correct now but don't red-X every PR before the
  Cloudflare/Neon accounts are wired. Removing the `if:` guards "turns them on".
- Dependency versions are whatever `npm install @latest` resolved on 2026-09-06
  (TypeScript 7, Vitest 5, Wrangler 4, `@cloudflare/workers-types` 5, Drizzle ORM
  0.45 / Kit 0.31, Hono 4, `postgres` 3). `package-lock.json` committed.

### Open questions

1. **`merchant_category_mapping` has no home in M1 §2's file list.** M6 needs the
   table (M6 checklist step 1) but M1's schema split enumerates only 8 files and none
   is for parsing/merchant memory. Left it out to keep M1 faithful to its spec; the
   M6 agent should add `src/db/schema/merchant.ts` + one barrel line. Noted in
   `db/schema/index.ts` and `parsing/index.ts`. Confirm that's the intended place.
2. **`transaction.category_name_snapshot`** — M3's plan proposes it "confirm before
   shipping". Not added; `transaction.ts`'s header flags it for the M3/M4 schema
   coordination.
3. **First cron deploy has no staging dress rehearsal** (M1 §5.7 / DoD) — the
   hello-world `scheduled` handler only logs, so the first real production deploy is
   low-risk, but there's genuinely no pre-prod Worker to try it on. Flagging per the
   DoD's "treat this first cron deploy carefully."
4. **`exactOptionalPropertyTypes` is on.** It's stricter about `foo?: T` vs
   `foo: T | undefined`. If it causes friction for a Phase 1 agent, it's a one-line
   tsconfig change — but it catches real bugs around optional patch fields, so I'd
   keep it.

---

## M6 — NLP Parsing & Merchant Memory (+ M9 fixed pieces) — 2026-09-06

**Branch:** `worktree-agent-acb0c43fa675c8134` · **Phase:** 1

### Built

- **M9 fixed pieces first.** `src/db/schema/observability.ts` now holds `parse_event`
  exactly per M9's SQL: uuid PK, nullable `user_id` → `app_user(id) on delete set
  null`, `route text check (…in ('command','mechanical','mapping','llm'))`, token
  counts / latency / two booleans, `timestamptz` `created_at`, index
  `parse_event_created`. There is deliberately no text column, and
  `test/unit/logging-rules.test.ts` asserts the column list so one can't be added
  quietly. `drizzle-kit generate` was run once locally against a throwaway
  `app_user` stub (not committed — see Open questions 1) and produced the doc's DDL
  verbatim, including both FK actions.
- **`src/db/schema/merchant.ts`** — `merchant_category_mapping` per M6's schema block
  (`unique (user_id, normalized_merchant)`, `source` check limited to
  `user_confirmed | user_corrected`, `times_used`, `created/updated/last_used_at`),
  plus the one barrel line in `db/schema/index.ts` (M1 open question 1 — resolved as
  M1 suggested). `category_id` has no Drizzle-level FK yet because M3's `category`
  doesn't exist (Open questions 3).
- **Pipeline components under `src/parsing/`**, one per stage (M6 checklist 2):
  `MessageNormalizer` (`IMessageNormalizer`), `MechanicalTransactionParser`
  (`IMechanicalTransactionParser`: amounts as decimal *text*, AU day-first dates and
  relative expressions, currency tokens, income/refund/correction markers, the
  merchant-memory key), `DrizzleMerchantMappingRepository`
  (`IMerchantMappingRepository` — its only write method is `saveConfirmed`; there is
  no way to express "save an LLM guess"), `OpenAiLlmTransactionParser`
  (`ILlmTransactionParser` = M1's `LlmParser` port, `openai.responses.parse`,
  `model: "gpt-5.4-nano"`, `reasoning: { effort: "none" }`, `zodTextFormat` over a
  Zod schema that is the LLM contract field-for-field, strict), and
  `TransactionCandidateValidator` (`ITransactionCandidateValidator`: currency =
  user's, amount scale vs exponent, extractor conflicts, date validity / future /
  account floor, category resolution by name or id).
- **`TransactionParsingPipeline`** (`pipeline.ts`) — the routing is the doc's
  illustrative code in shape (explicit income + one amount → record; one amount →
  mapping hit → record; else LLM), preceded by *mechanical guards* that never need a
  model: correction intent, several amounts (→ "ask to split", never auto-split, never
  sent to the model), decimal comma, foreign currency, impossible date. Every
  route passes the validator; LLM results then go through a three-tier confidence
  policy (record ≥ 0.85 / confirm ≥ 0.5 / clarify — `DEFAULT_POLICY`, overridable,
  and explicitly *not* tuned yet). `LedgerService.record` and
  `DailyAllowanceService.availableToday(userId, categoryId)` are called at the port
  level only. `createParsingPipeline({ db, clock, openAiApiKey, ledger, allowance })`
  is the production wiring for M7.
- **Merchant-mapping lifecycle:** a `recorded` LLM outcome may carry a
  `mappingProposal` ("Always categorise X as Y?"); it becomes a row only via
  `pipeline.confirmMerchantMapping(userId, proposal, 'user_confirmed' |
  'user_corrected')`. Proposals are keyed on *what the user typed* (the residual
  description), not the model's tidied merchant name, so the next identical message
  hits memory. No proposal, no application of an existing mapping, and a refusal even
  on explicit confirmation for merchants in `multi-category-merchants.ts` (Amazon,
  eBay, Kmart, Target, Big W, …).
- **`parse_event` instrumentation:** exactly one row per `parse()`, including every
  failure path (refusal / incomplete / API error still record model + tokens +
  latency where known). Route is `mechanical` for guard clarifications (no model was
  called), `mapping`/`llm` otherwise. `ParseEventCorrectionHook.onTransactionCorrected
  (parseEventId)` is the seam for M3's `correct()`; the pipeline and
  `DrizzleParseEventRepository` both implement it, and every `ParseOutcome` carries
  `parseEventId`.
- **Money helpers filled in** (`core/domain/money.ts`: `minorUnitExponent`,
  `toMinorUnits`, `formatMinorUnits`) — bigint only, rejects `82.404` for AUD with
  `MoneyError('SCALE_EXCEEDS_EXPONENT')`. The scaffold test's "toMinorUnits throws"
  guard was removed accordingly.
- **`src/observability/log.ts`** — the tiny structured logger the LLM parser uses:
  flat primitive fields only, 200-char truncation, bot-token/`sk-` redaction.
- **Eval set v1** — `test/eval/cases.v1.ts`, **158 cases** across mapping hits, AU
  currency forms, dates, explicit income, multiple amounts, corrections, foreign
  currency, unknown/multi-category merchants, server-side validation of model
  output, LLM failure modes, refunds, typos/shorthand, no-amount messages.
  `deterministic.eval.test.ts` runs the whole pipeline with a scripted model and
  prints the pass rate per tag; **measured 158/158 = 100.0%** (first run was 152/158;
  the six were two extractor bugs, two guard-ordering issues, and two mislabels —
  all fixed before the baseline was set) and ratcheted in `baseline.json`. It also
  asserts on every case: one `parse_event`, no message word in its values, no
  mapping written, nothing recorded for multi-amount messages, and the LLM context
  is exactly `{categoryNames, currencyCode}`. `live-llm.eval.test.ts` scores real
  GPT-5.4 nano on the 60 `live`-labelled cases and prints field accuracy +
  confidence percentiles; skipped without `OPENAI_API_KEY`.
- **Tests:** 71 pass, 1 skipped (the live eval). Unit: money, normalizer/dates incl.
  Sydney DST, mechanical parser, validator, pipeline lifecycle, OpenAI parser driven
  through a fake `fetch` (asserts the exact request body: model, effort, strict
  schema, and that the input is only currency + category names + message), logger,
  logging-rules source scan. Integration: `parse-event-fk.test.ts` on PGlite proving
  `on delete set null` survives the `app_user` cascade while the mapping row is
  removed, plus check/unique constraints and the Drizzle repositories.
- Dependencies added: `openai` 7.10, `zod` 4.5; dev `@electric-sql/pglite` 0.5.
  `.dev.vars.example` and `Env` already had `OPENAI_API_KEY` from M1 — unchanged.

### Assumed

- **`LlmParseResult.usage?` added to M1's port** (`model`, `inputTokens`,
  `outputTokens`, `latencyMs`) so `parse_event` can be costed; and `LlmParseError`
  (`refusal | incomplete | invalid_output | api_error`) as the port's failure
  contract. Additive; nothing else changed on the port.
- **The model is never told today's date.** M9 says the prompt carries text +
  category names + currency and nothing else, so relative dates (`yesterday`, `last
  friday`) are resolved mechanically from the injected `Clock` + user timezone, and
  the model is instructed to return `transaction_date: null` for them. A model date
  is accepted only when no mechanical date exists; a disagreement clarifies.
- **`UserParseContext`** (`userId`, `currencyCode`, `timezone`, `categories:
  {id,name}[]`, optional `accountCreatedOn`) is assembled by the caller (M7) from
  M2/M3 — M6 reads no other module's table. It has no channel identifier.
- **M5 trigger = `availableToday(userId, categoryId)`** (the only on-demand
  compute+persist method on the port); called after a categorised expense/refund,
  not after income. M3's own `record` step 2e also notifies M5 — if that lands, one
  of the two calls should go (Open questions 4).
- **Backdated `occurredAt`** = local noon of `occurredOn` in the user's timezone;
  same-day = `clock.now()`.
- **Guard clarifications log `route: 'mechanical'`**, not `'llm'`, so M9's future
  "% handled without an LLM" metric isn't polluted by messages that never reached the
  model.
- **Thresholds 0.85/0.5 are placeholders**, per M6 "decide from eval results" —
  the deterministic eval can't measure model confidence; run the live eval once a key
  is available and set them from its percentiles.
- **Merchant keys are exact** (M6 "conservative in v1"): `woolworths 1234 brisbane`
  and `woolies` are different keys; proposals are limited to ≤ 3-word keys.
- **`wrangler deploy --dry-run` still passes but proves nothing about the OpenAI
  SDK on Workers** — `index.ts` doesn't import `parsing/` until M7 wires it, so the
  bundle is unchanged at 62.8 KiB. The SDK is fetch-based and Workers-supported per
  its docs; verify on M7's first dry-run.

### Open questions

1. **Merge order: M2 before this PR.** `observability.ts` and `merchant.ts` import
   `appUser` from `./identity` as the doc-specified table. Until M2's PR fills that
   file, `npm run typecheck` reports **exactly two TS2305 errors on those two import
   lines and nothing else** (no cascade — verified; `npm test` is unaffected because
   nothing evaluates the FK callback outside `drizzle-kit`). I chose the honest
   direct import over a cast-based shim so the code is correct the moment M2 lands.
   **No migration SQL is committed in this PR** for the same reason: it must sort
   after M2's `app_user` migration. After rebasing on M2, run `npm run db:generate`
   — the expected output is in the header of `test/integration/parse-event-fk.test.ts`.
2. **Attributing a correction to its parse event.** `was_corrected` needs M3's
   `correct(userId, transactionId, …)` to find the `parse_event` row, but M9's schema
   (built verbatim) has no `transaction_id`, and M3's `transaction` has no
   `parse_event_id`. Proposal: M3 adds `parse_event_id uuid references
   parse_event(id) on delete set null` to `transaction` and calls
   `ParseEventCorrectionHook.onTransactionCorrected(parseEventId)`. Until then the
   hook exists and is tested but has no caller.
3. **`merchant_category_mapping.category_id` FK.** Declared as a bare `uuid not null`
   because M3's `category` table is Phase 2. When M3's schema lands, add
   `.references(() => category.id, { onDelete: 'cascade' })` (a mapping to a deleted
   category is meaningless) — one line in `merchant.ts`.
4. **Double M5 notification.** M3's `record` step 2e says M3 notifies M5; M6's
   checklist 3 says M6 triggers recalculation. Both are wired at the port level now;
   keep one when M3 is built.
5. **The 100% deterministic pass rate is a regression baseline, not an accuracy
   claim** — the set was labelled by the same author as the parser. The number that
   matters for confidence thresholds is the live-LLM eval, which is unmeasured
   (no key in this environment). Please run `OPENAI_API_KEY=… npx vitest run
   test/eval/live-llm.eval.test.ts` once and paste the printed table here.
6. **`money.ts` is now implemented by M6** (the M1 comment said "M3/M6 own the real
   conversion"). The M3 agent should reuse it rather than re-implement; flagging so
   the Phase 2 pair don't collide with it.
7. **Command surface for mapping management** (M6 open decision 3) is untouched —
   `IMerchantMappingRepository.remove` exists for M11's future `/categories`-adjacent
   command, nothing calls it yet.
