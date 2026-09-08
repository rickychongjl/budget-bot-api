# M1 — Platform, Data & Configuration

**Phase:** 0 (do this first, sequential — every other module builds on its output)
**Notion status:** Agreed v1 direction, 4 Sep 2026
**One-line scope:** The foundation every module sits on — runtime, hosting, database platform, schema conventions, migrations, environments, secrets, repo layout, test infrastructure. Owns no domain tables of its own.

---

## Depends on
Nothing. This is the root.

## Depended on by
Every other module. In particular:
- All modules read/write Postgres only through Hyperdrive + Drizzle, per this module's conventions.
- All modules take an injected `Clock` from here rather than calling `Date.now()`.
- M2, M3, M4, M5, M6, M8, M9 each own tables that must live in the schema layout this module defines.
- M7 and M5 depend on the repo having `wrangler.toml`, secrets, and the cron trigger wired correctly.

---

## What to build

### 1. Stack (already decided, just implement it)
| Concern | Choice |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Cloudflare Workers |
| HTTP framework | Hono |
| Database | Neon Postgres, Sydney region |
| DB access | Hyperdrive binding + `postgres.js`, Drizzle ORM |
| Migrations | Drizzle Kit, forward-only SQL committed to repo |
| Scheduler | Workers Cron Triggers |
| Source control | GitHub, separate repo `budge-bot-api` |
| Deploy | Wrangler via GitHub Actions |
| LLM | GPT-5.4 nano behind a provider-neutral port |

Use a native driver (`postgres.js`) with Hyperdrive — not the Neon serverless driver; they're alternatives, not layers.

### 2. Repository layout
**Revised 6 Sep:** moved to `CLAUDE.md`'s feature-oriented ports-and-adapters
structure (each module owns its own contract; no global `ports/`/`domain`
dumping ground; database code lives under `infrastructure/`). `channels/telegram/`
is a deliberate, approved exception — see `CLAUDE.md`'s "Telegram and application
entry points" section. `CLAUDE.md` is the authoritative repo-layout reference from
here on; this tree is kept only as a historical pointer to where each module's
contract and schema file live:
```
src/
  index.ts                 fetch + scheduled handlers, bindings
  channels/telegram/       M7  gateway: webhook, commands, replies (approved exception, see CLAUDE.md)
  parsing/                 M6  normaliser, extractors, llm-parser.ts (port)
  core/
    identity/              M2  identity-service.ts (port)
    ledger/                M3  ledger-service.ts (port)
    budgets/               M4  budget-service.ts (port), period.ts (pure)
    allowance/             M5  allowance-service.ts (port), daily-target.ts (pure)
    entitlements/          M8  entitlement-service.ts (port)
    shared/                 genuinely cross-module only: common.ts, clock.ts,
                             money.ts, messaging.ts
  observability/           M9
  infrastructure/
    database/
      client.ts
      schema/               split by module — see below
        identity.ts          M2: app_user, channel_connection
        category.ts          M3: category
        budget.ts             M4: budget, budget_period
        transaction.ts        M3: transaction
        allowance.ts          M5: daily_allowance_send
        entitlement.ts        M8: entitlement, usage_counter
        observability.ts      M9: parse_event
        platform.ts           M7: inbound_update
        index.ts             barrel export, imported by drizzle.config
      migrations/
wrangler.toml
```
**Split the schema into per-module files, barrel-exported from
`infrastructure/database/schema/index.ts`.** This is the single most important
structural decision for letting Phase 1/2 agents work in parallel without fighting
over one giant `schema.ts`. Each module agent only ever touches its own file plus
the barrel export.

### 3. Ports — commit these as typed stubs before Phase 1 starts
This is the actual coordination mechanism across the agent team: every other module implements against an interface that's fixed from day one, instead of inventing its own and reconciling later. Pull these directly from each module's own page (they're already fully specified there) into that module's own folder under `core/` (or `core/shared/` for the handful that are genuinely cross-module, or `parsing/` for the LLM port):
- `IdentityService` (M2) — `core/identity/identity-service.ts`
- `LedgerService` (M3) — `core/ledger/ledger-service.ts`
- `BudgetService` (M4) — `core/budgets/budget-service.ts`
- `DailyAllowanceService` (M5) — `core/allowance/allowance-service.ts` — build the per-category revision from the master plan §5.2, not the page's original per-user shape
- `EntitlementService` (M8) — `core/entitlements/entitlement-service.ts`
- `MessageSender` / `InboundMessage` (M7) — `core/shared/messaging.ts` (shared across channel adapters, not owned by one business capability)
- `LlmParser` (M6) — `parsing/llm-parser.ts`
- `Clock` — `core/shared/clock.ts` — `now(): Instant`, injectable, real implementation wraps `Date.now()`, test implementation is settable

Stub bodies can `throw new Error('not implemented')` — the point is the compiler enforces the contract from the first commit. Each module's `index.ts` re-exports its own contract as its public surface, per `CLAUDE.md`'s "Public module exports" rule.

### 4. Schema conventions (binding on every module)
- `uuid` primary keys, `default gen_random_uuid()`.
- Every timestamp is `timestamptz` UTC. A user-local calendar date is a separate `date` column, computed at write time.
- Money is `bigint` minor units. Never `numeric`, never a float, anywhere.
- Every user-scoped table carries `user_id` with `on delete cascade`.
- Uniqueness is a database constraint, not an application check; conditional uniqueness is a partial unique index.
- Hot queries get partial indexes filtered to `status = 'confirmed'` rather than indexing rows nothing reads.
- Enumerations are `text` with a `check` constraint, not a Postgres enum.

### 5. Migrations
Drizzle Kit generates SQL from `infrastructure/database/schema/*.ts`; the generated SQL is committed and is the source of truth. **Forward-only, no down migrations.** Neon branching gives a database branch per PR — CI applies migrations to a throwaway branch and runs the suite against real Postgres. Production migrations run from a GitHub Actions job that must succeed before the Worker deploys, in that order.

### 6. Environments and secrets — **revised 5 Sep: single environment for this pass**
The page's original design called for two environments, `staging` and `production`, each with its own Worker, Neon branch, and Telegram bot token, specifically so a test message could never reach a real user. **Ricky's resolved this to production-only for now** ("let's assume we only have production for now"). Build one Worker, one Neon branch, one Telegram bot token. Pre-merge testing relies on CI's per-PR ephemeral Neon branch (unrelated to "staging" as a deployed environment — that piece of §5/Test infrastructure is unchanged) plus unit/integration tests; there's no deployed pre-prod Worker to manually poke at with a real Telegram client before a change ships. **Confirmed 5 Sep (round 3):** this is a deliberate trade-off, not an accidental scope cut. Ricky: *"confirm production only, I can't be bothered with staging too, considering I am the only user for now."* Single bot token, no staging, no separate test bot — nothing further to decide here.
Secrets in Wrangler + GitHub Actions secrets, never in `wrangler.toml`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_DISPATCH_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`.

### 7. Test infrastructure
- **Unit** — each module's pure calculations (e.g. `core/budgets/period.ts`, `core/allowance/daily-target.ts`): period boundaries, half-hour offsets, daylight-saving transitions, allowance at period edges. No database, no Worker.
- **Integration** — against a Neon branch, not a mock (the schema constraints are doing real work).
- **Eval** — M6's versioned NLP evaluation set; thresholds set from its results, not guessed.
- **End-to-end** — one test posts a realistic Telegram update to the deployed Worker (production, per the single-environment decision above) and asserts the reply.

---

## Known constraints to design around (not open questions — just real limits)
- Workers Free plan: 10 ms CPU per invocation, 50 subrequests per invocation, 100k requests/day, 5 cron triggers. This is why M5's scheduler is a self-dispatching cron (see M5's plan) rather than a loop.
- No long-running process — anything that would be a background service must be a cron tick. Cloudflare Queues needs Workers Paid.
- Node built-ins are only partly available under `nodejs_compat` — check before adding a dependency.
- The whole path is designed to be A$0/month fixed cost; upgrading to Workers Paid (US$5/month) is the expected next step once there are real users and the 50-subrequest ceiling binds.

## Open decisions — resolved 5 Sep
- [x] Marketing site and bot share a Cloudflare account — **shared account**.
- [x] Staging vs. production Neon — **moot; production only for this pass, fully confirmed round 3** (see §6 above).
- [x] Error tracking — **Workers' built-in observability is enough for now**.

## Out of scope for this pass
- Anything domain-specific — this module owns no business tables.
- Choosing a different LLM provider — GPT-5.4 nano is the v1 choice; the port just needs to make swapping possible later.

## Definition of done
- [ ] `budge-bot-api` repo exists, deploys an empty Worker to production via GitHub Actions.
- [ ] `wrangler.toml` has the production environment configured, secrets set via `wrangler secret put`, none committed.
- [ ] `infrastructure/database/schema/index.ts` barrel-exports empty per-module files; `drizzle-kit generate` produces a no-op or trivial first migration.
- [ ] Every interface listed above is committed in its owning module folder, compiling but unimplemented.
- [ ] CI: on PR, spins a Neon branch, runs migrations, runs the integration suite (even if empty), tears down.
- [ ] A one-line "hello world" cron trigger fires successfully in production (proves the scheduler wiring works before M5 needs it) — there's no staging Worker to try it on first, so treat this first cron deploy carefully.

## Related
- Notion: [M1 — Platform, Data & Configuration](https://app.notion.com/p/3d1ef5e61bdd81939753cd019f9441ae)
- Master plan §4 (build sequencing), §5 (decisions), §6 (conventions)
