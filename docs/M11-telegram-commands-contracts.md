# M11 — Telegram Commands & Contracts

**Phase:** ongoing, cross-cutting — **not a worker-agent build task.** Assign this to yourself or a "lead" Claude session that reviews PRs against it, not to whichever agent happens to build M7.
**Notion status:** Draft for review, 5 Sep 2026 — re-fetched and fully reconciled 5 Sep (round 5). A documentation module — no tables, no separate deployable.
**One-line scope:** The central catalogue for what a user can ask the bot to do — syntax, inputs, outputs, replies, state changes, failures, tier eligibility, and which module owns each command's behaviour.
**Reconciled 5 Sep (round 5):** Ricky's marked **`/export` deferred (Story 7)** — full-history CSV export is no longer being built this pass. This ripples into M3 (owns `exportCsv`), M2 (`exportAccount` delegates to it), M7 (stub it like the billing commands), and the master plan's scope/DoD — all updated alongside this file. Separately, M11's own page still lags behind several decisions Ricky's already made directly in this conversation (monthly-only cycle, fixed 07:00 reminder with no customisation, 5-step onboarding, "Food"-only starter category, M3's archive-gated-by-current-cycle mechanism) — this plan builds against the resolved answers, not the page's stale phrasing, and flags each spot below.

---

## Why this isn't a build task
M11 owns no tables and introduces no Telegram dependency into the core. Its job is to be the single source of truth that M2, M3, M4, M5, M6, M7, and M8 all implement *against* — and to say, explicitly, where it revises an earlier module's own page (it does this once, decisively, for M7's routing order — see `M7-telegram-gateway.md`). Handing this to a worker agent to "implement" would be a category error: there's nothing to deploy. What it needs is a human (or lead session) who reads every module PR that touches a command and checks it against this catalogue, then updates the catalogue to match what actually shipped.

## Depends on
Every module's own page (M2–M8) for the domain behaviour it's cataloguing, plus the underlying PRD and User Stories.

## Depended on by
- **M7** implements this catalogue's routing/commands verbatim (with M11's routing-order revision taking precedence over M7's own page — see M7's plan).
- **M2, M3, M4, M5, M6, M8** each implement the specific command contracts that call into them.

---

## Already resolved — keep the catalogue in sync as PRs land
- Tier caps: Free 5 msg/day (fair use 20/2h both tiers), 10/30 categories, 1/5 reminder categories, budget on any permitted category either tier. Bot replies/reminders and failed sends never count; duplicate redeliveries count once; local-midnight reset.
- Timezone immutable after onboarding, enforced everywhere, not just the UI.
- Category counting: **updated by M3 round 4, supersedes the Notion page's "archiving frees no slot."** Capacity = non-archived categories only; a category can only be archived if it has no transaction in the current budget cycle. See M3's plan.
- Requested downgrade needs ≤10 categories and ≤1 reminder-enabled category.
- Routing precedence: recognised commands/callbacks, and callback/pre-checkout/payment events, beat a pending clarification (revises M7 — already built into M7's plan).
- **Budget cycle: monthly only, account-wide** — M11's page still lists this as open ("monthly only or weekly/fortnightly? account-wide or per-category?"); it's resolved. See M4's plan §"Period derivation."
- **Reminder time: fixed 07:00 local for every user, no customisation, bundled into one message per user** — M11's page still says "default 08:00, custom time TBD"; both are stale. See M5's plan.
- **Onboarding: 5 steps** (timezone → currency → budget start date → categories+caps → reminder selection), starter category is **"Food" only**. See M2's plan.
- **`/export` — deferred (Story 7), not built this pass.** Ricky's call, round 5. Full-history CSV export was previously in scope for both tiers (the master plan's original DoD had it); it's now pushed out. `/export` should exist as a stub returning "not yet available," same pattern as the billing commands — see M7's plan, M3's plan (`exportCsv` deferred), M2's plan (`exportAccount` deferred).

## Still open — resolve before the dependent module ships, your call not an engineering default
| Decision | Blocks | Recommended framing if you want a default |
|---|---|---|
| Approve proposed command names/syntax (`/categories`, `/settings`, `/upgrade`, `/subscription`, `/cancel`) before BotFather registration | M7 | These read as reasonable as proposed — a quick sign-off is probably all this needs |
| Interactive `/history` editing: Premium-gated (as proposed) or both tiers | M8, M3 | Still deferred like `/export` — no interactive editing this pass, on either tier |
| Telegram Stars price + tested AU$ approximation | M8, M10 | Explicitly deferred to Phase 2 already — needs live pricing validation, not an engineering guess |
| Excel export | — | Not requested for this pass; skip (moot for now — CSV export itself is deferred too) |
| Unknown command: full `/help` dump vs. a short "I don't know that one" | M7 | Short reply + pointer to `/help` reads as friendlier; low-stakes, pick either |
| Inline keyboard option count before falling back to plain text | M7 | Low-stakes engineering default is fine |
| `/stats`: plain text only, or Telegram-native formatting | M7 | Plain text is simpler and avoids the escaping risk noted in M7's plan |

---

## Command catalogue — current shape (keep this updated as the source of truth once implementation starts)
| Command | Purpose | Tier / status | Owner |
|---|---|---|---|
| `/start` | Onboarding (5 steps) or settings summary | Both; existing | M2, M3, M4, M5 |
| Free text | Transaction confirmation or one clarification | Both; existing; fair use | M6 → M3 |
| `/today [category]` | Today's allowance | Both; counts toward quota | M5, M8 |
| `/budget [category] [amount]` | View/set a category cap | Both; existing | M4 |
| `/categories` | View/create/rename/archive categories | Both; proposed; 10/30 capacity; archive gated on no-transactions-this-cycle | M3, M8 |
| `/settings` | View immutable timezone; view/change currency; view fixed monthly cycle start date | Both; proposed | M2, M4 |
| `/stats [category]` | Current-period summary | Both; existing | M3, M4 |
| `/delete` | Soft-delete last confirmed entry | Both; existing | M3 |
| `/help [command]` | Usage, tier labels, support links | Both; existing | M7 renders M11's catalogue |
| `/history` | Paginated history + edit | **Deferred this pass** (interactive editing, both tiers) | M3, M8 |
| `/export` | Full-history CSV | **Deferred — Story 7, round 5.** Stub only, "not yet available." | M3 |
| `/remind [category]` | View/change reminder selection | Both; 1/5 categories; fixed 07:00, no custom time | M5, M2, M8 |
| `/upgrade`, `/subscribe` | Premium offer + Stars checkout | Both; **stubbed this pass** | M8 |
| `/subscription` | Status + cancel-renewal | Both; **stubbed this pass** | M8 |
| `/paysupport` | Payment support route | Both; **stubbed this pass** | M8 |
| `/cancel` | Abandon current uncommitted conversation | Both; proposed | M7 |

## Shared contract every command implementation follows
- **Scope**: one user, one private chat. Group/channel requests get a private-chat instruction, never account data.
- **Identity**: derive from the authenticated inbound context, never from a typed ID; recheck ownership on every category/transaction/cursor/callback.
- **Arguments**: quote multiword category names (`/budget "Eating Out" 300`); missing input opens a guided prompt; invalid input returns a precise correction with no partial write.
- **Money/dates**: user enters decimal amounts in account currency; validate exponent, convert once to minor units; no floating point, no currency conversion; period boundaries only from M4 (monthly only).
- **State/retries**: duplicate update/callback IDs never create a second entry, delete a second transaction, buy a second subscription, or consume quota twice. If a write committed but delivery failed, retry delivery from the recorded result — never repeat the mutation.
- **Presentation**: one conversational reply per input step; paginate long results; payment receipts are a separate async event, exempt from the "one reply" rule.

### Common refusal codes to implement consistently across modules
`ONBOARDING_REQUIRED`, `INVALID_ARGUMENT`/`CATEGORY_NOT_FOUND`/`NO_BUDGET`, `DAILY_MESSAGE_LIMIT`, `FAIR_USE_LIMIT`, `CATEGORY_LIMIT`/`REMINDER_CATEGORY_LIMIT`, `TIER_REQUIRED`, `STALE_ACTION`/`RESOURCE_NOT_FOUND`, `NO_TRANSACTIONS`/`NO_SUBSCRIPTION`, `BILLING_UNAVAILABLE`/`DELIVERY_FAILED`, `TIMEZONE_IMMUTABLE`, and now **`NOT_YET_AVAILABLE`** for `/export`, `/history` editing, and the billing commands — same shape as the others, rendered by M7, never a raw error.

---

## Notes on individual commands that changed this pass
- **`/start`**: 5 steps, "Food"-only starter category, monthly-only cycle collection (no period-type choice) — see M2's plan for the exact flow and the open question about whether a 6th confirmation-only step should exist.
- **`/export` (Story 7, deferred)**: build the command as a registered stub that replies "not yet available yet" (`NOT_YET_AVAILABLE`), same as the billing commands. Do **not** implement `LedgerService.exportCsv` or `IdentityService.exportAccount`'s CSV assembly this pass — see M3's and M2's plans, both updated to defer this. Keep the port method signatures in place (so the contract compiles and a later PR can fill them in) but don't wire them to real streaming logic yet.
- **`/history`**: unchanged — already deferred (interactive editing, either tier); `/export`'s deferral doesn't change this, it was already out of scope.
- **`/remind`**: single fixed 07:00 send, no custom time, bundled across every reminder-eligible category — M11's page phrasing ("default 08:00... custom time TBD") is stale, build against M5's plan instead.

## Task checklist (for whoever owns this — you, or a lead session)
1. Before each module's PR (M2–M8) is merged, check its command-facing behaviour against this catalogue and the shared contract above.
2. Resolve the "still open" table row-by-row as the dependent module needs it — don't let a worker agent guess a product answer.
3. Keep the catalogue updated to reflect what actually shipped, not what was originally proposed — this file is the thing that goes stale fastest if nobody owns it.
4. Sign off on final command names/syntax before BotFather registration.
5. Before Phase 2 (billing): finalize the Stars price, the subscription state machine, and the "reachable even when capped" requirement for `/paysupport`/`/subscription`.
6. Before whenever `/export` and `/history` editing come back into scope: revisit this catalogue's stub entries and turn them back into real contracts.

## Related
- Notion: [M11 — Telegram Commands & Contracts](https://app.notion.com/p/3d2ef5e61bdd8137bb85d262060d7930)
- Referenced by every command-facing module. Revises M7's routing order — see `M7-telegram-gateway.md`.
