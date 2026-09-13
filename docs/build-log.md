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
  `period_anchor_date date` nullable. `timezone` is non-null; a newly registered user
  holds the internal empty-string sentinel only until required onboarding step 1 sets
  a valid IANA zone. An `onboarding_step` column is added for resumability. Migration
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
    `update app_user set timezone = $1 where id = $2 and timezone = ''`. The DB
    arbitrates: `'set'` ⇒ done; `'already_set'` + same value ⇒ idempotent replay,
    succeeds; different value ⇒ `TIMEZONE_IMMUTABLE`. Under concurrent first writes
    exactly one wins (tested, unit + integration).
  - `updateSettings` — the patch type already omits `timezone`; runtime guards
    additionally refuse any patch that carries a `timezone` key **even when the value
    equals what is stored**, and reject unknown setting keys from untyped JavaScript
    callers. `currency`
    change asks M3 (`LedgerService.history(userId, {limit: 1})`) and is refused once
    any transaction exists, with an explanation and no conversion; a same-value
    currency patch doesn't consult M3. `periodAnchorDate` change writes the column and
    nothing else — periods are derived (M4), so this *is* the re-bucket. `null` is
    refused post-onboarding. `reminderLocalTime` is validated `HH:MM` and written; M5
    reads it at the next due-scan, so it can only affect the next send.
  - `getSettings` / `updateSettings` throw `ONBOARDING_REQUIRED` while the internal
    pre-onboarding timezone is empty — matches M11's refusal-code table, and nothing
    in M3–M8 receives the sentinel.
  - Construction uses a named dependency object and narrows M3 to
    `Pick<LedgerService, 'history'>`, so wiring remains clear as dependencies grow.
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
  `"Name [cap]"` adds/caps via M8 gate → M3 create → M4 `setCap`; `"rename Old to New"`
  renames and `"remove Name"` archives via M3; Done is allowed only once at least one
  category has an active budget) → optional reminder selection (buttons per category;
  Done can skip the step; each pick goes
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
  are meaningful without Postgres. `OnboardingStep` is defined in M2 core rather than
  imported from the Drizzle schema, so dependencies point from adapters toward core.
  All initial and update timestamps are supplied by the injected `Clock`.
- **Tests** — 61 M2 unit tests (70 total pass): concurrent duplicate `register` (25
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

- **`timezone` is non-null in the DB.** `register` runs before step 1 can collect a
  real value, so it writes `''` as an explicit internal pre-onboarding sentinel.
  `getSettings` and local-date derivation refuse while it is empty; the persisted
  `onboarding_step` keeps such users on the timezone prompt. M3–M8 therefore never
  receive or act on it. Immutability comes from the conditional `where timezone = ''`
  update, and `UserSettings.timezone` remains a non-empty string contract.
- **`onboarding_step` column on `app_user`** (`text` + `check`, default `'timezone'`)
  rather than a separate draft table: steps 1–3 write settings, steps 4–5 persist
  through M3/M4/M5, so the only state between messages is *which step*. A separate
  table would be pure ceremony.
- **`ResolvedUser.onboarded: boolean`** added next to M1's `isNew` so M7 can route free
  text to the onboarding machine vs. M6 without a second query. M1 flagged these DTOs
  as refinable by the owning module.
- **Three new ports** (each file's header explains; none changes an existing interface):
  - `CategoryService` (M3-owned): `list` / `create` / `rename` / `archive`. M1 committed only
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
  `"rename Old to New"` renames; `"remove Name"` archives; `done` advances. Category name ≤ 40 chars. Free text and
  button values share one `answer()` path; buttons additionally carry `step` so stale
  ones are detected. Copy is plain text, no Telegram markup; echoed user input is
  stripped of markup characters.
- **Free tier auto-completes step 5 after one pick** (limit reached, nothing left to
  ask). Step 5 may also be skipped with Done and zero reminder categories. Step 4
  requires ≥ 1 category and an active category budget before it can advance.
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
3. **`onboarding_step` is an intentional addition** to the agreed schema so onboarding
   survives stateless Worker invocations. `timezone` now follows the agreed non-null
   constraint, using the guarded pre-onboarding sentinel described above.
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

---

## M2 — CLAUDE.md conventions refactor — 2026-09-06

**Branch:** `m2-identity-accounts` (via `pr2-m2-identity-work`) · **Phase:** 1 ·
**Scope:** structural only — no product behaviour changed, no schema changed, no
migration regenerated. The same 70 unit tests pass before and after.

`CLAUDE.md` landed on `phase-1` after the M2 PR was opened, and its worked examples in
"Ports and interfaces", "Public module exports", "Repository interfaces" and "Drizzle
repository implementations" describe this module by name. This entry records the moves
and renames, so the M2 entry above reads as history — the paths and symbols below are
current.

### Moved

| Was | Now | Why (CLAUDE.md) |
|---|---|---|
| `src/core/identity/drizzle-repository.ts` | `src/infrastructure/database/repositories/drizzle-identity-repository.ts` | Core must not import Drizzle or the DB client; "Drizzle repository implementations" names this exact path. |
| `src/core/identity/repository.ts` | `src/core/identity/identity-repository.ts` | Named in the file-naming convention list and the target tree. |
| `src/core/identity/identity-service.ts` (impl) | `src/core/identity/default-identity-service.ts` | Target tree: `identity-service.ts` holds the contract, `default-identity-service.ts` the implementation. |
| `src/core/ports/identity-service.ts` | `src/core/identity/identity-service.ts` | "Do not use a global `core/ports` folder as a dumping ground" — module-owned contracts live in the owning feature folder. |
| `src/core/ports/channel-connection-directory.ts` | `src/core/identity/channel-connection-directory.ts` | Same; its own header already said "M2-owned". |
| `src/core/domain/timezone.ts` | `src/core/identity/timezones.ts` | "Do not use `core/domain` as a general dumping ground"; the target tree names `core/identity/timezones.ts`. |
| `src/core/domain/refusal.ts` | `src/core/identity/errors.ts` | Same; the target tree names `core/identity/errors.ts`. |
| `src/core/testing/in-memory-identity-repository.ts` | `test/support/in-memory-identity-repository.ts` | "Put reusable test-only code under `test/support/`" — a test double does not belong in production `src/`. |
| `test/unit/domain/timezone.test.ts` | `test/unit/identity/timezones.test.ts` | Follows its subject. |
| `test/unit/identity/identity-service.test.ts` | `test/unit/identity/default-identity-service.test.ts` | Follows its subject. |

`src/core/domain/index.ts` and `src/core/ports/index.ts` dropped only the
corresponding re-export lines. `money`/`period`/`allowance` and the M3/M5-proposed
ports were left alone — not this module's to move.

### Renamed

- `IdentityServiceImpl` → **`DefaultIdentityService`** (CLAUDE.md's own "Public module
  exports" example), and `IdentityServiceDeps` → `DefaultIdentityServiceDeps`.
- Repository port, to CLAUDE.md's "Repository interfaces" and "Methods and functions"
  examples — business terminology, verb-first, `find…` where absence is expected:
  - `register(channel, externalId, chatId, username, now)` →
    `registerConnection(input: RegisterConnectionInput)`
  - `setTimezoneIfUnset` → `claimInitialTimezone` (named verbatim in the doc, twice)
  - `activeConnection` → `findActiveConnection` (also on `ChannelConnectionDirectory`)
  - `AppUserRecord` → `UserRecord`, `AppUserPatch` → `UserRecordPatch`,
    `ConnectionLookup` → `ConnectionRecord`, `RegisterOutcome` →
    `RegisterConnectionResult`, `SetTimezoneOutcome` → `ClaimTimezoneOutcome`
- `OnboardingStateStore.onboardingStep` → `getOnboardingStep`; `.userRecord` →
  `requireUserRecord` ("`require…` when absence is exceptional" — it throws).
- Added `UserSettingsPatch = Partial<Omit<UserSettings, 'timezone'>>` — the name
  CLAUDE.md's incoming-port example uses — and used it on `updateSettings`.

**`IdentityService`'s own method names are untouched.** `resolve`, `register`,
`getSettings`, `setInitialTimezone`, `updateSettings`, `exportAccount` and
`deleteAccount` are the agreed contract from `docs/M2-identity-accounts.md`, and
CLAUDE.md's "do not silently change an established public contract" rule applies.

### `core/identity/index.ts`

Now a pure barrel over the module's public surface: `IdentityService` and its types,
`ChannelConnectionDirectory`, `IdentityRepository` and its types, `OnboardingStep`,
`DefaultIdentityService`, `OnboardingService` and its types, `RefusalError`, and the
timezone helpers. It deliberately does **not** re-export `DrizzleIdentityRepository` —
that would make `core` depend on `infrastructure`, which CLAUDE.md's dependency
direction forbids. The composition root imports it from
`infrastructure/database/repositories/drizzle-identity-repository` directly, exactly as
CLAUDE.md's "Database connection" wiring example shows.

### Deliberately not done — out of this PR's scope

1. **`src/db/` was not moved to `src/infrastructure/database/`.** CLAUDE.md's target
   tree puts `client.ts`, `schema/` and `migrations/` there, but that is a repo-wide
   move touching every module's schema file and the committed migration journal, and
   `drizzle.config.ts` plus CI reference the current paths. It needs its own PR.
2. **`src/core/ports/common.ts` and `clock.ts` were left in place.** CLAUDE.md wants
   them at `core/shared/common.ts` and `core/shared/clock.ts`; every module imports
   them, so that is also repo-wide.
3. **`src/core/testing/test-clock.ts` was left in place.** Same violation class as the
   in-memory repository (a test double in production `src/`), and CLAUDE.md names
   `test/support/test-clock.ts` — but `TestClock` is M1's, shared by every module's
   tests. Moving it belongs with item 2.
4. **`test/unit/identity/fakes.ts` was left in place.** It fakes *other* modules' ports
   (M3/M4/M5/M8). CLAUDE.md's `test/support/` tree names `fake-ledger-service.ts` and
   `in-memory-entitlement-repository.ts`; those are the owning modules' to author, and
   creating them speculatively from M2's PR would collide with their branches.

### Architectural conflicts flagged, not resolved

1. **`CategoryService` (M3-owned) and `ReminderSelectionService` (M5-owned) stay in
   `core/ports/`.** CLAUDE.md forbids a global ports folder, so they should end up in
   `core/ledger/` and `core/allowance/` — but both of those folders are still bare
   `export {}` stubs giving no signal about where their contracts will live, and M3/M5
   are explicitly free to rename, widen, or fold these into `LedgerService` /
   `DailyAllowanceService` (M2's open question 2, above). Dropping a live contract into
   another module's stub folder now would collide with whatever their PRs do. **M3 and
   M5 should relocate these into their own feature folders as part of their PRs**;
   M2's onboarding is the only caller to update.
2. **`RefusalError` now lives in `core/identity/errors.ts`** because CLAUDE.md's target
   tree names that file for M2 — but its own contract is deliberately cross-module
   ("M3/M8 are welcome to throw the same class so M7 has exactly one thing to catch").
   The moment a second module throws it, it belongs in `core/shared/errors.ts`, not
   inside M2. The same argument applies to `localDateAt` / `localTimeAt` in
   `core/identity/timezones.ts`, which M3/M4/M5/M8 are all expected to use for the
   "local date derived at write time" rule. Lead's call — flagged rather than
   pre-empted, since moving them now would create a `core/shared` nothing else has
   agreed to yet.
3. **`docs/M2-identity-accounts.md` and the M2 entry above still name the old paths and
   `IdentityServiceImpl`.** The product behaviour they describe is unchanged and
   correct; only file and symbol names moved. Left as historical record rather than
   rewriting an agreed plan doc.

### Verification

- `npm run typecheck` — passes.
- `npm test` — 70 passed, 6 skipped; identical to before the refactor.
- `npm run test:integration` — **not executed.** It needs a real `DATABASE_URL`
  (Postgres/Neon) and is not PGlite-backed, so it is unavailable in this environment.
  The suite `describe.skip`s cleanly without it; its imports were updated and are
  covered by `tsc`.
- `npm run db:generate` — **not run, deliberately**: no schema shape changed.

---

## Refactor — platform-wide CLAUDE.md restructure lands on this branch — 2026-09-06

**Branch:** `m2-identity-accounts` · **Phase:** 0 (structural correction, not M2 work)

### Why

The M1 scaffold this branch forked from (`3584b3a`) predates `CLAUDE.md`, which
forbids a global `core/ports/` barrel and a global `core/domain/` dumping ground and
requires `infrastructure/database/` instead of top-level `db/`. This M2 branch had
already relocated its own `IdentityService` contract into `core/identity/` and
flagged the rest ("Deliberately not done — out of this PR's scope", above) as a
repo-wide follow-up. That follow-up landed on `phase-1` as commit `832cdf6`; this
entry brings the equivalent change onto this branch so it isn't left conflicting
with `phase-1` when it merges.

### Moved (mirrors `832cdf6`, adapted to what M2 already did)

- `core/ports/common.ts`, `clock.ts` → `core/shared/`.
- `core/ports/messaging.ts` → `core/shared/messaging.ts`.
- `core/ports/{budget,ledger,entitlement}-service.ts` → each module's own folder.
- `core/ports/daily-allowance-service.ts` → `core/allowance/allowance-service.ts`.
- `core/ports/llm-parser.ts` → `parsing/llm-parser.ts`.
- `core/domain/money.ts` → `core/shared/money.ts`, `core/domain/period.ts` →
  `core/budgets/period.ts`, `core/domain/allowance.ts` →
  `core/allowance/daily-target.ts`.
- `db/` → `infrastructure/database/` (`client.ts`, `schema/` — including this
  branch's real `identity.ts` — `migrations/`, including the already-generated
  `0000_identity.sql` and its snapshot); `drizzle.config.ts` updated to match.
- `core/testing/test-clock.ts` → `test/support/test-clock.ts`; every test file that
  imported it (`clock.test.ts`, `scaffold.test.ts`, `identity/fakes.ts`'s callers,
  `default-identity-service.test.ts`, `onboarding.test.ts`,
  `integration/identity.test.ts`) updated to match.
- Every non-identity core module's `index.ts` now re-exports its contract
  (type-only) instead of `export {}`.

### Not moved — `core/ports/` still exists, on purpose

`category-service.ts` and `reminder-selection-service.ts` **stay in `core/ports/`**,
exactly as this branch's own M2 entry (above) already decided: they're proposed by
M2 but owned by M3/M5, and dropping them into another module's still-empty stub
folder now would collide with those modules' own PRs. `core/ports/index.ts` is
trimmed to just these two exports, with an updated header explaining why the
folder still exists.

### Verification

- `npm run typecheck` — passes.
- `npm test` — 70 passed, 6 skipped — identical to this branch's prior baseline.
- `npm run db:generate` — no-op; the existing `identity` migration snapshot is
  unchanged.
- `npm run test:integration` — not executed (no `DATABASE_URL` in this environment).

---

## M8 — Entitlements & Limits — 2026-09-06

**Branch:** `worktree-agent-ac0392f4153274c16` · **Phase:** 1 (policy only; Stars billing is Phase 2)

### Built

- **Schema** `src/infrastructure/database/schema/entitlement.ts` — `entitlement` and the revised
  `usage_counter`, Drizzle definitions matching M8's provisional SQL exactly: `text` +
  `check` for `tier`/`source`/`status`, partial unique index `entitlement_one_active`
  `(user_id) where status = 'active'`, `usage_counter` PK `(user_id, message_id)`,
  indexes `usage_counter_window (user_id, admitted_at)` and `usage_counter_daily
  (user_id, local_date)`, both FKs `references app_user(id) on delete cascade`. Verified
  by running `drizzle-kit generate` against a throwaway copy with a stub `app_user` —
  the emitted SQL is the doc's, statement for statement. **No migration file is
  committed** (see Open questions 1).
- **`EntitlementService` implementation** in `src/core/entitlements/`:
  - `service.ts` — `EntitlementServiceImpl<X>` / `createEntitlementService`. Storage-
    agnostic policy over an M8-internal `EntitlementStore<X>` port (`ports.ts`), where
    `X` is the *executor* type (Drizzle transaction handle in production).
  - `admitMessage` is **one store transaction**: per-user advisory lock → duplicate
    `message_id` short-circuits to `duplicate` *before* any limit check (a redelivery
    of a counted message is never refused) → fair-use window and Free daily cap
    evaluated together → refused returns without writing; admitted inserts the
    `usage_counter` row (`on conflict do nothing` as belt-and-braces). The window is a
    true sliding window: rows with `admitted_at > receivedAt − 120 min` count, so an
    event exactly 120 minutes old has left. `local_date` is computed at write time
    from `receivedAt` and M2's immutable timezone (`local-time.ts`, `Intl`-based, no
    tz library; handles DST 23/25-hour days and midnight-gap zones).
  - Recovery messaging verbatim from the doc (`messages.ts`): fair-use *"You've
    reached 20 messages in 2 hours. Try again in {minutes} minutes."* computed from the
    earliest counted message's expiry (`ceil`, min 1, singular "1 minute"); daily
    *"You've used your 5 messages today. Your limit resets at 12:00 am
    (Australia/Brisbane)."*; both exhausted → the later `retryAt`, its code, and a
    message explaining both.
  - `assertAllowed` — `create_category`/`reactivate_category` (10 Free / 30 Premium,
    non-archived count), `enable_reminder` (1 / 5), `request_downgrade` (≤10 AND ≤1;
    a Free user gets `NO_SUBSCRIPTION`). Throws `EntitlementRefusal` (new class in the
    port file) carrying M11's `RefusalCode` + user text; `retryAt` for time limits.
  - **`gate(userId, action, write)`** — the atomic form of `assertAllowed`: runs the
    caller's write in the same transaction, serialised behind the capacity check under
    a per-user lock. This is how M3/M5 satisfy "capacity checks are atomic with the
    domain write they gate"; `assertAllowed` alone is `gate` with a no-op write.
  - `assessDowngrade` — returns `eligible`, `tier`, `current`, `limits`, `mustRemove`,
    and a cleanup `message`; never deletes anything.
  - `tierOf` — reads the `status = 'active'` row on every call and *also* treats an
    active row with `current_period_end <= clock.now()` as Free. No caching anywhere.
  - `drizzle-store.ts` — production store; locks via
    `pg_advisory_xact_lock(hashtext('m8:<scope>'), hashtext(user_id))`.
  - `memory-store.ts` — in-memory store with real per-user async locks held for the
    whole transaction callback, so concurrency tests mean something. Exported for
    other modules' unit tests too.
  - `billing.ts` — `NotConfiguredStarsBilling` implementing the new
    `StarsBillingService` port: purchase/renewal/refund all answer
    `{ status: 'not_configured', code: 'BILLING_UNAVAILABLE' }`.
- **Port file** `src/core/ports/entitlement-service.ts` — the four method signatures
  are untouched. Added: `EntitlementRefusal` + `isEntitlementRefusal`, `CapacityCounts`,
  a richer `DowngradeEligibility` (superset of M1's), and the Phase 2
  `StarsBillingService` / `StarsPaymentEvent` / `BillingOutcome` types.
- **Tests** — 44 new unit tests (`test/unit/entitlements/`), all with `TestClock`:
  21st-in-window refused / 22nd admitted at exactly +120 min (and refused at
  +120 min − 1 ms); 20 + 21 burst across the 02:00 wall-clock boundary refused; a
  refused attempt consumes no slot; Free's 6th of the local day refused with the
  local reset instant, admitted at local midnight; Premium's 100th admitted; local-
  day vs UTC-day (Brisbane vs Honolulu); Sydney DST 23-hour day; both-limits branch
  (via injected limits, since it's unreachable under 5/day < 20/2h); duplicate id
  once (sequential, over-limit, and 8-way concurrent); 35 concurrent distinct
  messages → exactly 20; per-user lock independence; `tierOf` lapse at
  `current_period_end` and on status change; category 9/10, 29/30, reactivate;
  reminder 0/1, 4/5; **concurrent `gate` creations at 9 → exactly one succeeds**;
  downgrade 11/2 refused with the exact instructions, 10/1 eligible; billing stubs.
  Plus `local-time` unit tests. `test/integration/entitlements.test.ts` runs only
  with `DATABASE_URL` (PK dedupe under concurrency, daily cap, partial unique index
  and check constraints at the DB) — not run locally, see Open questions 2.
- `npm run typecheck` clean; `npm test` 53 passed, 3 skipped (integration).

### Assumed

- **`receivedAt` is the accounting instant** for both the window and `local_date` —
  it's the message's arrival as M7 saw it (M7 gets it from its `Clock`). The injected
  `Clock` in this module is used for tier validity (`current_period_end`), not for
  message accounting. No `Date.now()` anywhere.
- **Reminder-enabled state has no schema home yet.** No module doc defines where
  "reminder enabled on category X" is stored (`category` has no such column; M5's
  table is per-day; M11's `/remind` lists M5/M2/M8). Per the doc ("this module just
  compares the count M3 supplies"), M8 takes an injected `CapacityReader<X>` —
  `activeCategoryCount` (M3: `count(*) where is_archived = false`) and
  `reminderCategoryCount` (whoever owns the flag) — and never reads those tables
  itself. Production wiring supplies these; `timezoneOf` is an adapter over
  `IdentityService.getSettings(id).timezone`.
- **Window is unbounded above**: any row with `admitted_at` within the last 120 min
  counts, including one timestamped slightly *after* `receivedAt` (out-of-order
  delivery). Conservative in the user's disfavour by at most the reordering skew.
- **A lapsed-but-still-`active` Premium row is Free** without M8 mutating `status` —
  the state machine that flips it is Phase 2 billing. Reads stay side-effect free.
- **Refusal codes for `request_downgrade`**: `CATEGORY_LIMIT` if categories are over
  (with or without reminders over), else `REMINDER_CATEGORY_LIMIT`; message always
  lists everything that must go. Free user → `NO_SUBSCRIPTION`.
- **Reset-time label** is `formatLocalTime` (`en-AU`, `12:00 am`) plus the IANA name in
  parentheses. M7 may re-render from `retryAt` if a different format is wanted.
- **Advisory-lock scopes** are `m8:admission` and `m8:capacity`, keyed by user — a
  user at the message cap doesn't block their own category creation, and no user
  blocks another.
- `TierLimits`/`FairUseWindow` are injectable (`limits` dep) **only** so tests can hit
  the combined-limits branch; the values are settled policy, not config.

### Open questions

1. **Merge order: M2 before this PR.** `entitlement.user_id` / `usage_counter.user_id`
   import `appUser` from `src/db/schema/identity.ts`, which is still M1's `export {}`
   on this branch. The import is isolated with one `// @ts-expect-error` line and a
   `TODO(M2 merge order)` comment so the whole tree still typechecks; **after
   rebasing onto M2, delete that directive** — tsc will then fail on it as an unused
   `@ts-expect-error`, so it can't be forgotten. Then run `npm run db:generate` to emit
   the migration (it must be numbered after M2's, which is why none is committed
   here) and commit the SQL + `meta/`. The expected SQL is in the PR body.
2. **Integration suite not executed.** No Neon project / `DATABASE_URL` locally, and
   `app_user` doesn't exist yet. The suite is `describe.skipIf(!DATABASE_URL)`; CI's
   per-PR branch job will be its first real run once M2's migration is in. The
   `min(admitted_at)` mapping (`.mapWith(usageCounter.admittedAt)`) and the
   `hashtext(...)` parameter typing are the two lines I'd watch on that first run.
3. **Who owns the reminder flag?** See Assumed. Whichever of M3/M5 adds the column,
   it should also provide the `reminderCategoryCount` reader and call
   `entitlements.gate(userId, { kind: 'enable_reminder' }, write)` around the flip.
   `category.reminder_enabled boolean not null default false` on M3's table would be
   the simplest home, and M3's archive path must clear it (M3 doc §"Also required").
4. **`GatedAction` not widened.** M1's four kinds cover the doc. If M7 needs a gate for
   callback-driven actions ("must not let button-driven actions bypass the same
   admission gate"), that's `admitMessage` with the callback's stable id — no new
   kind needed, but M7 should confirm its id scheme distinguishes callback ids from
   message ids.

### CLAUDE.md convention pass — 2026-09-06 (follow-up commit on the same branch)

`CLAUDE.md` landed on `phase-1` after the M8 implementation commit. This branch was
merged with it and the entitlements module *only* was brought in line. No behaviour
changed: same 53 unit tests, same assertions, `npm run typecheck` clean.

**Moved / renamed (module scope only):**

- `src/core/ports/entitlement-service.ts` → `src/core/entitlements/entitlement-service.ts`
  — a module-owned contract belongs in its feature folder, not the global `core/ports`
  dumping ground. `src/core/ports/index.ts` drops that one re-export line; the other
  modules' stubs there are untouched (they move with their own PRs).
- The Phase 2 billing port (`StarsBillingService` / `StarsPaymentEvent` /
  `BillingOutcome`) moved from that same file into `core/entitlements/billing.ts`,
  where its only implementation (`NotConfiguredStarsBilling`) already lived.
- `core/entitlements/ports.ts` → `core/entitlements/entitlement-repository.ts` (the
  outgoing port), with `EntitlementStore` → `EntitlementRepository` and
  `EntitlementTx` → `EntitlementTransaction`.
- `core/entitlements/service.ts` → `core/entitlements/default-entitlement-service.ts`;
  `EntitlementServiceImpl` → `DefaultEntitlementService`. `createEntitlementService`
  is unchanged; its `deps.store` field is now `deps.repository`.
- `core/entitlements/drizzle-store.ts` → **`src/infrastructure/database/repositories/
  drizzle-entitlement-repository.ts`**; `DrizzleEntitlementStore` →
  `DrizzleEntitlementRepository`, `DbExecutor` → `DatabaseExecutor`. This was the real
  violation: core code was importing `drizzle-orm` and `db/client` directly. `src/core`
  now imports neither.
- `core/entitlements/memory-store.ts` → **`test/support/in-memory-entitlement-repository.ts`**;
  `MemoryEntitlementStore` → `InMemoryEntitlementRepository`. A test double no longer
  ships in a production feature folder or its barrel.
- Verb-first port method names: `activeEntitlement` → `findActiveEntitlement`,
  `usageInWindow` → `getUsageInWindow`, `usageOnLocalDate` → `countUsageOnLocalDate`,
  `insertUsage` → `recordUsage`, `transaction` → `runInTransaction`, and on
  `CapacityReader` (which M3/M5 will implement) `activeCategoryCount` →
  `countActiveCategories`, `reminderCategoryCount` → `countReminderCategories`.
- `core/entitlements/index.ts` is now a pure barrel — no wiring logic, no adapters.
- The schema file was reviewed against CLAUDE.md's database-naming section and
  needed no change (camelCase TS properties, snake_case tables/columns). It was not
  moved in this commit; `phase-1`'s platform-wide restructure has since relocated the
  whole `src/db/` tree, so it now lives at
  `src/infrastructure/database/schema/entitlement.ts`.

**Architectural conflicts flagged rather than resolved** (CLAUDE.md: report, don't
silently choose; all of these need a repo-wide decision, not an M8-only change):

1. **`gate()` vs CLAUDE.md's "Transactions" rule.** CLAUDE.md says core services
   should not become generic over a Drizzle executor and that raw transaction handles
   should not cross core-module boundaries — and names M8's `gate()` design as the
   case to consider. `DefaultEntitlementService<X>` *is* generic over an executor `X`
   and hands it to the caller's `write(executor)`. Core never imports a Drizzle type
   (`X` is fully abstract, which is why the in-memory test double can supply a plain
   object), but in production `X` is a Drizzle transaction handle passed to M3/M5.
   This is the only design that satisfies M8's own invariant — "capacity checks are
   atomic with the domain write they gate" — without one of CLAUDE.md's three
   alternatives (a technology-independent transaction contract, an orchestration
   service, or an explicit operation on M3/M5's contracts). Deciding between them
   changes a contract M3/M5 will build against, so it needs a call before those
   modules land, not a unilateral rewrite here.
2–5. **The four structural deferrals — `core/ports/{common,clock}.ts` outside
   `core/shared/`, `src/db/` outside `src/infrastructure/database/`, `src/core/domain/`
   as a dumping ground, and `src/core/testing/test-clock.ts` inside production `src/` —
   have all been resolved on `phase-1`** by the platform-wide restructure recorded
   above. Each was flagged here rather than fixed because it was a repo-wide refactor,
   which is exactly how it was eventually done. Nothing is outstanding from this list;
   see the merge note below for how M8 was rewired onto the new paths.

---

## M8 ← phase-1 merge — 2026-09-07

Merging `phase-1` back into the M8 branch (PR #3). `phase-1` had meanwhile landed M2
and the platform-wide CLAUDE.md restructure, so this merge is mostly M8 catching up to
the new tree. No M8 behaviour changed.

### Conflicts and how they were resolved

- **`src/core/entitlements/entitlement-service.ts`** — rename/delete. M8 deleted
  `core/ports/entitlement-service.ts` and wrote the real contract at the new path;
  `phase-1` independently *renamed* the old stub to that same path. Took M8's version
  (a strict superset: `EntitlementRefusal`, `CapacityCounts`, the richer
  `DowngradeEligibility`), repointed at `../shared/common`.
- **`src/core/entitlements/index.ts`** — took M8's barrel; `phase-1`'s was still the
  pre-implementation stub that only re-exported four types.
- **`src/core/ports/index.ts`** — took `phase-1`'s. It is now trimmed to
  `category-service` + `reminder-selection-service` (M3/M5-owned, deliberately parked
  there); M8's edit to that file only removed the entitlement re-export, which
  `phase-1` had already done.
- **`docs/build-log.md`** — purely additive collision; both sections kept, and the four
  now-obsolete structural deferrals in M8's entry rewritten (see above).

### Rewired onto the restructured tree (clean merges, broken imports)

Git merged these without conflict but they still pointed at the pre-restructure paths:

- `core/entitlements/{billing,default-entitlement-service,entitlement-repository,limits,local-time,messages}.ts`
  — `../ports/common` → `../shared/common`, `../ports/clock` → `../shared/clock`.
- `infrastructure/database/repositories/drizzle-entitlement-repository.ts` —
  `../../../db/client` → `../client`, `../../../db/schema/entitlement` →
  `../schema/entitlement`, `../../../core/ports/common` → `../../../core/shared/common`.
- `test/support/in-memory-entitlement-repository.ts`, `test/unit/entitlements/harness.ts`,
  `test/integration/entitlements.test.ts` — `core/ports/common` → `core/shared/common`,
  `src/core/testing/test-clock` → `test/support/test-clock`, `src/db/client` →
  `src/infrastructure/database/client`.

### Open question 1 closed

M2 has merged, so `appUser` is exported from
`infrastructure/database/schema/identity.ts`. The `@ts-expect-error` and its
`TODO(M2 merge order)` block are deleted from the entitlement schema, exactly as that
TODO instructed.

### Still open after this merge

- **No migration for `entitlement` / `usage_counter`.** `migrations/0000_identity.sql`
  and its snapshot cover only M2's two tables. `npm run db:generate` will emit the M8
  tables as a new forward-only migration; deliberately left to its own commit rather
  than folded into a conflict resolution.
- **No composition-root wiring.** `src/index.ts` never constructs
  `DrizzleEntitlementRepository` / `createEntitlementService`. That is M7's wiring pass.
- **`gate()` vs CLAUDE.md's "Transactions" rule** (conflict 1 above) is unchanged and
  still needs a call before M3/M5 build against it.

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
   hook exists and is tested but has no caller. **Closed 13 September 2026** — see
   "M3/M6 — the correction feedback loop closes" below.
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
   `MerchantMappingRepository.remove` exists for M11's future `/categories`-adjacent
   command, nothing calls it yet.

### CLAUDE.md conventions pass — 2026-09-06 (follow-up commit on the same branch)

`CLAUDE.md` landed on `phase-1` after this PR was opened. It was merged in and its
conventions applied to M6/M9's own code. **No behaviour changed** — same routing,
same policy, same privacy rules, same 71 passing tests (1 skipped: the live-LLM eval).

**Moved / renamed**

- **`I`-prefix dropped everywhere** (CLAUDE.md: "Do not prefix interfaces with `I`").
  Where the interface name collided with the class, the implementation took the
  `Default` prefix CLAUDE.md prescribes:
  `IMessageNormalizer`→`MessageNormalizer` / `MessageNormalizer`→`DefaultMessageNormalizer`;
  `IMechanicalTransactionParser`→`MechanicalTransactionParser` /
  `MechanicalTransactionParser`→`DefaultMechanicalTransactionParser`;
  `ITransactionCandidateValidator`→`TransactionCandidateValidator` /
  `TransactionCandidateValidator`→`DefaultTransactionCandidateValidator`;
  `IMerchantMappingRepository`→`MerchantMappingRepository`;
  `IParseEventRepository`→`ParseEventRepository`. The redundant alias
  `ILlmTransactionParser = LlmParser` is gone — callers use `LlmParser` directly.
- **Concrete adapters moved to `src/infrastructure/`** (CLAUDE.md target structure):
  `DrizzleMerchantMappingRepository` →
  `infrastructure/database/repositories/drizzle-merchant-mapping-repository.ts`;
  `DrizzleParseEventRepository` →
  `infrastructure/database/repositories/drizzle-parse-event-repository.ts`;
  `OpenAiLlmTransactionParser` → `infrastructure/llm/openai-parser.ts`, renamed
  `OpenAiLlmParser` to match the port it implements. The ports themselves stay in
  `src/parsing/` next to the pipeline that consumes them, so `src/parsing/**` no
  longer imports Drizzle or the OpenAI SDK at all.
- **`LlmParser` port moved out of `core/ports/`** into `src/parsing/llm-parser.ts`
  (CLAUDE.md: "Do not use a global `core/ports` folder as a dumping ground"); the one
  `export * from './llm-parser'` line was dropped from `core/ports/index.ts` and
  nothing else in that barrel was touched.
- **`core/domain/money.ts` → `core/shared/money.ts`** with a `core/shared/index.ts`
  barrel — CLAUDE.md names it there explicitly. `core/domain/index.ts` lost only its
  `money` re-export.
- **`createParsingPipeline` moved to `infrastructure/create-parsing-pipeline.ts`.**
  It wires Drizzle + OpenAI into the pipeline, so it cannot live in `src/parsing/`
  without inverting CLAUDE.md's dependency direction. See conflict 3 below.
- **Test doubles moved out of `src/`**: `src/parsing/testing/index.ts` →
  `test/support/{fake-id,in-memory-merchant-mapping-repository,
  in-memory-parse-event-repository,recording-ledger-service,
  recording-allowance-service,scripted-llm-parser}.ts` (CLAUDE.md, "Testing":
  reusable test-only code belongs under `test/support/`, one double per file).
- **Two method renames** for CLAUDE.md's verb-first / business-terminology rule:
  `MessageNormalizer.merchantKey` → `deriveMerchantKey`, and
  `MerchantMappingRepository.touch` → `markUsed` (`touch` is database/unix jargon).

**Architectural conflicts flagged rather than resolved** — each would require editing
files owned by other, still-unbuilt modules, which CLAUDE.md's change discipline
("do not combine broad structural refactoring with an unrelated feature change")
rules out for this PR:

1. **`parsing/` is not a `core/<module>` in CLAUDE.md's target tree** — it and
   `observability/` are listed as bare top-level folders, while the module-ownership
   model in "Core modules" would make M6 a business capability like `core/ledger/`.
   The ports were therefore kept in `src/parsing/`, matching the tree literally. If
   the intent is that M6 becomes `core/parsing/` with `infrastructure/` adapters, that
   is a one-time rename worth doing across `parsing/` + `observability/` together,
   ideally when M7 wires them in.
2. **`core/ports/common.ts` and `core/ports/clock.ts` are not yet under
   `core/shared/`**, where CLAUDE.md's tree puts them. Every module — including the
   untouched Phase 2/3 stubs and the in-flight M8 PR — imports them from
   `core/ports/`, so moving them is a repo-wide refactor of its own. `core/shared/`
   currently holds only `money.ts` as a result. Likewise `core/domain/period.ts` and
   `core/domain/allowance.ts` still sit in the `core/domain` "dumping ground"
   CLAUDE.md warns against; they belong to M4/M5 and should move to
   `core/budgets/period.ts` / `core/allowance/daily-target.ts` when those land.
3. **The composition root should own the wiring.** CLAUDE.md says `src/index.ts`
   creates the database client, repositories and services. `createParsingPipeline`
   is that composition expressed as a factory, parked under `infrastructure/` because
   `src/index.ts` does not import `parsing/` until M7. When M7 wires the webhook, the
   factory's body should move into `src/index.ts` (or be called from it) and the
   `db`/`openAiApiKey` arguments should come from the Worker's bindings there.
4. **`src/db/` is not yet `infrastructure/database/`.** CLAUDE.md puts `client.ts`,
   `schema/` and `migrations/` under `infrastructure/database/`. `db/schema/` is one
   barrel shared by all eight modules (most still stubs) and one `drizzle.config.ts`
   path; moving only `merchant.ts`/`observability.ts` would fragment it, so nothing
   under `src/db/` was moved. This is the last structural gap and should be done as a
   single repo-wide move once the Phase 2 schema files are filled in.

**Verification:** `npm run typecheck` reports the same six errors as before this pass
and no new ones — two are the documented merge-order `TS2305`s on `appUser` (open
question 1), and four are pre-existing `node:fs`/`__dirname` errors in
`test/unit/logging-rules.test.ts` because `@types/node` is not a declared
devDependency (unrelated to M6; adding it is a `package.json` change nobody has
approved). `npm test` 71 passed / 1 skipped, `npm run test:integration` 4 passed
(PGlite, no `DATABASE_URL` needed). The live-LLM eval is still unmeasured — no
`OPENAI_API_KEY` in this environment.

## M6 ← phase-1 merge — 2026-09-08

**Branch:** `merge-m6-into-phase-1` (off `origin/worktree-agent-acb0c43fa675c8134`)

Both sides performed the CLAUDE.md structural refactor independently off `3584b3a`,
so git saw the same directories moved two different ways. Eight conflicts. Resolution
rule throughout: **phase-1 wins on file location, M6 wins on file content.**

### Conflicts and how each was resolved

1. `src/core/domain/index.ts` (modify/delete) — deleted. phase-1 dissolved
   `core/domain`; `period.ts` → `core/budgets/period.ts` and `allowance.ts` →
   `core/allowance/daily-target.ts`. The barrel was the last file left and its two
   `export *` targets no longer existed.
2. `src/core/shared/money.ts` (rename/delete) — M6's real implementation, at phase-1's
   path. phase-1 carried the M1 `not implemented` stubs; M6 filled them in and added
   `MoneyError`. Import repointed `../ports/common` → `./common`.
3. `src/parsing/llm-parser.ts` (rename/delete) — M6's version. phase-1 held M1's
   narrower port; M6's adds `LlmUsage`, which `parse_event` needs.
4. `src/parsing/index.ts` (content) — M6's full barrel over phase-1's placeholder.
5. `src/core/ports/index.ts` (content) — phase-1's version verbatim. What remains is
   `CategoryService` + `ReminderSelectionService`, the two contracts M2 proposed but
   does not own; M6's header described a `core/ports` that no longer exists.
6. `src/infrastructure/database/schema/merchant.ts` (file location) — M6 added
   `merchant.ts` into `src/db/schema/`, which phase-1 had renamed. Taken at the new
   path. This closes M6 open question 4: `src/db/` is now fully
   `infrastructure/database/`.
7. `test/unit/scaffold.test.ts` (content) — phase-1's import paths, minus the
   `toMinorUnits` guardrail. That test asserted `money.ts` throws `not implemented`;
   M6 implemented it, so the assertion is obsolete — coverage moved to
   `test/unit/money.test.ts`.
8. `docs/build-log.md` (content) — both sides kept, phase-1's sections first.

### Beyond the conflicts

- **Import repointing, 20 files.** M6 files that auto-merged cleanly still referenced
  directories phase-1 moved underneath them: `core/ports/{common,clock}` →
  `core/shared/`, `core/ports/ledger-service` → `core/ledger/`,
  `core/ports/daily-allowance-service` → `core/allowance/allowance-service`,
  `src/db/schema/` → `infrastructure/database/schema/`, and
  `src/core/testing/test-clock` → `test/support/test-clock`.
- **`test/unit/logging-rules.test.ts`.** M9's source scan looks up the schema file by
  literal relative path; repointed to
  `infrastructure/database/schema/observability.ts`. This was the one test the merge
  actually broke.
- **Migration `0002_dashing_tempest.sql` generated.** Purely additive: creates
  `parse_event` and `merchant_category_mapping` with their FKs to `app_user`. This
  closes M6 open question 1 — the `appUser` import in `observability.ts` was waiting
  on M2, which is now present, and the two documented `TS2305`s are gone.

**Verification:** `npm run typecheck` — 4 errors, all pre-existing `node:fs` /
`__dirname` / implicit-any in `test/unit/logging-rules.test.ts` because `@types/node`
is not a declared devDependency; no new errors and the two merge-order `TS2305`s
resolved. `npm test` 174 passed / 9 skipped. `npm run test:integration` 4 passed /
9 skipped — the 9 are M2's and M8's identity/entitlements suites, which need
`DATABASE_URL`; **they were not executed.** The live-LLM eval is still unmeasured (no
`OPENAI_API_KEY`).

## M9 — `logging-rules` source scan removed — 2026-09-08

**Branch:** `phase-1` · **Commit:** `8b07fb1`

`test/unit/logging-rules.test.ts` is gone. It was M6's automated take on M9 checklist
item 2 — a source scan asserting that only `observability/log.ts` and `index.ts` call
`console.*`, that no secret binding (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`INTERNAL_DISPATCH_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`) is interpolated into a
string or handed to the logger, and that `parse_event`'s column list is exactly the
ten in M9's SQL with only `route`/`model` typed `text`.

**Why it went.** It read the source tree with `node:fs`/`__dirname` while `@types/node`
is not a declared devDependency, which is where all four of the standing `typecheck`
errors recorded in the two M6 entries above came from. Its schema assertion also
restated what the committed migration `0002_dashing_tempest.sql` and
`test/integration/parse-event-fk.test.ts` already pin against a real database. What it
uniquely covered — the `console.*` and secret-interpolation scans — is lint work
wearing a test's clothes.

**What this changes.** Nothing about M9's rules. `parse_event` still holds no message
text and no log line may carry a token, secret, channel identifier, or raw message
content; those invariants are now upheld at review time rather than by a test.
`docs/M9-observability-privacy-retention.md` checklist item 2 records this, and notes
that re-automating it belongs in an ESLint `no-console` rule with an allowlist.
`src/observability/log.ts` and its unit test `test/unit/log.test.ts` — redaction,
truncation, flat-field formatting — are untouched.

**Supersedes:** the `logging-rules` references in the two M6 entries above. Those
entries stand as the record of what was true at the time; the four `node:fs` /
`__dirname` / implicit-any `typecheck` errors they document no longer exist.

**Verification:** `npm run typecheck` — clean, 0 errors. `npm test` 171 passed /
9 skipped across 16 files (2 skipped), down from 174/9 because the three removed
assertions were this file's. `npm run test:integration` 4 passed / 9 skipped — the 4
are `parse-event-fk.test.ts` on PGlite; the 9 are M2's and M8's identity/entitlements
suites, which need `DATABASE_URL` and **were not executed**.

## M3 + M4 — Categories & Ledger, Budgets & Periods — 2026-09-08

**Branch:** `phase-2`

Phase 2's coupled pair, built as one PR because the schema coupling runs both ways
(`transaction.budget_period_id` → `budget_period`, `budget.category_id` → `category`)
and the master plan §4 says to treat them as one workstream. One migration,
`0003_flashy_true_believers.sql`, carries all four tables.

### Decisions taken

1. **`transaction.category_name_snapshot` — skipped.** M3's plan proposed it and
   explicitly said "confirm before shipping". Confirmed skipped: it exists only to
   serve the deferred *real* category-removal feature, and a forward-only migration
   that adds it now would be a column nothing reads. It arrives with that feature.
2. **Atomicity across the M3/M4 boundary.** M3's checklist requires period resolution
   and the ledger insert in one database transaction, while CLAUDE.md forbids passing
   a Drizzle transaction handle across a core-module boundary. Resolved by reusing the
   pattern M8 already established: both repositories are generic over an *executor*
   type `X`, and M4 exposes `PeriodMaterialiser<X>.ensurePeriodForCategory(…, executor)`.
   M3 opens the transaction, hands M4 the executor, and neither module names Drizzle.
   In production `X` is the Drizzle transaction handle; in unit tests it is a shared
   in-memory store whose `transaction()` snapshots and rolls back every table, which
   is what makes the "no orphaned period" test real rather than decorative.
   This is the concrete answer to CLAUDE.md's "should be considered when finalising
   M8's `gate()` design" note — `gate` stayed off the public `EntitlementService`
   port, and M3 declares the narrow `CategoryCapacityGate<X>` shape it needs instead.
3. **`BudgetService.currentBudgets(userId, localDate)` added** for `/budget` with no
   arguments (M4 checklist step 7). Returns the standing rule, the derived period and
   the current snapshot cap — `null` when nothing has been materialised, which the
   read treats as "the cap applies, nothing spent", never an error.
4. **`CategoryService` claimed by M3.** It was parked in the temporary `core/ports/`
   holding pen because M2 proposed it and M3 was a stub; it now lives in
   `core/ledger/category-service.ts`. Added `findByName` (name→category resolution
   through M3's own normalization instead of each caller re-implementing it),
   `countActive` (the number M8's capacity check compares against the limit) and
   `reactivate` (M8 already gated a `reactivate_category` action with nothing to call
   it). The four original methods are unchanged, so M2's onboarding still compiles as
   written. `core/ports/` is now down to M5's `ReminderSelectionService`.
5. **`exportCsv` refuses with `NOT_YET_AVAILABLE`.** Deferred (round 5, Story 7); the
   signature stays so M7 has something to stub `/export` against.

### Shared code that moved (small, and each anticipated by the file it came from)

- **`core/shared/local-date.ts`** — `localDateAt` plus the calendar arithmetic M3, M4,
  M2 and M8 all need. M2's `timezones.ts` had flagged exactly this ("if M3/M4/M5 end
  up needing `localDateAt` … it is a candidate for `core/shared`"). M2's `localDateAt`
  / `isLocalDate` and M8's `localDateOf` / `addLocalDays` now delegate to it under
  their existing names, so no public surface changed and no call site moved.
- **`core/shared/errors.ts`** — `RefusalError`, moved from `core/identity/errors.ts`,
  which said it belonged in `core/shared` "once M3/M8 throw the same class".
  `core/identity/errors.ts` re-exports it.
- **`UserSettings.accountCreatedOn`** — additive. M3 enforces the backdating floor
  itself rather than trusting its caller, and M6's `UserParseContext` already expected
  M7 to source `accountCreatedOn` from `getSettings`. Derived from `created_at` in the
  user's own timezone; absent from `UserSettingsPatch` because it is not settable.
- **`normaliseName`** in M2's onboarding now delegates to M3's `normalizeCategoryName`
  — one definition of what makes two category names the same name.

### Assumptions worth flagging

- **`setCap` does not verify the category exists or is unarchived.** The caller
  resolves a name through M3 first and the FK is the backstop; M4 reading M3's table
  to re-check would violate master plan §2 rule 2. If `/budget` on an archived
  category turns out to need a friendlier refusal, that check belongs in M7's command
  handler or in a small addition to M3's contract, not in M4.
- **M3 re-derives `occurred_on` from `occurred_at` + timezone** and ignores the
  candidate's own copy. M6 sets `occurredAt` to local noon of the date it resolved, so
  the two always agree today; if they ever stop agreeing, the timezone is authority.
- **M5's notifications are optional dependencies** (`AllowanceNotifier`), omitted in
  wiring until Phase 3. `ledgerChanged` failures are swallowed on purpose — the ledger
  is the system of record and a reminder is a downstream effect.
- **`src/index.ts` is still not the composition root.** M3/M4 add no routes, and the
  existing deviation (`createParsingPipeline` parked under `infrastructure/`) is
  already logged as M7's to fix. The intended wiring is written out in each module's
  `index.ts` header, and `test/integration/ledger-budgets.test.ts` composes the real
  services over the real repositories, so it is exercised rather than merely described.
- **`src/parsing/dates.ts` still keeps M6's own `localDateAt` / `addDays` /
  `compareLocalDates`.** Folding those into `core/shared/local-date.ts` is a sensible
  follow-up but it is M6's code, and CLAUDE.md says not to combine a rename sweep with
  a feature change.

### Verification

`npm run typecheck` — clean, 0 errors. `npm test` — **293 passed / 9 skipped** across
22 files (up from 171/9): 4 new suites (`test/unit/budgets/period.test.ts`,
`test/unit/budgets/default-budget-service.test.ts`, `test/unit/ledger/{transaction-validation,
category-service,default-ledger-service}.test.ts`) plus
`test/integration/ledger-budgets.test.ts`.

`npm run test:integration` — 20 passed / 9 skipped at the time of the commit. The 20
are the PGlite suites (`parse-event-fk`, `ledger-budgets`), which need no database;
the 9 skipped were M2's and M8's suites, which need `DATABASE_URL` and were not
executed. **Superseded — see "first real-database run" below.**

`npm run db:generate` — `0003_flashy_true_believers.sql` generated, inspected and
committed with its snapshot.

`test/unit/scaffold.test.ts` no longer asserts that `periodFor` throws "not
implemented" — it landed. `computeDailyTarget` (M5) is the last stub that file guards.

One production behaviour changed while making the integration suite run on PGlite:
`DrizzleLedgerRepository` reads the tripped constraint from **both**
`constraint_name` (`postgres.js`, production over Hyperdrive) and `constraint`
(PGlite). Reading only one meant a duplicate category name surfaced as a raw Postgres
error rather than the typed `DuplicateCategoryNameError` under whichever driver was
not covered.

### First real-database run — 2026-09-11

Ricky supplied `DATABASE_URL`, so M2's and M8's suites executed for the first time in
this repo's history (M8's own header had said it was waiting on CI). **29 integration
tests passed, 0 skipped; 302 in the full suite, 0 skipped.** Two things came out of it.

1. **`test/integration/identity.test.ts` was asserting the old `UserSettings` shape.**
   Adding `accountCreatedOn` meant its two `toEqual` round-trip assertions failed. The
   two *unit* tests with the same assertion were updated in the original commit; this
   one was invisible because it skips without `DATABASE_URL`. Now updated, with the
   derivation spelled out — the clock is fixed at `2026-09-06T00:00:00Z`, which is
   09:30 in Adelaide, so `accountCreatedOn` is `2026-09-06`.

   The general lesson for anyone widening a shared contract: a `DATABASE_URL`-gated
   suite asserting on a full object with `toEqual` will not tell you it is stale.

2. **M8's concurrency test timed out at the 5s default — not a defect, and not caused
   by M3/M4.** `admits once per message_id under concurrent redelivery` issues 14
   `admitMessage` calls that all contend on the same per-user advisory lock, so they
   serialise by design, each holding the lock for a transaction's worth of round trips
   to Neon in Sydney. Warm, it lands at ~3.5s; the failing run also paid Neon's compute
   wake-up on the session's first query. Every other integration test is under 1.4s.
   Fixed with a 30s **per-test** timeout and a comment explaining why — raising the
   global timeout would hide a genuine hang in the sub-second tests around it.

   Ruled out as an M3/M4 regression: the only M3/M4 change under that test is
   `core/entitlements/local-time.ts` delegating to `core/shared/local-date.ts`, which is
   pure in-process `Intl` work, and the same test passed at the default 5s timeout on
   the very next run with that code in place.

---

## M5 — Daily Allowance & Scheduler — 2026-09-11

**Branch:** `phase-3`

Phase 3's single module. One migration, `0004_faithful_baron_zemo.sql`, carries
`daily_allowance_send` plus one column on M3's `category`. `core/ports/` is now gone
entirely — M5 claimed its last resident.

### Decisions taken (Ricky, 11 Sep)

1. **The reminder flag lives on `category.reminder_enabled`, and M5 writes it directly.**
   Ricky's call: "keep it on the category table, it's only 1 column, and it's genuinely
   related to category." This is a **deliberate, narrow exception to CLAUDE.md's "one
   module owns each table"**, logged here rather than resolved silently. M5 touches
   exactly that column and never the rest of the row; M3 clears it when archiving via
   `AllowanceNotifier.categoryArchived` rather than writing it itself. The alternative
   considered was two pass-through methods on M3's `CategoryService`. Closes M2's open
   question 2 and M8's open question 3.
2. **Delivery is deferred to Phase 4.** No `MessageSender` implementation, no
   `/internal/send-allowance` route, no composition root, no `scheduled` body. M5 is
   built against the ports and fully tested; nothing reaches Telegram yet. The four
   items M7 inherits are written out in `docs/M7-telegram-gateway.md`, "Handed over
   from M5 (Phase 3)".
3. **`LedgerService.spentOn` gained an optional `categoryId`.** `AllowanceView.spentToday`
   is per category; `spentOn` was user-wide. Additive, so existing callers are
   unaffected, and it keeps every ledger read behind M3's `status = 'confirmed'` filter
   instead of M5 re-implementing it against `transaction`. The alternative — an M5-owned
   read of M3's table — was rejected for the same reason M3/M4 refined their own ports.
   `transaction_category_date` already covers the narrowed query, so no new index.
4. **A reminder requires an active budget on the category.** `enable` refuses `NO_BUDGET`
   otherwise — a reminder's whole content is "you can spend $X today", which needs a cap
   to divide. This is also what lets `daily_allowance_send.budget_period_id` stay
   `not null`: a reminder-eligible category always has a period to materialise.
5. **`AllowanceNotifier.ledgerChanged` is a documented no-op.** `available_today` is
   derived on every read (`dailyTarget - spentToday`) and never stored — only
   `daily_target` is persisted, and it is frozen for the date by design — so there is no
   cached value to invalidate. M6's `pipeline.ts` `availableToday` call is the single
   real trigger; it needs the return value for the confirmation reply anyway. This was
   two DB round trips per logged expense doing one job. The port stays on M3's contract
   so no shipped M3 code moved. **Closes M6's open question 4.**

### Calls I made, flagged rather than assumed

- **`findDue`/`computeAndSend` are now per-user, not per-`(user, category)`.** The
  Phase 0 stub predated the 5 Sep bundling decision and returned pairs, which would have
  to be de-duplicated back to a user before anything could be sent; M5's own cron
  pseudo-code says "for each due *user*". Refined under M1's "the owning module may
  refine its committed port" licence, the same one M3/M4 used for `currentBudgets`.
  `availableToday` is unchanged. `AllowanceView` also gained `categoryName`, so the
  renderer does not need a second lookup per line.
- **The due window is `[reminder, reminder + 60min)`, not a strict 15-minute tick.**
  M5's plan describes exact equality against `reminder_local_time`. Cloudflare cron
  fires "approximately" on schedule and ticks get dropped, and there is no staging
  Worker to notice that on (§5.7). 60 minutes absorbs drift, gives the 3-attempt retry
  budget four ticks to play out, and still never delivers a morning reminder at 3pm.
  Widening it cannot cause a double send — once-only comes from the unique index plus
  the terminal-status filter, not from the window.
- **`computeAndSend` is idempotent per local date at the service level**, not just via
  the due scan. It bundles only rows still `pending`; a duplicated subrequest or a
  double-fired tick sends nothing. Worth stating because the first draft relied on the
  due scan alone, and a test written to assert once-only found it.

### Built

- **`daily_allowance_send`** exactly as M5's plan specifies, plus a
  `(user_id, local_date)` index for the per-user read `/today` and the bundle both make.
  `unique (user_id, category_id, local_date)` is the double-send guard;
  `delivery_status` defaults to `not_applicable` so a budgeted-but-unreminded category's
  row never enters the `pending` retry index.
- **`computeDailyTarget`** (`core/allowance/daily-target.ts`) — the last Phase 0 stub.
  Clamps negatives to `0n` *before* dividing, which is what makes BigInt's
  truncate-toward-zero agree with the doc's `floor`; throws on `daysLeft < 1` rather
  than dividing by zero.
- **`DefaultAllowanceService`** — `availableToday` (compute-and-persist on demand, so
  the morning message and the day's first `/today` always agree), `computeAndSend` (the
  four-step bundle: gather → revalidate fresh → skip-if-empty → one send, one shared
  outcome), `findDue`, and both `AllowanceNotifier` methods.
- **`DefaultReminderSelectionService`** — implements the contract M2's onboarding step 5
  has been calling since Phase 1. Idempotent `enable` checked *before* the gate, so a
  Free user re-confirming their existing pick is not told they are over the limit.
- **`DrizzleAllowanceRepository`** — covers both `daily_allowance_send` and
  `category.reminder_enabled`. `findDueUsers` does per-user timezone maths in SQL
  (`at time zone` on each user's own zone), so the cron stays one indexed scan.
- **`createReminderCapacityReader`** — the `countReminderCategories` half of M8's
  `CapacityReader`, which has had no data source since Phase 1.
- **Message renderers** — bundled and single-category, per the plan's "Message shape".
  Overspent categories move to their own sentence rather than reading as "spend -$4".

### Assumptions worth flagging

- **`findDueUsers` also requires an active `channel_connection`, `status = 'active'` and
  `onboarding_step = 'done'`.** Not in M5's plan; waking a user we cannot deliver to
  would burn a subrequest and mark rows against a send that never happened.
- **The due query guards `timezone <> ''`.** M2's pre-onboarding sentinel is not a valid
  zone and `at time zone ''` raises — without the guard, one unfinished signup breaks
  the query for *every* user. There is a test for exactly this.
- **A `pending` row keeps a user due**; that is how a retryable failure gets its next
  attempt inside the window. `sent`/`skipped`/`failed` are terminal.
- **The in-memory `findDueUsers` throws rather than imitating the SQL.** Its whole
  substance is Postgres timezone arithmetic, and a hand-rolled TypeScript version would
  pass while the real query was wrong. `test/integration/allowance.test.ts` covers it
  against real Postgres instead, including Sydney/Adelaide/Perth and a DST transition.
- **`escapeCategoryName` duplicates M2's private `escapeForPrompt`.** Deliberate:
  CLAUDE.md says not to fold a rename sweep into a feature change. Worth unifying into
  `core/shared` when M7 lands and there are three copies.
- **`formatMoney` drops a `.00` fraction** (`$18`, not `$18.00`) to match the plan's own
  example wording. Non-zero fractions are always shown in full.

### Verification

`npm run typecheck` — clean, 0 errors. `npm test` — **417 passed / 0 skipped** across 28
files (up from 302/0): 4 new unit suites under `test/unit/allowance/` (85 tests),
`test/integration/allowance.test.ts` (32), and one added to M3's suite covering the
narrowed `spentOn` against real SQL.

`npm run test:integration` — 62 passed / 0 skipped, including M2's and M8's Neon suites.

`npm run db:generate` — `0004_faithful_baron_zemo.sql` generated, inspected and
committed with its snapshot. The `category` change is a `not null default false` column
add, so it is safe on a populated table.

**`test/unit/scaffold.test.ts` is retired**, as its own header said it would be:
`computeDailyTarget` was the last Phase 0 stub it guarded.

`test/integration/ledger-budgets.test.ts` now also executes `0004`, because M3's own
category reads select `reminder_enabled`. That suite builds its schema from the
committed migration files rather than a hand-copied DDL block, which is precisely why
the omission surfaced as a failing test rather than as production drift.

### Open questions

1. **Nothing has been delivered to Telegram.** The first real 07:00 send happens in
   Phase 4, against production, with no staging Worker to rehearse on (§5.7) — the same
   risk M1 flagged for the hello-world cron, now with a user-visible message attached.
   Worth a manual `/internal/send-allowance` call against a real chat before trusting
   the cron.
2. **`DUE_WINDOW_MINUTES = 60` is my number, not Ricky's.** If a reminder arriving as
   late as 07:59 after a missed tick reads as wrong, drop it to 30 — the constant is in
   `core/allowance/default-allowance-service.ts` and nothing else depends on its value.
3. **M4's `deactivate` does not notify M5.** Deactivating a budget leaves
   `reminder_enabled` set; dispatch revalidation drops the category from the bundle, so
   nothing wrong is sent, but `/remind` will list a category that silently never fires.
   Clearing the flag on deactivate would need a second `AllowanceNotifier` method and a
   change to M4 — out of scope for this PR, worth deciding when M7 wires `/remind`.
4. **`reminder_local_time` is read but never written.** M5 honours whatever the column
   says (M2's open question 6), and there is an integration test proving a 09:00 user is
   woken at 09:00. Nothing exposes a way to change it, which is correct for this pass.

## M7 stage 4A — Outbound delivery & composition root — 2026-09-11

Phase 4's first stage. M5 landed complete but deliberately deferred delivery to this
module; these are the four handover items from `docs/M7-telegram-gateway.md`
("Handed over from M5"). Until this stage, the 07:00 reminder computed correctly and
sent nothing.

Scope is outbound only. The webhook, routing and commands are stages 4B–4D; see
`docs/M7-phase-4-plan.md`.

### Built

- **`channels/telegram/telegram-api-client.ts`** — the only code in the repo that calls
  the Telegram Bot API. Returns a typed `TelegramCallOutcome` instead of throwing,
  because the entire job of this layer is that every failure is classifiable; an
  exception escaping into `ctx.waitUntil` would turn a rate-limit into an unhandled
  rejection. Injectable `fetch`, mirroring `OpenAiLlmParser`'s seam.
- **`channels/telegram/telegram-message-sender.ts`** — `MessageSender` over that client.
  The whole substance is M7's classification matrix: 403 → `skipped/blocked`,
  429 → `retryable` + `retryAfterSeconds`, 5xx/network → `retryable`, 400 → `permanent`.
- **`src/index.ts` rewritten as the composition root** — `createDatabase`, five Drizzle
  repositories, every core service, wired per each module's own `index.ts` header.
  `createApp(makeServices)` and `runScheduled(controller, env, services, fetch)` take
  their collaborators as parameters so the real routing and guards are testable without
  a database. 4B's webhook will use the same seam.
- **`POST /internal/send-allowance`** — `X-Internal-Dispatch-Secret` compared in
  constant time against `INTERNAL_DISPATCH_SECRET`, then `computeAndSend(userId)`.
  Returns M5's `SendOutcome` verbatim.
- **`scheduled`** — M1's hello-world replaced with
  `findDue(controller.scheduledTime, 50)` → one subrequest per due user.
- **`wrangler.toml`** — new `[vars] WORKER_BASE_URL`.

### Assumed

- **Plain text, no `parse_mode`, bot-wide.** `core/allowance/messages.ts` *strips*
  markup characters rather than escaping them and its header says "M7 escapes nothing
  further" — which only holds if Telegram is never asked to interpret markup. This also
  settles M7's open decision 3 (`/stats` plain text) in the direction M11 recommends.
  4B's `render.ts` inherits it.
- **`WORKER_BASE_URL` is a new binding, not in any plan.** A `scheduled` invocation has
  no inbound request to derive an origin from, and the fan-out has to be a *real*
  subrequest — that is what gives each send its own 10ms CPU budget. Committed with a
  placeholder; it must be set to the deployed origin before the first tick matters.
- **The sender never deactivates a connection.** M7's page says "403 → deactivate and
  report skipped", but `DefaultAllowanceService.computeAndSend` already calls
  `deactivateConnection` on a `skipped` result. The sender only classifies; the caller
  decides. Wiring it in both places would be a double call. 4B's inbound reply path does
  its own deactivation.
- **401 and 404 are classified `permanent`**, which M7's page does not name. Both are
  misconfigurations a retry cannot fix; `retryable` would re-attempt every 15 minutes
  forever. They fail loudly instead.
- **The two dependency cycles are broken with closures, not partially-built objects** —
  M2↔M3 (`history` / `settingsOf`) and M5↔M3 (`spendInPeriod` / `AllowanceNotifier`),
  the same way M5's own test harness breaks them. The explicit type annotations on
  `ledger` and `allowance` are load-bearing: without them TypeScript cannot infer
  either type (TS7022/TS7023).
- **Services are built per invocation**, not at module scope —
  `env.HYPERDRIVE.connectionString` is only valid inside a request or cron context and
  an isolate outlives any one of them.

### Verification

`npm run typecheck` — clean, 0 errors. `npm test` — **440 passed / 0 skipped** across 30
files, up from 417/0: 23 new tests in two suites under `test/unit/telegram/`
(`telegram-message-sender.test.ts`, `composition-root.test.ts`) plus
`test/support/fake-telegram-api.ts`. No existing test changed.

`npm run test:integration` — 62 passed / 0 skipped against the real Neon branch,
identical to M5's baseline. No schema change in this stage.

`npm run db:generate` — not run; this stage adds no table. `inbound_update` and
`pending_prompt` arrive in 4B as migration `0005`.

**Not verified against a real Telegram chat.** Nothing here has been deployed, so the
classification matrix is proven against a fake `fetch` only. The first real send is
stage 4E's manual `POST /internal/send-allowance` — M5's own open question 1, and with
production-only (§5.7) there is no staging Worker to rehearse on.

### Open questions

1. **`WORKER_BASE_URL` is a placeholder.** The cron fan-out will post to
   `https://budge-bot-api.workers.dev` until it is set to the real origin. With
   `workers_dev = false` that host does not resolve, so the fan-out would fail every
   tick — silently, since M5 leaves rows `pending` and simply retries. Set it at 4E.
2. **Nothing enforces the 4096-character cap yet.** M5's bundled reminder is short
   enough in practice, and `paginate` belongs with the rest of the rendering in 4B — but
   until then an unusually large bundle would be classified `permanent` (400) rather
   than split.
3. **`/internal/send-allowance` is reachable from the public internet**, protected only
   by the shared secret. That is the design in M7's handover, and the constant-time
   compare is implemented, but it is worth revisiting whether the route should also
   require an internal-origin check once there is a custom domain.

## M7 stage 4B — Webhook spine, dedup & routing — 2026-09-11

Phase 4's second stage, and the first time an inbound Telegram message reaches a
reply. 4A gave the bot a voice; this gives it ears.

Scope is the spine: the webhook, dedup, the update parser, the dispatcher, the command
catalogue and rendering. The nine product commands are 4C and the free-text path into
M6 is 4D; see `docs/M7-phase-4-plan.md`.

### Built

- **`channels/telegram/webhook-handler.ts`** — `X-Telegram-Bot-Api-Secret-Token`
  compared in constant time **before the body is read**, then `claimUpdate`, then 200,
  then `ctx.waitUntil`. Malformed JSON and unrecognisable updates are answered 200 as
  well: anything else invites Telegram to retry them forever.
- **`channels/telegram/update-parser.ts`** — raw `Update` JSON → a discriminated
  `TelegramEvent`, via Zod. The private-chat check lives here, not in the dispatcher,
  so no downstream branch can forget it. Nothing throws; an unrecognised update is
  `unsupported`.
- **`channels/telegram/dispatcher.ts`** — M11's routing order, one reply per branch.
  A thrown `RefusalError`/`EntitlementRefusal` renders as its own copy; anything else
  is one apology and one log line carrying only the update id.
- **`channels/telegram/command-router.ts` + `commands/`** — the catalogue that is
  simultaneously the router, `/help`'s source and (at 4E) `setMyCommands`' input, with
  a tokeniser that handles `/budget "Eating Out" 300`. Ships `/help`, `/cancel`,
  `/export` and the billing quartet.
- **`channels/telegram/render.ts`** — plain text throughout, one line of copy per
  `RefusalCode` behind a `satisfies Record<RefusalCode, string>`, onboarding keyboards
  (≤4 options) or numbered lists (>4), and `paginate` at 4096.
- **`channels/telegram/gateway-repository.ts` + `DrizzleGatewayRepository`** —
  `claimUpdate`, `findPendingPrompt`, `setPendingPrompt`, `clearPendingPrompt`.
- **`schema/platform.ts`** — `inbound_update` and `pending_prompt`, migration **0005**.
- **`core/shared/text.ts`** — `sanitiseDisplayText`, the hoist M5's own entry deferred
  to "when M7 lands and there are three copies"; M2 and M5 delegate to it under their
  existing names, in a separate commit.
- **`src/index.ts`** — `POST /telegram/webhook` delegating to the handler, and
  `SUPPORT_CONTACT` on `Env`.

### Assumed

- **The daily message cap is waived until onboarding completes; fair use never is.**
  Free admits 5 messages per user-local day and M8 counts a callback tap as an admitted
  event, so `/start` plus the five onboarding answers is six: a new Free user was
  refused `DAILY_MESSAGE_LIMIT` before finishing sign-up, and M7's own DoD ("walk
  `/start` end-to-end in under 5 minutes") could never have passed. **Ricky's ruling,
  11 Sep 2026.** Implemented as an additive M8 change rather than M7 skipping the gate:
  `admitMessage` takes an optional `AdmitMessageOptions`, and `usage_counter` grows
  `counts_toward_daily` (migration **0006**) so a waived message still fills the
  rolling window but does not eat the day's quota once the account is live. This is a
  deliberate deviation from M8's "`admitMessage` is the very first gate after user
  resolution" — the gate still runs, it just enforces one limit instead of two.
- **`/start` stays in 4C, so 4B's unresolved-user branch has nowhere to send people.**
  A stranger gets `ONBOARDING_REQUIRED` ("Send /start first") and `/start` is not
  registered until 4C, where the copy becomes true. Ricky's call, taken knowingly.
- **Pre-registration senders are not rate-limited.** `usage_counter` is keyed on a
  `user_id` that does not exist until `/start` creates it, so there is no key to limit
  a stranger by. `inbound_update` still prevents a Telegram redelivery being answered
  twice, but nothing caps a stream of distinct messages from an unregistered sender.
  Closing it means registering on first contact, which is `/start`'s job — see open
  question 1.
- **`SUPPORT_CONTACT` is a Wrangler secret, not a `[vars]` entry.** The plan put
  Ricky's Gmail in `wrangler.toml`; this repository is public. A secret keeps the
  address out of the repo at no cost (a dashboard-set plain var would be wiped by the
  next `wrangler deploy`; a secret survives). Ricky was fine with either.
- **An edited message is treated as a fresh message.** M11 has no edit semantics, and
  silently ignoring an edit leaves the user's correction unanswered.
- **A callback query with no `data` is `unsupported`** — it is not a button we built.
- **Unrouted callback prefixes (`pc:`, `map:`, `cat:`, `hist:`) answer `STALE_ACTION`**
  until 4C/4D register them. A press that does nothing is worse than one that says so.
- **The reply's `ChannelConnection` is built from the update itself**, not read back
  from M2: this is a reply to a message that just arrived, so a lookup could only
  return the same `chat_id`. Every `MessageSender` reads `chatId` and nothing else.

### Fixed in passing

- **`sanitiseDisplayText` now strips bidi controls.** Both original copies stripped
  `\p{Cc}` only, and the bidi overrides (U+202A–U+202E, U+2066–U+2069, U+200E/F) are
  `\p{Cf}` — so a category name containing U+202E could render the rest of the line
  right-to-left in the user's chat and make a message appear to say something it does
  not. Caught by `render.test.ts`. Listed explicitly rather than stripping all of
  `\p{Cf}`, which would take the zero-width joiner and break emoji in category names.
  The fix reaches M2 and M5 through the hoist.

### Verification

`npm run typecheck` — clean, 0 errors; the `RefusalCode` render table is enforced here.

`npm test` — **552 passed / 9 skipped** across 38 files, up from 440: 96 new tests in
eight suites (`test/unit/telegram/{dispatcher,webhook-handler,webhook-route,update-parser,command-router,render}.test.ts`,
`test/unit/entitlements/onboarding-waiver.test.ts`, `test/integration/gateway.test.ts`)
plus `test/support/in-memory-gateway-repository.ts` and `test/unit/telegram/harness.ts`.
The 9 skipped are the Neon-gated integration suites, skipped here because a fresh
worktree has no `.env`. **No existing test was changed** — M2's and M5's suites are the
regression guard for the strip-function hoist, and they pass untouched.

`npm run db:generate` — 0005 (`inbound_update`, `pending_prompt`) and 0006
(`usage_counter.counts_toward_daily`) generated separately so M7's tables and the M8
column stay legible in history. Both inspected and committed with their snapshots.

`npm run test:integration` — **72 passed / 0 failed** against the real Neon branch,
across all six integration files. 0005 and 0006 were applied to the branch by Ricky
(`npm run db:migrate`) after the first run of this suite reported the expected
`column usage_counter.counts_toward_daily does not exist`; re-run clean afterwards.

**Nothing here has been deployed or seen a real Telegram message.** The webhook is
proven against hand-built `Request`s and a fake `ExecutionContext`; `setWebhook` is
stage 4E.

### Open questions

1. **Should the bot register a user on first contact?** It would close the
   pre-registration rate-limit gap (above) and make "any message starts onboarding"
   true rather than aspirational — but it creates an `app_user` row for anyone who
   messages the bot, and it is `/start`'s job. Decide it in 4C, when `/start` lands.
2. **`counts_toward_daily` has no backfill concern but does have a retention one.**
   Every waived onboarding row lives in `usage_counter` forever, same as any other.
   M9's retention pass should treat them identically; nothing here depends on them
   after the day they were written.
3. **The dispatcher's `freeText` port is unimplemented**, so an onboarded user's free
   text and any open `pending_prompt` answer both get an honest "not yet" reply.
   `pending_prompt` is therefore written by nothing until 4D — the table, its
   repository and `/cancel` are all in place and tested ahead of the writer.

## M7 stage 4C — The command catalogue — 2026-09-11

Phase 4's third stage, and the first time the bot can do the product's job. 4A gave it
a voice, 4B gave it ears; this gives it something to say back.

The nine product commands — `/start`, `/today`, `/budget`, `/stats`, `/history`,
`/delete`, `/categories`, `/remind`, `/settings` — one file each under
`channels/telegram/commands/`, each calling the owning core service and rendering what
comes back. The catalogue is now all sixteen commands Ricky approved. Free text into M6
is 4D; go-live is 4E.

### Built

- **`commands/start.ts`** — `identity.register` → `onboarding.start`. The only handler
  that creates anything, and the only one with `requiresAccount: false` that does.
  `register` runs unconditionally rather than only for an unknown sender: it is
  idempotent by contract, and it is also the only thing that re-activates a
  `channel_connection` the 403 path switched off. Someone who blocked the bot and
  changed their mind types `/start`, and that line is why it works.
- **`commands/today.ts`** — `allowance.availableToday`, rendered with M5's own
  `renderAllowanceLine`, so `/today` and the 07:00 reminder cannot word the same figure
  differently.
- **`commands/budget.ts`** — `currentBudgets` / `setCap`. The amount converts through
  M3's `toMinorUnits` **before** any write, which is what makes M11's "no partial write
  on bad input" true rather than aspirational.
- **`commands/stats.ts`** — `currentBudgets` + `ensurePeriod` + `spendInPeriod`.
- **`commands/history.ts`** — the paginated read, forward-only, plus `historyPage`,
  which both the command and the `hist:` callback go through so a continued page cannot
  render differently from the page it continues.
- **`commands/delete.ts`** — `deleteLast`, then `availableToday` **directly**.
  `AllowanceNotifier.ledgerChanged` is a documented no-op, because `available_today` is
  derived rather than stored; a handler relying on it would print the pre-delete number.
- **`commands/categories.ts`**, **`commands/remind.ts`**, **`commands/settings.ts`** —
  argument-driven; see the decisions below.
- **`commands/context.ts`** — the three lookups nearly every handler starts with. The
  name-to-category one goes through M3's `findByName`, which owns normalisation; M7
  never lowercases or trims a category name itself, or `/budget food` would stop finding
  "Food" the moment M3's rule changed.
- **`render.ts`** — `renderSettings`, `renderCategoryList`, `renderBudgetList`,
  `renderStats`, `renderHistoryPage`, `historyCallbackData`/`parseHistoryCallbackData`,
  `formatShortDate`. Plain text throughout, as bot-wide.
- **The command seam widened** — `CommandServices` now carries every core contract a
  handler may call and nothing else; `CommandContext` gained `sender` because `/start`
  has to register someone and `register` needs an `externalId` and `chatId` that a
  `userId` cannot supply. A handler needing something off that list is the signal the
  behaviour belongs in a core module.
- **`test/support/domain-services.ts`** — M3/M4/M5 wired for real over one in-memory
  store, the way the composition root wires them. M5's own sender is kept separate from
  the dispatcher's, so a test asserting "the bot replied once" never counts a scheduled
  reminder.

### Decisions taken (Ricky, 11 Sep)

- **`/categories` and `/remind` take arguments, not inline keyboards.** The stage plan
  sketched `cat:<action>:<id>` buttons. A keyboard rename needs the new name typed back,
  and the only place M7 can hold "I am waiting for a name" is `pending_prompt`, whose
  `kind` is `'confirm' | 'clarify'` — a third kind means another migration inside a
  stage that already adds nine handlers. Quoting a multi-word name is M11's shared
  contract anyway, and the tokeniser already does it. Consequence: **`hist:` is the only
  callback prefix 4C introduces.**
- **`/settings` is view-only this pass.** M2 already makes timezone immutable, refuses a
  currency change once the account has any transaction, and fixes the reminder at 07:00,
  leaving the budget anchor date as the only genuinely editable field. Shipping the read
  and deferring the write beat building an edit path for one field. Enforced by the
  compiler, not by memory: `CommandServices.identity` is `Pick<IdentityService,
  'getSettings' | 'register'>`, so a handler that tried to write would not compile.
  Propagated to `docs/M11-telegram-commands-contracts.md` and
  `docs/M2-identity-accounts.md`.
- **`/history` pages forward only.** `Page<T>` is `{ items, nextCursor }` — no backward
  cursor. A "previous" button would mean changing M3's public contract *and* its Drizzle
  repository from inside an M7 stage, which is the mixing CLAUDE.md warns against.
- **Registration stays `/start`-only** — closing 4B's open question 1. A stranger's
  non-`/start` message keeps getting `ONBOARDING_REQUIRED`. The pre-registration
  rate-limit gap 4B logged stays open knowingly: closing it means an `app_user` row for
  every wrong number and spam bot that ever messages the bot.

### Assumed

- **`/stats` materialises a period row on a read path.** `spendInPeriod` needs a
  `budget_period_id` and `currentBudgets` returns a `Period` without one, so the id has
  to come from `ensurePeriod` — an upsert. This is the existing house pattern rather
  than a new liberty: M5's `availableToday` calls `ensurePeriod` too, so `/today` has
  always done it. M4 deliberately has no cron opening periods in advance, so
  materialising on first read is how a period row comes to exist at all. The upsert is
  race-safe on `(budget_id, period_key)`, and a cycle with nothing logged still reads as
  "cap applies, nothing spent" — never an error.
- **`/history`'s page size is 10, and the More button is dropped rather than truncated**
  when a cursor would exceed Telegram's 64-byte `callback_data` cap. A page with no
  button is recoverable; a 400 from the Bot API is a reply the user never sees.
- **An archived category still names its old transactions.** `/history` lists with
  `includeArchived: true` — a row rendering as "uncategorised" purely because the
  category was later archived would be a lie about the user's own history.
- **`/settings` ignores arguments rather than refusing them.** `/settings currency USD`
  simply shows the settings. Refusing would imply the syntax nearly works.
- **A budget start date mistyped during onboarding cannot be corrected** without
  deleting the account. Direct consequence of the view-only ruling, recorded so it is
  not rediscovered as a bug. First thing to revisit when settings editing returns.

### Fixed in passing

- **Removed a branch in `renderBudgetList` that could never run.** M4's page says
  `/budget` should show both the current-cycle snapshot and the standing cap after a
  mid-cycle change ("only differs from the standing rule right after a mid-period
  change, in which case show both"). That case cannot occur: M4's own `setCap` updates
  the standing budget **and** the materialised snapshot for the current cycle in the
  same call (`default-budget-service.ts:168-174`), precisely so the user's "my budget is
  300 now" means now. The two cannot diverge, so the second figure was dead code
  pretending to be a feature. Caught by `commands/budget.test.ts`, which now asserts the
  sync instead. **M4's page is stale on this point, not the implementation.**

### Verification

`npm run typecheck` — clean, 0 errors.

`npm test` — **632 passed / 0 skipped** across 47 files with `DATABASE_URL` set, and
**623 passed / 9 skipped** without it (the 9 are the Neon-gated integration suites).
Up from 552: 68 new tests in nine suites (`test/unit/telegram/commands/*.test.ts`) plus
the 4C views appended to `render.test.ts`, and `test/support/domain-services.ts`.

Three 4B assertions were updated, each because 4C's landing is the thing they described
as pending: the catalogue now finds `/today`, `/start` joined the no-account set, and a
`hist:` press now reaches M3 — which rejects a bogus cursor in its own words rather than
as a generic stale button. No other existing test changed.

`npm run test:integration` — **72 passed / 0 failed** against the real Neon branch,
across all six integration files. 4C adds no schema and touches no repository, so this
is a regression check rather than new coverage.

`npm run db:generate` — **not run, and correctly so.** Stage 4C adds no schema. Needing
a migration here would have been a signal the design had drifted.

Commands are tested through the dispatcher rather than by calling `handle` directly: a
handler in isolation proves nothing about the two things most likely to break it — that
the router reaches it with the tokens it expects, and that a refusal it throws is
rendered rather than escaping as an apology. The figures in those tests are real —
`/today` asserts `$25` because `$600` over the 24 days left in the 5 Sep – 4 Oct cycle
is `$25`, computed by M5 from a materialised period and a real ledger sum, not a fake.

**Nothing here has been deployed or seen a real Telegram message.** `setWebhook` is
stage 4E, and production is the only environment (master plan §5.7).

### Open questions

1. **The Notion M11 and M2 pages still describe `/settings` as editable.** The local
   docs are updated; mirroring them to Notion is Ricky's to approve, since those pages
   are the shared source of truth and the wording there should be his.
2. **Nothing corrects a mistyped budget anchor date.** See the accepted cost above.
   Options when it comes back into scope: a narrow `/settings startdate`, or folding it
   into a broader settings-editing pass. Not urgent until someone actually mistypes it.
3. **`/history`'s page size (10) has never been seen on a real phone.** It is a guess
   that reads well in a test. Worth a look during 4E's manual walkthrough, when there is
   a real chat window to judge it in.

## M4/M5 — A cap change is spendable today — 2026-09-11

A follow-on to 4C, prompted by Ricky reviewing how `/budget` behaves mid-cycle. The
mid-period change and the carry-forward to the next cycle were already exactly what he
wanted (`setCap` moves the standing budget and the current snapshot together; a period
materialised later snapshots the new standing cap). What he did not want was the
*timing*: raise Food at 2pm and the daily figure only moved the following morning,
because M5 freezes `daily_target` per date. **His call: a raise today gives you more to
spend today.** Rewrite the row regardless of delivery status; never re-send.

Core M4/M5 work, so it sits on its own branch rather than inside 4C.

### Built

- **`BudgetAllowanceNotifier`** (`core/budgets/budget-service.ts`) — M4's outgoing
  port to M5, one method: `capChanged(userId, categoryId)`. Optional on
  `DefaultBudgetService`, called from `setCap` only after both M4 rows are written and
  only when the current cycle's snapshot existed (a day's target row references its
  period, so there is nothing to re-price otherwise). Best-effort, swallowed on
  failure, exactly as M3's `AllowanceNotifier` is: the cap is the system of record and
  today's figure is a downstream effect that lands tomorrow anyway.
- **`DefaultAllowanceService.capChanged`** — finds today's row, re-prices it from the
  period's new cap and spend **to the end of yesterday**, writes it back through a new
  `AllowanceWrites.updateTarget`. The target formula's inputs now come from one private
  `targetFor`, shared by the first-of-the-day compute and the re-price, so the two
  cannot disagree about what goes in.
- **`updateTarget`** on the port, the Drizzle repository and the in-memory adapter.
  Moves the one column; `delivery_status`, `attempts` and `sent_at` are untouched.
- **`/budget <category> <amount>`** now confirms with the day's figure, fetched from
  M5's `availableToday` and worded by M5's `renderAllowanceLine` — the same read and
  the same sentence `/today` uses, so the two cannot differ. *"Food is now $960 a cycle.
  You can spend $40 on Food today to stay on budget."* replaces *"The daily figure
  updates tomorrow morning."*
- **Cycle 3 in the composition root.** M5 already needed M4 (`ensurePeriod`); M4 now
  needs M5. Broken with the same closure the other two cycles use.

### The invariant, narrowed rather than dropped

M5's rule was "never recomputed for that date". It is now **"never recomputed from
that day's spend"** — M5's page, `daily-target.ts`, the schema comment and the service
header all say so. The failure the rule exists to prevent is a lunchtime overspend
smearing itself across the remaining days; a cap change is a different trigger, and
the re-price still takes spend only to the end of yesterday. Consequences the tests
pin down:

- today's own spend is still measured *against* the re-priced target, so an overspend
  stays visible as a negative number;
- re-pricing twice on one day gives the same number — the inputs do not move during
  the day;
- a `sent` row is rewritten in place, stays `sent` with its `sent_at`, and a later tick
  finds nothing outstanding — no second message;
- no row for today means nothing is written, and the day's first read computes from
  the new snapshot as before.

### Decisions taken (Ricky, 11 Sep)

- Mid-period cap changes are allowed and take effect this cycle; the new cap carries
  forward to the next cycle. (Already the behaviour; confirmed.)
- The extra is spread over the days left, not backfilled over days already gone.
- No "just this month" override — every change is permanent going forward.
- Rewrite today's row regardless of delivery status; never re-send the morning bundle.

### Verification

`npx tsc --noEmit` — clean, 0 errors.

`npx vitest run` — **637 passed / 9 skipped** across 47 files (14 tests added: 8 in
`test/unit/allowance/default-allowance-service.test.ts` replacing the one that asserted
the old timing, 3 in `test/unit/budgets/`, 1 in `test/unit/telegram/commands/budget.test.ts`,
3 in `test/integration/allowance.test.ts` on PGlite). **The 9 skipped are
`test/integration/identity.test.ts` and `test/integration/entitlements.test.ts`, which
need `DATABASE_URL` and were not executed in this environment** — neither touches
anything this change modifies. No `db:generate`: no schema change; `updateTarget` is an
`UPDATE` to an existing column.

### Open questions

- **Backdating into a cycle that never had a period row.** Discussed with Ricky the
  same day, not yet decided. `materialisePeriod` stamps the *current* standing cap, so
  an expense backdated into an earlier cycle that no read or write ever opened records
  that cycle at today's cap. It needs three things to line up (no activity in that
  category that cycle — including no `/today`, `/stats` or 07:00 reminder, all of which
  materialise — then a cap change, then a backdated entry), and nothing shipped displays
  a past cycle's cap. Options on the table: leave and log; a change-keyed cap-history
  table; or a period-keyed table, which Ricky raised and which has the same lazy-creation
  gap as `budget_period` itself. Also noted: `schema/budget.ts` says "superseded rows
  stay for their snapshots" but `upsertActiveBudget` updates in place, so that comment is
  stale whichever way this goes.

## M4 — The cap moves to `category_period_cap` — 2026-09-12

Ricky's call after the 11 Sep discussion of the backdating hole: rather than bolt a
change log beside two existing cap columns, **remove the cap from `budget` and
`budget_period` and keep it in one place, per category per cycle.** The "copy forward
at rollover" he described is implemented as a lookup rather than a job: a cycle's cap is
the `category_period_cap` row with the greatest `period_key` at or before it. Setting a
cap writes the current cycle's row; every later cycle reads it until a later row
supersedes it; every earlier cycle keeps the row that governed it. No cron, no catch-up
logic, one `WHERE` clause.

The hole it closes: a cycle nobody logged in, ran `/today` in, or was reminded in had
no `budget_period` row, and opening it later — a backdated expense — snapshotted
whatever the standing cap was *by then*. Set 1000 in July, raise to 1200 in September,
backdate a dinner into August: August was recorded at 1200. Now it resolves to July's
row. And before any row existed, the category had no cap — M3 records the transaction
with a null `budget_period_id`, exactly as it does for an uncapped category.

### Built

- **`category_period_cap`** (`schema/budget.ts`): `(category_id, period_key)` unique,
  `cap_minor_units` nullable — null is a removal, "no cap from this cycle on", so the
  last cap cannot leak into cycles where the budget was gone. Keyed by category, not
  budget, so history survives a budget being removed and re-added (each a new
  `budget` row).
- **`budget` and `budget_period` lose `cap_minor_units`** and their positive checks.
  `Budget` carries no amount. `BudgetPeriod.capMinorUnits` and
  `BudgetView.capMinorUnits` stay on the domain types — M5 and M7's contracts did not
  move — but are **resolved from the history on every read**, never stored.
  `BudgetView.snapshotCapMinorUnits` is gone; there is one figure.
- **Repository:** `findGoverningCap` (`period_key <= ? order by period_key desc limit
  1`), `findGoverningCaps` (`distinct on (category_id)`, same ordering — one query for
  `/budget` and `/stats`), `upsertPeriodCap` (`on conflict do update`; two `/budget`
  messages in one cycle leave one row). `updatePeriodCap` and `findPeriodsByKey` are
  gone. `'YYYY-MM'` keys sort chronologically as text, so both reads are index scans.
- **Service:** `materialise` resolves the cap *before* it writes a period and writes
  none when nothing governs the cycle — a period row without a cap would be a
  denominator of nothing. `ensurePeriodForCategory` returns null for such a cycle;
  `ensurePeriod` refuses (`RESOURCE_NOT_FOUND`), because its callers ask for the
  current cycle of an active budget, which always has one. `setCap` upserts the
  current cycle's row; `deactivate` writes a null row for it. `currentBudgets` throws
  — loudly, not a refusal — if an active budget has no governing cap, which is the
  store contradicting itself.
- **Migration `0007_category_period_cap`** — the one migration in the repository
  that moves data. Drizzle-kit's `CREATE` / `DROP COLUMN` output, reordered so three
  hand-written backfill `INSERT`s run while the old columns still exist: every
  materialised cycle's snapshot becomes that cycle's row (the later budget winning a
  shared cycle); a removed budget writes a null row for the cycle it was removed in;
  an active budget's standing cap goes on the cycle it was last set in (`updated_at`)
  and overrides that cycle's snapshot, as `setCap` does live. Period keys are derived
  in SQL exactly as `period.ts` does — anchor day capped at 28, cycle labelled by its
  start month, in the user's zone. `test/integration/migration-0007-category-period-cap.test.ts`
  seeds the *old* shape on PGlite, runs `0007`, and pins every resulting row.
  `drizzle-kit generate` reports no drift afterwards.
- **Consumers:** `/budget`, `/stats`, `/categories` and M2's account summary read
  caps through `currentBudgets` (the summary skips it before onboarding step 3 —
  no anchor, no budgets). `/budget <category> <amount>` uses the parsed amount for its
  headline. `FakeBudgets` in M2's tests keeps a cap map beside its rows.

### Decisions taken (Ricky, 12 Sep)

- Single source of truth for the cap: one table, per category per cycle. Cap columns
  removed from `budget` and `budget_period`, not left in parallel.
- Carry-forward by lookup ("latest cycle at or before"), not by a rollover job. M4's
  standing "no cron" decision holds; this extends it to caps.
- A removal is a null row, not the absence of one, so re-adding a budget later never
  resurrects an old cap for the cycles in between.

### Fixed in passing

- `schema/budget.ts` said "superseded rows stay for their snapshots" of `budget`,
  which `upsertActiveBudget` (an in-place `UPDATE`) never did. Rewritten to what the
  partial index actually serves: a removed budget stays, inactive, for its periods.
- M3's invariant "a confirmed transaction with a category that has an active budget
  always has a `budget_period_id`" is now qualified: when its date falls in a cycle
  that budget carried a cap in. Two M3 unit tests that backdated into August with a
  cap set in September were asserting the old stamping; they now set the cap in
  August first, and a third pins the new behaviour at M3's seam.

### Verification

`npx tsc --noEmit` — clean, 0 errors.

`npx vitest run` — **652 passed / 9 skipped** across 48 files. Net +15 tests: M4 unit
+10 (governing rows, the August case, two changes in one cycle, removal rows,
re-adding in a later cycle, the loud invariant); `ledger-budgets` integration +3 (the
real `<=`/`distinct on` queries on PGlite, the upsert's unique constraint, the null
row); a new 4-test suite for the `0007` backfill on old-shape rows; M3 unit +1. **The 9
skipped are `test/integration/identity.test.ts` and `test/integration/entitlements.test.ts`,
gated on `DATABASE_URL`, which this environment does not have — not executed.**
Neither touches M4.

`npx drizzle-kit generate` after the change — no diff; the committed SQL matches the
schema.

### Open questions

- **`budget.currency_code`** now sits on a row with no amount. It denominates every
  cap for the category and M2 fixes the account currency once anything is logged, so
  it is coherent but faintly odd. Left where it is: moving it widens the change for no
  behaviour. Revisit if `budget` ever loses another column.
- **`gateway.test.ts`** still builds its PGlite schema from `0003` + `0005` only, so it
  sees the pre-`0007` `budget` shape. It never touches budgets, so this is harmless, but
  every integration suite would be better off applying the full journal in order. Not
  changed here — CLAUDE.md, "do not combine broad structural refactoring with an
  unrelated feature change".

## M4 / tests — `currency_code` follows the cap; PGlite suites follow the journal — 2026-09-12

The two open questions from the entry above, taken as their own change each (CLAUDE.md,
"do not combine broad structural refactoring with an unrelated feature change"). Two
commits, no behaviour change to any command.

### Built

- **`test/support/pglite-migrations.ts`** — `applyMigrations(pg)` reads
  `meta/_journal.json` and applies every committed `.sql` in `idx` order, the same files
  `db:migrate` runs; `{ through }` stops after a tag and `applyMigration(pg, tag)` runs
  one, for the suites that seed an old shape first. Both directions of drift fail at
  load: a journal entry with no file, a file the journal does not list. The `.sql`
  files arrive through `import.meta.glob(…, { query: '?raw' })`, typed in
  `test/sql-modules.d.ts` to that one shape rather than by pulling `vite/client` in
  beside `@cloudflare/workers-types`.
- **Every PGlite suite** now builds from it: `gateway` (was `0000`+`0003`+`0002`+`0005`,
  so it ran on the pre-`0007` `budget`), `ledger-budgets`, `allowance`, the `0007`
  backfill suite (`through: '0006_…'`, seed, then `0007`), and `parse-event-fk`, which
  had carried a hand-copied DDL block with a stub `app_user` verified against
  drizzle-kit once, on 6 Sep. Its insert of `app_user (timezone)` works unchanged
  against the real table: every other column has a default.
- **`currency_code` moves from `budget` to `category_period_cap`** (`0008_currency_on_cap`).
  An amount and what it is denominated in now sit on one row, the precedent M3 set with
  `transaction.currency_code` ("copied onto each row, not joined from the user, so
  history still renders correctly if the default currency ever changes"). `budget` says
  only "this category is budgeted". A removal row carries the currency too, so the
  column is never null. `Budget` loses `currencyCode`; `PeriodCap` and
  `UpsertPeriodCapInput` gain it; `UpsertBudgetInput` loses it; `setCap` and
  `deactivate` pass `settings.currencyCode` through to the cap write. Nothing rendered
  it from `Budget` — M7 formats money with `settings.currencyCode` — so no command
  output changes.
- **Migration `0008`** is drizzle-kit's two statements reordered by hand around a
  backfill, as `0007` was: add the column nullable, `UPDATE` each cap row from its
  category's live budget (else its most recently updated removed one, else the
  account's currency — a row with no budget at all cannot come from the service, but
  the `COALESCE` costs nothing), then `SET NOT NULL` and drop from `budget`.
  `test/integration/migration-0008-currency-on-cap.test.ts` seeds the `0007` shape and
  pins all three branches plus the final column state. `drizzle-kit generate` reports
  no drift.

### Not done, deliberately

- `BudgetView` and `BudgetPeriod` do not surface the cap's currency. Their consumers
  format with the account currency, which M2 fixes once anything is logged; adding a
  field nobody reads would be the same faint oddity moved one layer up.

### Verification

`npx tsc --noEmit` — clean.

`npx vitest run` — **656 passed / 9 skipped** across 49 files (+4: the `0008` suite).
**The 9 skipped are `identity.test.ts` and `entitlements.test.ts`, gated on
`DATABASE_URL`, which this environment does not have — not executed.** Neither
touches M4's tables or the PGlite helper.

`npx drizzle-kit generate` after the schema change — "No schema changes, nothing to
migrate".

## M7 stage 4D — The free-text path — 2026-09-13

Phase 4's fourth stage, and the one the product is actually for. 4A gave the bot a
voice, 4B gave it ears, 4C gave it commands; this is the part where you type
"woolies 12.50" and it understands you.

M6's pipeline has been finished and tested since Phase 1 and has never been called by
anything. `pending_prompt` has existed since 4B and has never been written to. This
stage connects both, and adds the conversation that sits between them.

### Built

- **`channels/telegram/free-text.ts`** — `TelegramFreeTextHandler`. Builds
  `UserParseContext` from M2's `getSettings` and M3's non-archived category list,
  calls M6, writes or clears `pending_prompt`, and renders. No arithmetic and no
  policy; the one judgement it makes is reading "yes" as yes.
- **`channels/telegram/pending-payload.ts`** — the jsonb codec. Zod schemas for the
  three payload shapes, minor units as decimal text in both directions, and `null`
  rather than an exception for anything that does not fully validate.
- **`render.ts`** — `renderRecorded`, `renderConfirmPrompt`, `renderMappingQuestion`,
  and the `pc:` / `map:` callback helpers. The confirmation leads with what was
  recorded and puts M5's `renderAllowanceLine` on the next line, which is M7's page
  verbatim.
- **`TransactionParsingPipeline.answerClarification`** (M6) — see the first decision
  below. One line added to `docs/M6-nlp-parsing-merchant-memory.md`.
- **`pending_prompt.kind` gains `'mapping'`** — migration `0009`, with the journal tag
  renamed to `0009_pending_prompt_mapping_kind` the way `0007` and `0008` are.
- **The dispatcher's steps 8 and 9 are live.** `freeText` is a required dependency,
  `FREE_TEXT_NOT_WIRED_REPLY` is gone, and `pc:` / `map:` route in `routeCallback`.
- **`/cancel` is kind-aware.** A `mapping` question is asked *after* the entry is
  recorded, so "Nothing was recorded" there is a plain lie about the user's own
  ledger — the kind that sends someone to `/delete` to fix something that is not
  broken.
- **`src/index.ts`** wires `createParsingPipeline` and the handler. `createServices`
  gains its first test: the composition root was otherwise only ever exercised in
  production.

### Decisions taken (Ricky, 13 Sep 2026)

- **`answerClarification` is M6's, not M7's.** The stage sketch had M7 re-parsing "the
  original text with the answer appended". That is wrong for half the reasons we ask:
  appending "4.50" to "coffee 4,50" still contains a decimal comma, appending a day to
  a message carrying an impossible date still contains the impossible date, and both
  ask the same question forever. Which reasons behave which way is a fact about the
  parser, so the rule lives with the parser. `multiple_amounts`, `invalid_amount`,
  `foreign_currency`, `ambiguous_date`, `invalid_date` and `correction_intent` mean the
  original text is itself the problem and the answer stands alone; everything else
  means the original was fine but incomplete and the answer extends it. The merged text
  runs the ordinary `parse` path, so an answered attempt writes exactly one
  `parse_event` and passes every validation rule unchanged.
- **A third `PendingPromptKind`, `'mapping'`, and migration 0009.** "Always categorise
  Woolworths as Groceries?" is asked after the transaction exists and is answered by a
  later update, so the proposal has to survive the invocation. It cannot ride in the
  button — a `MappingProposal` is four fields against Telegram's 64-byte
  `callback_data` — and M11 requires every keyboard to have a free-text fallback, so a
  typed "yes" has to find the same proposal. Stage 4C recorded the two-kind constraint
  as its reason for making `/categories` and `/remind` argument-driven; this is the
  migration that decision predicted, taken deliberately rather than by accident.
- **Callback taps stay admitted messages.** The dispatcher admits at step 3, before it
  looks at the event kind, so a `pc:yes` or `map:yes` press counts against M8's
  fair-use window and, on Free, the 5-per-day cap. Ricky's ruling: this stays as it is,
  on the condition a user can finish onboarding before the daily cap applies — which is
  already true (`skipDailyCap: !resolved.onboarded`, migration 0006's
  `counts_toward_daily`). **The cost, recorded so it is not rediscovered as a bug: an
  expense that needs confirming costs a Free user 2 of their 5 daily messages, and 3 if
  they also answer the merchant question.** Worth revisiting only if the confirm
  threshold turns out to fire often in real use.
- **Anything that is not yes or no supersedes a yes/no question.** Someone who types a
  second expense while a confirmation is open wants that expense logged, not read as an
  answer about the first one. A `clarify` is the opposite: it asked for text, so any
  text is its answer.

### Assumed

- **The day is named only when it is not today.** "Recorded $5, today" reads like a
  receipt; a backdated entry landing on the wrong day is exactly the mistake the
  sentence exists to let someone catch. Yesterday gets the word, anything else gets
  "on 5 Sep".
- **The replacing branch of `answerClarification` can cost a second round trip.**
  Answer "the 30th" to "which day was it?" and the merchant and amount go with the bad
  date, so the next question asks for them. Each step converges and nothing loops.
  Reconstructing the good half of the original would mean trusting the mechanical
  parser's residual description — and the decimal-comma case is precisely where that
  cannot be trusted, since "4,50" survives into the residual as "4 50".
- **The yes/no vocabulary is deliberately small** (`yes/y/yep/yeah/yup/ok/okay/sure/please do`,
  `no/n/nope/nah/don't/dont`). Everything else supersedes, so the cost of being
  conservative is that "yep 12.50 coffee" logs a coffee — which is what it says.
- **The clarify payload stores the original message text**, which is new for this
  table. Not a new class of data — the same text reaches `transaction.raw_text` the
  moment the entry records — and it is cleared on an answer, on `/cancel`, or by a
  superseding message. **But an abandoned prompt keeps it until the user's next
  message, which is an M9 retention item rather than something this stage should invent
  a policy for.**
- **A `confirm` answered yes usually leaves a `mapping` question open, not an empty
  table.** That is the flow working: the entry records, and the merchant offer is the
  next thing the conversation is waiting on.

### Fixed in passing

- **The handler was asking Telegram what day it was.** It decided "was this today?"
  from the dispatcher's `now`, which is the sender's timestamp off the update, while M6
  stamps the transaction from its own injected `Clock`. In the unit harness the two are
  a day apart and every confirmation read "…under Food, on 11 Sep"; in production they
  differ by seconds, which is enough to call today's entry yesterday's on either side
  of a local midnight. `FreeTextHandler` now takes no `now` at all and the handler
  holds the clock M6 and M3 stamp with. The sender's timestamp stays where it belongs,
  in M8's admission windows.

### Verification

`npm run typecheck` — clean, 0 errors.

`npx vitest run` — **729 passed / 9 skipped** across 51 files, up from 656: 73 new
tests. Two new suites (`test/unit/telegram/free-text.test.ts`, 25;
`test/unit/telegram/pending-payload.test.ts`, 13) plus 35 appended to existing ones —
18 in `pipeline.test.ts` for `answerClarification`, 13 in `render.test.ts`, 3 in
`test/integration/gateway.test.ts` for the widened constraint, 1 in
`composition-root.test.ts` for `createServices`. The 9 skipped are the Neon-gated
integration suites, skipped because this worktree has no `.env`.

Two 4B assertions changed, both because they described 4D as pending: `pc:yes` is no
longer an unrouted callback prefix (`cat:` is, and deliberately so), and free text
during an open prompt now reaches M6 rather than the placeholder. The second got
stronger rather than merely rewritten — it answers "How much was it?" with "12.50" and
asserts Woolworths comes back, which only a merged parse can do. No other existing
test changed.

`npm run db:generate` — `0009_pending_prompt_mapping_kind`, one `DROP CONSTRAINT` plus
one `ADD CONSTRAINT`, inspected and committed with its snapshot.
`test/integration/gateway.test.ts` builds from the migration journal, so the widened
constraint is proven against real Postgres (PGlite) rather than only in the TypeScript
union.

`npm run test:integration` — **not run.** The Neon suites need `DATABASE_URL` in a
`.env` this worktree does not have, and `0009` has not been applied to the Neon branch
in any case. **`npm run db:migrate` is Ricky's step, before that suite will pass and
before 4E deploys.**

**Nothing here has been deployed or seen a real Telegram message.** `setWebhook` is
stage 4E, and production is the only environment (master plan §5.7).

### Open questions

1. ~~**`DefaultLedgerService` still does not call `ParseEventCorrectionHook`.**~~
   **Closed 13 September 2026** — see "M3/M6 — the correction feedback loop closes"
   below. M6's open question 2 sat out of 4D's original scope; raised again the same
   day once 4D shipped the first parse actually worth correcting, and closed then.
2. **The confirm threshold has never been seen against a real model.** 0.5–0.85 asks
   the user; above 0.85 records. Both numbers are M6's untuned defaults, and how often
   the middle band fires is what decides whether the two-messages-per-expense cost
   above is a footnote or a problem. 4E's manual walkthrough is the first chance to
   look.
3. **`readYesNo` is English-only and will stay that way until someone asks.** Worth
   naming because the typed fallback is what makes the keyboards answerable at all, and
   it only works in one language.

---

## M3/M6 — the correction feedback loop closes — 2026-09-13

M6's open question 2 (6 Sep) and 4D's open question 1 (13 Sep, above), closed the same
day: `LedgerService.correct()` now tells M6 when a parsed transaction is fixed, so
`parse_event.was_corrected` — M9's own words, "the only honest measure of parser
accuracy" — stops being permanently false.

### Built

- **`transaction.parse_event_id`** — nullable `uuid references parse_event(id) on
  delete set null` (migration `0010`). Null for anything not written from a parse — a
  4C-style direct command write, or a row recorded before this migration. `set null`
  rather than `cascade`: a transaction outlives the retention pass that may later prune
  its parse event (M9's territory, unchanged).
- **`ValidatedCandidate.parseEventId?: Id | null`** and **`Transaction.parseEventId: Id
  | null`** (`core/ledger/ledger-service.ts`). The candidate's field is optional and set
  in exactly one place — `TransactionParsingPipeline.persist`, just before the ledger
  call — because the id is generated by `logEvent` *after* validation, never by the
  validator itself.
- **`LedgerCorrectionNotifier`** (`core/ledger/collaborators.ts`), M3's own outgoing
  port for this, not an import of M6's `ParseEventCorrectionHook`: `src/parsing`
  already imports `ValidatedCandidate`/`Transaction` from `core/ledger`, so importing
  M6's port back into M3 would be a cross-module cycle. `TransactionParsingPipeline`
  satisfies the new port structurally — same shape, no shared import — and the
  composition root wires the two together with a closure, exactly the pattern already
  used for the identity/ledger, allowance/budgets and allowance/ledger cycles. `correct()`
  calls it once, unconditionally, whenever the existing transaction carries a
  `parseEventId`; a failure is swallowed the same way `notifyAllowance`'s is, because
  the correction itself has already committed.
- Drizzle and in-memory ledger repositories, and the pipeline test double
  (`RecordingLedgerService`), all map the new column/field through.

### Assumed

- **The hook fires on every correction, not only one that changes amount or
  category.** M9's own comment ("`was_corrected` is written later by M3's `correct`")
  and M6's doc describe no narrower trigger, and a note-only correction is still a
  correction in the sense the metric measures.
- **Nothing backfills `parse_event_id` on rows recorded before this migration.** They
  keep reading `null` forever, which is correct — they were never attributed to a
  parse event to begin with under the old schema.

### Verification

`npm run typecheck` — clean, 0 errors.

`npm test` — **742 passed / 0 skipped** (this environment now has `DATABASE_URL` set),
up from 738: 4 new tests in `test/unit/ledger/default-ledger-service.test.ts` (the hook
fires with a `parseEventId`, stays silent without one, and a failure doesn't fail the
correction) plus one new PGlite case in `test/integration/parse-event-fk.test.ts`
(a transaction survives its `parse_event` being deleted, with the reference nulled —
the real foreign key and `on delete set null`, not an in-memory stand-in for it).

`npm run test:integration` — **90 passed / 0 failed.** This proves nothing new about
the real Neon branch specifically: the two Postgres-gated files that touch it
(`entitlements.test.ts`, `identity.test.ts`) don't read or write `transaction`, and
every file that does (`ledger-budgets.test.ts`, `parse-event-fk.test.ts`) runs on a
fresh PGlite instance built from the committed migrations, not against Neon's current
state. A direct read against the branch confirms `transaction` does not yet have
`parse_event_id`. **`npm run db:migrate` is still needed before this reaches
production** — flagged rather than run, the same as `0005`/`0006` were.

`npm run db:generate` — `0010_puzzling_dormammu.sql`, inspected and committed with its
snapshot; one `alter table` adding the column, one adding the foreign key.

### Open questions

None new. M6's own open question 2 and 4D's open question 1 are both closed by this.
