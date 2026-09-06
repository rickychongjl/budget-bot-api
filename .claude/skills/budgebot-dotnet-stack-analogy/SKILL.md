---
name: budgebot-dotnet-stack-analogy
description: Explains Budge Bot's backend architecture, stack, local dev setup, or deployment pipeline to Ricky by mapping it onto his familiar C#/.NET, Vue, SQL Server, IIS Express, and Octopus Deploy background. Use this whenever Ricky asks how a piece of the Budge Bot backend works, asks "what's the equivalent of X" (a connection string, a migration, a controller, a background job, a deploy step), or asks about Cloudflare Workers, Hono, Drizzle, Neon Postgres, Hyperdrive, Wrangler, or Cron Triggers in the context of this project — even if he doesn't name .NET explicitly, since relating new stacks back to what he knows is his default learning style. Also trigger proactively when introducing a new piece of this stack to him for the first time, not just when he asks.
---

# Explaining Budge Bot's stack to Ricky

Ricky is a senior C#/.NET developer (Vue on the frontend, SQL Server on the backend) picking up a genuinely different stack for Budge Bot: TypeScript on Cloudflare Workers, Neon Postgres, Drizzle ORM, Hono, Wrangler. His fastest path to understanding a new piece of this project is "what's the closest thing to this in ASP.NET / EF Core / IIS / Octopus, and where does that comparison actually break down." Lead with the analogy, then be explicit about the gap — false-friend comparisons cost him more than an honest "this one's genuinely new" does.

## His baseline (for reference — don't re-explain this back to him)

C#/.NET backend, Vue frontend, SQL Server. Local dev: IIS Express, connection string in `web.config`/local connection config. Deploy: Octopus Deploy transforms `web.config` values (including connection strings) per environment/tenant on a multi-tenant SaaS (his day job, Endpoint IQ/Integrity IQ) — one build, many tenant-specific releases.

## The one thing to establish before any of the smaller mappings

Everything else in this stack is a consequence of one shift: **there is no persistent server process.** IIS keeps an app pool alive across requests — static caches, singleton services, long-lived DB connections, an `IHostedService` ticking in the background all just work because the process itself persists. Cloudflare Workers has no equivalent: every request (and every cron tick) is a fresh, isolated function invocation that starts cold, runs, and disappears. Nothing survives between them except what's explicitly written to Postgres. Hyperdrive exists specifically to paper over the DB-connection consequence of this (pooling connections across invocations that can't hold their own). The self-dispatching cron pattern in M5 exists because a single invocation only gets 10ms of CPU, so there's no room for a loop that walks every user the way an `IHostedService` background loop would. When something in this stack looks unnecessarily convoluted compared to his ASP.NET instinct, this is almost always why — check here first before assuming it's arbitrary.

## Quick-reference mapping

| His world | Budge Bot equivalent | Where the analogy holds / breaks |
|---|---|---|
| ASP.NET Core Web API controller | Hono route handler (`src/channels/telegram/`) | Holds well — receives the request, delegates to services, returns a response. Breaks in that there's no middleware pipeline as elaborate as ASP.NET's by default; Hono's is much thinner. |
| Service layer, DI-injected interfaces (`IFooService`) | `core/<module>/` — each exposes a TypeScript interface (`LedgerService`, `BudgetService`, etc.) | Same shape (program to an interface, inject a `Clock`/repository rather than call `Date.now()` or hit the DB directly). Breaks in that there's no IoC container (no `IServiceCollection`) — wiring is done by hand, usually in `index.ts` or a small factory. |
| Entity Framework Core (DbContext, LINQ) | Drizzle ORM (schema-as-TS-files, typed query builder) | Same code-first mental model. Breaks on migrations — see below. |
| EF Core Migrations (`Add-Migration`, `Update-Database`, reversible via `Down()`) | Drizzle Kit (`generate`, committed SQL, applied via CI) | Forward-only. There is no `Down()`. A mistake gets fixed with a new forward migration, not a rollback. |
| SQL Server | Neon Postgres (Sydney region) | Different engine (Postgres, not T-SQL), but same relational-DB mental model. Neon adds branch-per-PR for CI, which doesn't have a direct analog in his world unless he's used a scripted throwaway LocalDB/container per build. |
| Connection string in `web.config` / `appsettings.json` | `DATABASE_URL` via a Hyperdrive binding, set as a Wrangler secret in prod or in a local `.dev.vars` file for dev | Same idea (externalized, environment-specific connection config) but no XML transform step — see Octopus row below. |
| IIS Express (F5, local debug host) | `wrangler dev` (Cloudflare's local Workers runtime emulator) | This is the direct "run it locally" equivalent — closest 1:1 mapping in the whole stack. |
| Octopus Deploy: build once, transform config per environment/tenant, release to each | GitHub Actions: run migrations against a Neon branch, then `wrangler deploy` | Budge Bot deliberately has **one environment** (production only, no staging, no tenants — confirmed decision, not a gap). So there's no transform step to look for; where Octopus would branch per tenant, this pipeline just doesn't branch at all. Don't go looking for the tenant-config-transform equivalent — it isn't there by design. |
| Hangfire / Windows Task Scheduler / `IHostedService` | Cloudflare Cron Triggers, self-dispatching fan-out pattern | Genuinely different, not just relabeled — see the CPU-limit note above. A cron tick fans out via subrequests to fresh invocations rather than looping in one process. |
| Vue SPA | *(no equivalent in Budge Bot itself)* | Budge Bot's "frontend" is Telegram's own client rendering the bot's messages — there's no SPA, no client-side routing, no component tree to reason about. The one Vue-adjacent thing in this project is M10's marketing site, which is a separate Astro codebase, unrelated to the bot's backend. |
| Multi-tenant SaaS (per-tenant data isolation, tenant-aware config) | None — single-user v1 | Don't reach for a tenancy analogy anywhere in this codebase; it isn't a simplified version of his day job's multi-tenancy, it's genuinely absent. |

## How to use this when a new piece of the stack comes up

1. Find the row (or the closest neighboring concept) in the table above.
2. Lead with the analogy in one sentence — give him the "oh, it's basically X" anchor first.
3. Immediately follow with the specific place it diverges, if any. Don't let the analogy imply more equivalence than actually exists (e.g. don't let "it's like EF Migrations" pass without mentioning forward-only).
4. If the concept has no real analog (the serverless execution model, the CPU-time ceiling, the self-dispatching cron pattern, single-environment deploys, the absence of a frontend framework), say so plainly rather than forcing a strained comparison. He'd rather hear "this one's just new" than get a false-friend mapping that misleads him later.
5. When a concept doesn't appear in the table at all (a new piece of the stack comes up that isn't listed), reason from the same underlying shift — no persistent process, no IoC container, single environment — rather than guessing at an ASP.NET equivalent that may not exist. It's fine to say the honest thing: "I don't think there's a clean .NET equivalent for this one."

## Keeping this current

This mapping is specific to the stack decisions in `00-MASTER-PLAN.md` and M1 (Platform, Data & Configuration) as of when this skill was written. If the project's stack changes (a different DB, a different deploy target), the table above should be revisited rather than trusted blindly — check the current master plan/M1 file if something here seems to have drifted.