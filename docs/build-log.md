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
