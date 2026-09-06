# budge-bot-api

One Cloudflare Worker holding the whole Budge Bot product. Only Telegram is in
scope; a second channel would be a future adapter behind the same two ports
(`InboundMessage`, `MessageSender`), never a reason to touch core modules.

This repo is at **Phase 0** — M1, the platform foundation every other module builds
on. See `docs/00-MASTER-PLAN.md` and `docs/M1-platform-data-configuration.md`.

## Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Cloudflare Workers |
| HTTP | Hono |
| Database | Neon Postgres, Sydney |
| DB access | Hyperdrive binding + `postgres.js` + Drizzle ORM |
| Migrations | Drizzle Kit, forward-only SQL committed to the repo |
| Scheduler | Workers Cron Triggers |
| Deploy | Wrangler via GitHub Actions |
| LLM | GPT-5.4 nano behind a provider-neutral port |

## Layout

```
src/
  index.ts                 fetch + scheduled handlers, bindings (Env)
  channels/telegram/       M7  gateway: webhook, commands, replies
  parsing/                 M6  normaliser, extractors, llm parser
  core/
    identity/              M2
    ledger/                M3
    budgets/               M4
    allowance/             M5
    entitlements/          M8
    domain/                pure: money, period maths, allowance formula (clock-injected)
    ports/                 typed interface stubs — the team's coordination mechanism
    testing/               TestClock and friends
  observability/           M9  (fixed pieces built in M6's PR)
  db/
    client.ts              Hyperdrive + postgres.js + Drizzle
    schema/                split per module, barrel-exported from index.ts
    migrations/            generated SQL, forward-only
wrangler.toml
```

**The schema is split per module on purpose** (M1 §2, master plan §4): each Phase 1/2
agent only ever touches its own `db/schema/<module>.ts` plus the one barrel line in
`db/schema/index.ts`, instead of fighting over a single `schema.ts`. `category` ↔
`budget` and `transaction` ↔ `budget_period` FK across the M3/M4 boundary — those two
modules coordinate one migration.

**`core/ports/` is the contract.** Every interface is lifted from its module's own
plan doc and committed as a compiling-but-unimplemented stub, so Phase 1 agents
implement against a fixed contract instead of inventing their own and reconciling
later.

## Commands

```
npm run dev              wrangler dev
npm run typecheck        tsc --noEmit
npm test                 vitest (unit)
npm run test:integration vitest against a Neon branch ($DATABASE_URL)
npm run db:generate      drizzle-kit generate  (no-op until M2 adds the first table)
npm run db:migrate       drizzle-kit migrate
npm run deploy           wrangler deploy
```

## Configuration

Single environment this pass: **production only** (master plan §5.7). Secrets are
Wrangler secrets (`wrangler secret put <NAME>`) / GitHub Actions secrets, never in
`wrangler.toml`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`INTERNAL_DISPATCH_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`. Copy
`.dev.vars.example` to `.dev.vars` for local runs.

CI needs repo variable `NEON_PROJECT_ID` + secret `NEON_API_KEY` for the per-PR
integration branch; deploy needs `DEPLOY_ENABLED=true` plus `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL`. Both workflows skip cleanly until those
exist.

## Build log

Every agent appends to `docs/build-log.md` — what it built, what it assumed, and any
open question it hit.
