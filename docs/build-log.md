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

**Branch:** `worktree-agent-a5e94a5d51a0eca4a` · **Phase:** 1

### Built

- **Schema** `src/db/schema/identity.ts` — `app_user` + `channel_connection`,
  column-for-column the SQL in M2's plan: uuid PKs `gen_random_uuid()`, `timestamptz`
  everywhere, `period_anchor_date` a nullable `date`, `reminder_local_time time default
  '07:00'`, `status text check (…)`, `channel text check (channel in ('telegram'))`,
  `unique (channel, external_id)`, `index channel_connection_user`, FK
  `on delete cascade`. Generated migration `src/db/migrations/0000_sturdy_warbird.sql`
  + `meta/` committed — the first real migration in the repo (M1's was the no-op).
- **`IdentityServiceImpl`** (`src/core/identity/identity-service.ts`) behind an
  `IdentityRepository` seam (`repository.ts`), with `DrizzleIdentityRepository`
  (`drizzle-repository.ts`) as the production edge and `InMemoryIdentityRepository`
  (`src/core/testing/`) for unit tests. Every write takes `now` from the injected
  `Clock`; no `Date.now()` in the module.
  - `register` — one transaction: insert `app_user`, then `insert channel_connection …
    on conflict (channel, external_id) do nothing returning *`; no row back ⇒
    `tx.rollback()` (discards the orphan user) and return the winner's connection. The
    constraint is the idempotency mechanism; the read-first fast path is an
    optimisation only. A returning `/start` refreshes `chat_id`/`username` and sets
    `is_active = true` (un-does M5's 403 deactivation) — never a second user.
  - `setInitialTimezone` — `update app_user set timezone = $1 where id = $2 and
    timezone = ''`; the set-once guarantee is the predicate. Claimed ⇒ done; not
    claimed and stored value identical ⇒ silent no-op (redelivered callback); anything
    else ⇒ `TIMEZONE_IMMUTABLE`. Input is canonicalised via `Intl` so
    `australia/brisbane` stores as `Australia/Brisbane`.
  - `updateSettings` — runtime guard behind the type: `'timezone' in patch` ⇒
    `TIMEZONE_IMMUTABLE` **regardless of value**, before anything else is applied
    (no partial write). Unknown keys ⇒ `INVALID_ARGUMENT`. `currencyCode` change with
    any transaction ⇒ `CURRENCY_LOCKED` (asks M3 via `history(userId, { limit: 1 })`);
    same-value ⇒ allowed no-op. `periodAnchorDate` is a bare setting write (M4 derives
    periods; nothing rewritten); can't be cleared once set. `reminderLocalTime` stored
    only — M5 computes today's target alone, so it affects the next send, never
    backfills. All-no-op patches don't bump `updated_at`.
  - `exportAccount` — throws `IdentityError('NOT_YET_AVAILABLE', 'not implemented…')`
    per master plan §5.8. `deleteAccount` — `delete from app_user`, cascade does the
    rest; idempotent (retried delete is a no-op).
- **Onboarding state machine** `src/core/identity/onboarding.ts` — `OnboardingService`
  with `begin(userId, saved?)` / `apply(state, input)`, channel-agnostic: returns an
  `OnboardingPrompt` (structural, M7 renders it) + next `OnboardingState` (serialisable
  via `encodeOnboardingState`/`decodeOnboardingState`, since the cap is a `bigint`).
  Steps: timezone (curated AU list + full IANA search over `Intl.supportedValuesOf`)
  → currency (default AUD, omit to accept) → budget start date (suggests today in the
  user's zone from the clock) → categories+caps (draft list, "Food" pre-seeded,
  editable/removable, bounded 10/30) → reminder selection (1/5). Hand-off on confirm:
  `assertAllowed(create_category)` → `LedgerService.createCategory` → `BudgetService.
  setCap` per category; `assertAllowed(enable_reminder)` → `ReminderSelectionPort.
  enableReminder` per selection. Progress is tracked per item (`categoryId`,
  `capCommitted`, `reminderCommitted`); a mid-hand-off failure throws
  `OnboardingHandoffError` carrying the partial state so a retry skips what M3/M4/M5
  already have. `begin` for a user whose `timezone` and `periodAnchorDate` are set
  returns `{ step: 'summary', settings }` — never a new account, never step 1 again;
  a stale saved state is reconciled forward so step 1 is never re-asked.
- **Tests** — 55 new unit tests under `test/unit/identity/` (concurrent duplicate
  `register` with interleaved callers; every timezone mutation path incl. same-value
  explicit patch, forged step-1 callback, second `/start`; currency 0 vs 1
  transaction; cascade delete in the in-memory repo; full 5-step walk on both tiers;
  partial hand-off retry). `test/integration/identity.test.ts` (5 cases, skipped
  without `DATABASE_URL`) proves the unique constraint, the set-once claim, the
  `status` check constraint and cascade delete on a real Neon branch — not run
  locally. `npm run typecheck` + `npm test` green (64 passed, 5 skipped).

### Assumed

- **`timezone` stays `not null` (per the doc's SQL) with `''` as the "not yet set"
  sentinel.** `register` has to create `app_user` before step 1 collects a timezone,
  and the alternative (nullable column) deviates from the spec'd SQL. `getSettings`
  returns `timezone: ''` until step 1 completes; `hasCompletedCoreOnboarding(settings)`
  is the helper M7 should gate `ONBOARDING_REQUIRED` on. Making it nullable later is a
  one-column migration if preferred.
- **"Idempotent replay of the same value"** is read as: a replayed
  `setInitialTimezone(sameZone)` is a silent no-op; a `timezone` key in an
  `updateSettings` patch is refused even when it carries the stored value (the doc's
  test bullet and the task brief both say so). Both cases are tested.
- **Currency check uses `LedgerService.history(userId, { limit: 1 })`** rather than a
  new port method — it fits without touching M3's contract. Caveat: `history`
  presumably filters `status = 'confirmed'`, so a user whose only transaction is
  soft-deleted can still change currency. Their deleted row keeps its own
  `currency_code` (M3 copies it per row), so nothing renders wrong; flagging anyway.
- **Draft-then-hand-off for step 4**, not create-as-you-go: neither M3's nor M4's port
  has rename/archive/deactivate methods usable mid-onboarding, and creating on confirm
  keeps "accept, edit, or delete Food" a pure in-memory edit. Consequence: M8's
  `assertAllowed` can't bound the *draft* (it would count zero rows), so
  `ONBOARDING_TIER_LIMITS` duplicates M8's agreed 10/30 and 1/5 table for the draft
  UX only; `assertAllowed` still runs before every hand-off call and stays
  authoritative.
- **Conversation state is the gateway's to persist.** M2 owns no table for it;
  `OnboardingState` is small, JSON-encodable, and re-derivable enough (steps 1–3 are
  reconciled from `app_user` on `begin`) that a lost state costs at most the
  un-confirmed step-4/5 draft.
- **`register` refreshes the connection** (`chat_id`, `username`, `is_active = true`)
  on a returning user. Not in the doc; it's what makes a user who blocked and then
  un-blocked the bot receive reminders again without a support path.
- **Category name rules** for the draft: trimmed, internal whitespace collapsed,
  ≤ 40 chars, unique case-insensitively within the draft. M3's `normalized_name` is
  the real uniqueness rule; if M3 normalises differently, M3's constraint wins at
  hand-off and surfaces as an `OnboardingHandoffError`.
- **`localDateAt(instant, timezone)`** lives in `src/core/identity/validation.ts` —
  it's "what calendar day is it for this user", not period maths (which stays in
  M4's `periodFor`). M3 needs the same thing for `occurred_on`; feel free to lift it
  into `core/domain`.
- `deleteAccount` is idempotent (no-op when the user is already gone) so a redelivered
  `/delete` confirmation never surfaces an error for a mutation that already committed.

### Open questions

1. **`LedgerService.createCategory(userId, name): Promise<Category>` added to M3's
   contract** (plus a `Category` DTO from M3's SQL). The M1 stub had no
   category-creation method — `record` only creates one as a side effect of a
   transaction — and onboarding step 4 needs the id back. M3 owns the body
   (normalise, enforce `unique (user_id, normalized_name)`, atomic capacity check).
   Confirm the name/shape with whoever builds M3.
2. **`ReminderSelectionPort.enableReminder(userId, categoryId)`** is an M2-defined seam
   in `onboarding.ts`, not a method on any existing port. No module's port exposes
   "enable the daily reminder for this category" and where the flag lives (a
   `category` column? a `budget` column? M5's own table?) isn't specified anywhere.
   The integrator adapts it to whichever module lands it — or M5 adds the method to
   `DailyAllowanceService` and this seam goes away.
3. **`CURRENCY_LOCKED` added to `RefusalCode`.** M11's table had no code for "currency
   change refused because you have transactions"; `INVALID_ARGUMENT` would be a lie.
   M11's lead may rename it.
4. **Cascade-delete coverage is only `channel_connection` for now** — no other module's
   table exists yet. The integration test has a comment marking where to seed one row
   per module and assert it's gone (and that `parse_event.user_id` is nulled).
5. **`Intl.supportedValuesOf('timeZone')` on Workers** — the IANA search relies on it
   (418 zones under Node locally). V8 ships it and `compatibility_date` is recent,
   but it hasn't been exercised in a deployed Worker; `allTimezones()` falls back to
   the curated list if the API is absent, so the failure mode is "search is AU-only",
   not a crash. Worth a one-line check on first deploy.
6. **Onboarding step count** — built as 5 per the doc; the doc's own note about
   Ricky's "confirm 6 steps" message still stands. Adding a choiceless "your budget
   renews monthly from <date>" confirmation would be one more `OnboardingStep` between
   `anchor_date` and `categories`.
