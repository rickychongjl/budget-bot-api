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

## M8 — Entitlements & Limits — 2026-09-06

**Branch:** `worktree-agent-ac0392f4153274c16` · **Phase:** 1 (policy only; Stars billing is Phase 2)

### Built

- **Schema** `src/db/schema/entitlement.ts` — `entitlement` and the revised
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
