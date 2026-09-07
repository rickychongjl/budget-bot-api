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
