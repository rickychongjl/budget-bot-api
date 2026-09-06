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

## M2 — Identity & Accounts — 2026-09-06

**Branch:** `m2-identity-accounts` · **Phase:** 1

### Built

- **Schema** `src/db/schema/identity.ts` — `app_user` + `channel_connection` per M2's
  schema block: uuid PKs, `timestamptz`, `text` + `check` for `status`/`channel`,
  `unique (channel, external_id)`, `user_id … on delete cascade`, index on `user_id`,
  `reminder_local_time default '07:00'`, `currency_code char(3) default 'AUD'`,
  `period_anchor_date date` nullable. Two deviations, both deliberate (see Assumed):
  `timezone` is nullable, and an `onboarding_step` column is added. Migration
  `src/db/migrations/0000_identity.sql` generated by `drizzle-kit generate` and
  committed with its `meta/` snapshot — the first real migration in the repo.
- **`IdentityServiceImpl`** (`src/core/identity/identity-service.ts`) implements the
  `IdentityService` port *verbatim* (interface untouched) plus two small extras:
  - `resolve` / `register` — insert-or-find in one transaction: `insert app_user`,
    then `insert channel_connection … on conflict (channel, external_id) do nothing`;
    zero rows ⇒ `tx.rollback()` (so the speculative user never survives) ⇒ read the
    winner. No check-then-insert anywhere. Re-registering refreshes `chat_id`/
    `username` and sets `is_active = true` (a user who blocked the bot and came back).
  - `setInitialTimezone` — canonicalises via `Intl` then
    `update app_user set timezone = $1 where id = $2 and timezone is null`. The DB
    arbitrates: `'set'` ⇒ done; `'already_set'` + same value ⇒ idempotent replay,
    succeeds; different value ⇒ `TIMEZONE_IMMUTABLE`. Under concurrent first writes
    exactly one wins (tested, unit + integration).
  - `updateSettings` — the patch type already omits `timezone`; a runtime guard
    additionally refuses any patch that carries a `timezone` key **even when the value
    equals what is stored** (M2's "explicit patch, not a no-op" case). `currency`
    change asks M3 (`LedgerService.history(userId, {limit: 1})`) and is refused once
    any transaction exists, with an explanation and no conversion; a same-value
    currency patch doesn't consult M3. `periodAnchorDate` change writes the column and
    nothing else — periods are derived (M4), so this *is* the re-bucket. `null` is
    refused post-onboarding. `reminderLocalTime` is validated `HH:MM` and written; M5
    reads it at the next due-scan, so it can only affect the next send.
  - `getSettings` / `updateSettings` throw `ONBOARDING_REQUIRED` until a timezone
    exists — matches M11's refusal-code table, and nothing in M3–M8 should run before
    step 1 anyway.
  - `exportAccount` throws `NOT_YET_AVAILABLE` (deferred, master plan §5.8).
  - `deleteAccount` is `delete from app_user where id = $1`; cascade does the rest.
    Idempotent (deleting a missing user is a no-op).
- **`OnboardingService`** (`src/core/identity/onboarding.ts`) — the 5-step `/start`
  machine, transport-neutral: `start(userId)` and `answer(userId, {value, step?})`
  return a `prompt` (text + options M7 turns into inline buttons), `complete`,
  `summary` (returning user — settings, not a new account) or `refused` (code +
  message + the prompt to re-show). Steps: timezone (7 curated AU zones as buttons +
  IANA search over `Intl.supportedValuesOf('timeZone')` for free text) → currency
  (AUD one-tap, or a typed ISO code validated against `Intl.supportedValuesOf`) →
  budget start date (buttons for local today / 1st of this month / 1st of next month,
  computed from the injected `Clock` in the user's zone; free text `YYYY-MM-DD`) →
  categories+caps ("Food" pre-seeded through `assertAllowed` + `CategoryService.create`;
  `"Name [cap]"` adds/caps via M8 gate → M3 create → M4 `setCap`; `"remove Name"`
  archives via M3; Done) → reminder selection (buttons per category; each pick goes
  through `assertAllowed({kind:'enable_reminder'})` then
  `ReminderSelectionService.enable`; Free auto-completes at 1, Premium at 5 or Done).
  The starter seed is idempotent, so a resumed step 4 never duplicates "Food". A
  timezone button arriving at any other step — mid-flow, after completion, a forged
  callback — is routed straight to `setInitialTimezone`, so the write path decides
  (identical replay re-prompts, a change is `TIMEZONE_IMMUTABLE`). Other stale
  buttons are `STALE_ACTION`.
- **`ChannelConnectionDirectory`** (new tiny port, implemented by
  `IdentityServiceImpl`): `activeConnection(userId, channel)` and
  `deactivateConnection` — M7's "403 blocked ⇒ deactivate via M2" path and M5's
  `MessageSender` input. M2 stays the only writer of `channel_connection`.
- **Domain helpers** (`src/core/domain/`): `timezone.ts` — `CURATED_AU_TIMEZONES`,
  `canonicalTimezone`, `searchTimezones`, `localDateAt` / `localTimeAt` (the one
  "local date derived at write time" helper every module can share; DST-tested on the
  Oct 2026 AEDT start), `isLocalDate` / `isLocalTime`. `refusal.ts` — `RefusalError
  { code: RefusalCode }`, one class for M7 to catch; M3/M8 are welcome to throw it.
- **Persistence seam** `IdentityRepository` (`src/core/identity/repository.ts`) —
  `DrizzleIdentityRepository` is the only M2 code that sees a DB handle;
  `InMemoryIdentityRepository` (`src/core/testing/`) reproduces the unique constraint
  and the conditional timezone update at the moment of the write so the race tests
  are meaningful without Postgres.
- **Tests** — 57 new unit tests (66 total pass): concurrent duplicate `register` (25
  callers, one user, one `isNew`); timezone rejection through `setInitialTimezone`
  (different value, concurrent different values), `updateSettings` (same-value and
  different-value forged patches), a forged step-1 callback mid-flow and after
  completion, and a second `/start`; currency allowed at 0 transactions / refused at 1;
  anchor-date change touches only that column and never calls M3; cascade delete
  (in-memory) removes connections + simulated foreign rows and leaves other users
  alone; the full 5-step happy path including the hand-off shapes to M3/M4/M5/M8;
  `CATEGORY_LIMIT` / `REMINDER_CATEGORY_LIMIT` surfaced from M8 with no write;
  timezone search/canonicalisation/DST. **Integration tier**
  (`test/integration/identity.test.ts`): the race, the conditional timezone write,
  settings round-trip, check constraints, and cascade delete against real Postgres —
  **skipped in this environment (no `DATABASE_URL` / Neon branch available), not
  faked.** It runs in CI's per-PR Neon job once `NEON_PROJECT_ID` is set. Cascade
  coverage is `channel_connection` only because that's the only user-owned table that
  exists yet; later modules should extend it.
- `npm run typecheck` and `npm test` both pass.

### Assumed

- **`timezone` is nullable in the DB** (doc says `not null`). `register` runs on first
  contact — M7 resolves every inbound message before routing — which is *before*
  onboarding step 1, so a `not null` column can't coexist with the doc's own
  `setInitialTimezone` flow without a sentinel value, and a sentinel would be a lie
  M8's quota reset could act on. Same null-until-step pattern the doc already uses
  for `period_anchor_date`. Immutability comes from the conditional update, not from
  nullability. `UserSettings.timezone` stays `string` — `getSettings` throws
  `ONBOARDING_REQUIRED` rather than returning a null.
- **`onboarding_step` column on `app_user`** (`text` + `check`, default `'timezone'`)
  rather than a separate draft table: steps 1–3 write settings, steps 4–5 persist
  through M3/M4/M5, so the only state between messages is *which step*. A separate
  table would be pure ceremony.
- **`ResolvedUser.onboarded: boolean`** added next to M1's `isNew` so M7 can route free
  text to the onboarding machine vs. M6 without a second query. M1 flagged these DTOs
  as refinable by the owning module.
- **Three new ports** (each file's header explains; none changes an existing interface):
  - `CategoryService` (M3-owned): `list` / `create` / `archive`. M1 committed only
    `LedgerService` for M3, which has **no category methods at all**, yet M2 step 4 must
    create categories through M3 (it may not write M3's table). Smallest surface that
    unblocks; M3 owns it and may rename/widen.
  - `ReminderSelectionService` (M5-owned): `enabledCategoryIds` / `enable` / `disable`.
    No committed schema or port holds "this category has a reminder" — `category` has
    no such column and `daily_allowance_send` is per-day output — while M8 says "M5
    checks reminder capacity before enabling a reminder" and M11 routes `/remind` to
    M5. M5 decides where the flag lives (a column on `category` seems likeliest —
    coordinate with M3).
  - `ChannelConnectionDirectory` (M2-owned): see Built. Separate rather than widening
    `IdentityService`, so the agreed interface stays verbatim.
- **`toMinorUnits` / `formatMinorUnits` are injected** into `OnboardingService`
  (defaults are M3's domain functions, which are still `throw 'not implemented'`
  stubs). Tests inject a two-decimal parser; production wiring uses the defaults once
  M3 lands. The contract is called, not stubbed around.
- **"Any transaction" for the currency rule = `history(userId, {limit: 1})` is
  non-empty.** Whether M3's `history` includes soft-deleted rows decides whether a
  deleted-only ledger still locks currency; I'd argue it should (the row still carries
  a currency). No dedicated port method invented.
- **Currency-locked refusal code is `INVALID_ARGUMENT`** with an explanatory message —
  M11's table has no `CURRENCY_LOCKED`, and inventing refusal codes is the lead's call.
- **Onboarding input protocol**: `"Name 500"` = name + cap (a trailing number is the
  cap, so a category can't be named e.g. `"Round 2"` — `"Round2"` works);
  `"remove Name"` archives; `done` advances. Category name ≤ 40 chars. Free text and
  button values share one `answer()` path; buttons additionally carry `step` so stale
  ones are detected. Copy is plain text, no Telegram markup; echoed user input is
  stripped of markup characters.
- **Free tier auto-completes step 5 after one pick** (limit reached, nothing left to
  ask). Step 5 requires ≥ 1 reminder category; step 4 requires ≥ 1 category. Neither
  is stated in the doc — both seemed like the obvious reading of "pick which".
- **`register` re-activates a deactivated connection.** Not in the doc; needed so a
  user who blocked the bot (M7 sets `is_active = false`) can come back with `/start`.
- **`periodAnchorDate` hand-off** is a full `LocalDate` string, exactly what M4's plan
  says it will store and derive `min(day, 28)` from; the step-4 prompt warns when the
  chosen day is > 28. No `periodType` exists (monthly only). M4 hasn't been built, so
  this is checked against the doc, not code.
- **Local-date derivation lives in `core/domain/timezone.ts`** (`localDateAt`) so
  M3/M4/M5/M8 can share one implementation rather than four; based on `Intl`, no
  dependency added.

### Open questions

1. **5-step vs 6-step onboarding** — built as **5** per the doc's own resolution and
   master plan §5.6 ("confirmed: 5 steps"). If Ricky still wants the 6th
   confirmation-only screen, it slots in between steps 3 and 4 as a choiceless prompt
   (`onboarding_step` check constraint would gain one value).
2. **`CategoryService` and `ReminderSelectionService` need their owners' sign-off**
   (M3 / M5). M2's onboarding is their only caller today; renaming is cheap now,
   expensive after M7 wires `/categories` and `/remind`. The reminder flag's home
   (column on `category`? separate table?) is genuinely undecided — the M3/M4 schema
   PR is the natural place to settle it.
3. **`timezone` nullable + `onboarding_step` column** deviate from the "Agreed" Notion
   schema. Both reasoned above; flagging so it's a decision, not a surprise.
4. **CI doesn't run on PRs to `phase-1`** — `.github/workflows/ci.yml` triggers on
   `pull_request: branches: [main]` only, so no Phase 1 PR gets typecheck/unit or the
   Neon integration job until it reaches `main`. Adding `phase-1` to that list is a
   one-line change I left to whoever owns the workflow.
5. **Integration tests are unverified against real Postgres in this environment.** They
   are written and skip cleanly without `DATABASE_URL`; the first run will be CI's
   Neon job (blocked on item 4 + `NEON_PROJECT_ID`) or a local scratch branch. The
   Drizzle `tx.rollback()` / `TransactionRollbackError` path in `register` is the piece
   I'd most like to see exercised for real.
6. **`reminder_local_time` is writable through `updateSettings`** because the port's
   patch type includes it, but this pass is fixed 07:00 for everyone (§5.2). M7 should
   not expose a way to set it; M5 should still read the column rather than hard-code.
7. **Whether a currency change should be refused for a user with only soft-deleted
   transactions** — see Assumed; depends on M3's `history` semantics.
