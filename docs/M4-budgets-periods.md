# M4 — Budgets & Periods

**Phase:** 2 (parallel with M3 — coordinate schema, see below)
**Notion status:** Agreed v1 direction, 4 Sep 2026 — required for the Telegram alpha.
**One-line scope:** Owns what "this budgeting cycle" means and how much the user has agreed to spend in it. Every other module that needs a period boundary asks this one; nobody does date maths independently.
**Reconciled 5 Sep (round 3):** the round-2 expansion to three period types (monthly/fortnightly/weekly) is **reverted**. Ricky: *"actually lets skip the complexity and only say that we can have a monthly budget."* Monthly-only, as originally scoped. The one lasting change from round 2 is cosmetic: the anchor is stored as a full `period_anchor_date` (the "budget start date" M2's onboarding collects) rather than a bare `period_start_day` smallint — see "Period derivation" below for why that's still worth keeping even monthly-only.

---

## Depends on
- **M1** for conventions and the `BudgetService` port stub.
- **M2** for `app_user` (FK), and `period_anchor_date` as a setting (the "budget start date" collected during onboarding). Account-wide, not per-category.
- **M3** for `category` (FK from `budget.category_id`). **Schema coupling runs both ways: M3's `transaction.budget_period_id` FKs into this module's `budget_period` table.** Coordinate the schema PR with whoever's building M3 — see master plan §4.

## Depended on by
- **M3** asks this module (`ensurePeriod`) for the `budget_period_id` covering a transaction's date, on every `record`.
- **M5** reads a period's cap from here (`activeBudgets`, the snapshot in `budget_period`) as the denominator for the daily-allowance formula.
- **M8** checks category/budget capacity against this module's `budget` rows.
- **M11**'s `/budget` and `/stats` command contracts are built directly on this module's read/write shape.

---

## Owns
- Tables `budget`, `budget_period`
- Period derivation from a date + the user's `period_anchor_date` (monthly only — one cycle, account-wide)
- Lazy materialisation of periods
- `/budget` command behaviour

## Does not own
- What was actually spent — **M3**.
- How much can be spent today — **M5**, which reads a period's cap from here.
- Tier category capacity / reminder-category limits — **M8**.

---

## The two-table split, and why it matters
`budget` is the **standing rule** — the cap for a category as it stands right now. `budget_period` is the **snapshot** — that cap, frozen, for one specific period. A user raising their groceries cap in September must not retroactively change what August looked like; if the allowance formula divided by a live cap, every historical figure would move whenever the cap changed. Snapshotting gives the allowance formula a denominator that cannot shift mid-period.

## Schema
```sql
create table budget (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references app_user(id) on delete cascade,
  category_id      uuid references category(id) on delete set null,
  cap_minor_units  bigint not null check (cap_minor_units > 0),
  currency_code    char(3) not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index budget_one_active_per_category
  on budget (user_id, category_id) where is_active;

create table budget_period (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references app_user(id) on delete cascade,
  budget_id        uuid not null references budget(id) on delete cascade,
  period_key       text not null,           -- '2026-09', labelled by start month
  period_start     date not null,
  period_end       date not null,           -- inclusive
  cap_minor_units  bigint not null,         -- snapshot at materialisation
  created_at       timestamptz not null default now(),
  unique (budget_id, period_key)
);
create index budget_period_lookup on budget_period (user_id, period_start, period_end);
```

## Period derivation — monthly only

Monthly-only, per Ricky's round-3 call — the round-2 proposal to support fortnightly/weekly cycles (and the branching `period_type` schema that went with it) is dropped entirely.

The only design question left is what the anchor looks like. The original Notion page anchored on `period_start_day` (an integer 1–28). Round 2 introduced `period_anchor_date` (a real `date`) so a phase-fixing reference date would exist for fortnightly/weekly cycles. Now that only monthly exists, a bare `period_start_day` would technically be enough again — but `period_anchor_date` is what M2's onboarding already asks for ("budget start date" is a more natural onboarding question than "which day of the month, 1–28"), and it derives `period_start_day` trivially (`anchorDate.day`, capped at 28). **Keeping `period_anchor_date` as the stored field, dropping the `period_type` column entirely** (there's only one type, so a column for it is dead weight) is the cleanest option — this is my call, flag if you'd rather revert all the way to a bare `period_start_day` smallint.

```typescript
function periodFor(localDate: LocalDate, anchorDate: LocalDate): Period {
  const startDay = anchorDate.day <= 28 ? anchorDate.day : 28   // capped at 28 — 29/30/31 would give February no valid start date some years
  const anchorMonth = localDate.day >= startDay ? localDate.month : localDate.month.minus(1)
  const start = anchorMonth.atDay(startDay)
  const end   = start.plusMonths(1).minusDays(1)
  return { key: anchorMonth.format('yyyy-MM'), start, end }
}
```
- Labelled by start month (a period running 25 Sep–24 Oct is `2026-09`).
- **Derived, not stored** — changing `period_anchor_date` re-buckets all history correctly and instantly. Never add a period key column to `transaction`.
- This is the same logic the original monthly-only page specified; only the column name backing `startDay` has changed (`anchorDate.day` instead of a separately-collected `period_start_day`).

## Materialisation (lazy, no cron)
```
1. A caller needs the period for a date (usually M3 recording a transaction, or M5 computing a morning target).
2. Derive the period via periodFor().
3. insert into budget_period ... on conflict (budget_id, period_key) do nothing,
   snapshotting the active budget's current cap, then select.
```
The upsert matters: two concurrent messages at a period boundary would otherwise race. **There is deliberately no cron for this** — a nightly job opening periods for every user does work proportional to the whole user base to serve the few users active that day. A user who logs nothing in October simply has no October row; `/stats` for October must treat "no row" as "cap applies, nothing spent," not as an error.

## Changing a cap
`/budget groceries 600` updates the standing `budget` **and** the current period's snapshot — the user means "my budget is 600 now," not "from next month." Past periods are untouched. The daily allowance recomputes against the new figure the **following morning**; it never retroactively rewrites today's already-persisted target (see M5).

**Resolved 5 Sep — messaging when a cap is lowered below what's already spent this period:** the confirmation explicitly warns the user that the change doesn't retroactively affect transactions already made this period. If the category has a reminder enabled, no separate immediate notification goes out — the user simply sees the corrected figure in the next scheduled reminder run (M5).

## Public interface
```typescript
interface BudgetService {
  periodFor(userId: UserId, localDate: LocalDate): Promise<Period>
  ensurePeriod(userId: UserId, budgetId: Id, localDate: LocalDate): Promise<BudgetPeriod>
  activeBudgets(userId: UserId): Promise<Budget[]>

  setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget>
  deactivate(userId: UserId, budgetId: Id): Promise<void>
}
```

---

## Task checklist
1. Migration for `budget` + `budget_period` (coordinate with M3's `category`/`transaction` migration). **Also coordinate with M2's agent on the `period_anchor_date` column on `app_user`** — it lives in M2's schema file but this module is the one that interprets it; confirm the exact shape together before either side writes a migration against it.
2. Implement `periodFor` as a **pure function with an injected clock** in `core/domain` — no DB access — so it's unit-testable at arbitrary instants.
3. Implement `ensurePeriod` with the upsert-then-select pattern above; verify it's race-safe under concurrent calls for the same `(budget_id, period_key)`.
4. Implement `setCap` — writes both the standing `budget` row and, if a `budget_period` already exists for the current period, updates its snapshot too (only the current period's snapshot, never a past one). Include the "doesn't affect past transactions" warning in the confirmation copy.
5. Implement `deactivate` — `is_active = false`, preserving historical `budget_period` rows (they still reference the now-inactive `budget`).
6. Confirm both tiers can set a budget on any permitted category, independent of reminder selection (5 Sep decision) — the `budget_one_active_per_category` index is unaffected by which categories have reminders enabled; that's M5/M8's concern, not this module's.
7. Implement `/budget` with no arguments to show the **current-period snapshot** (confirmed 5 Sep — matches what the user experiences today; only differs from the standing rule right after a mid-period change, in which case show both).

## Invariants to enforce
- `period_start <= period_end`; consecutive periods for one budget are contiguous, no gap, no overlap.
- A `budget_period` snapshot is never updated except by an explicit cap change in the *current* period.
- All period maths runs through `periodFor` — no other module derives a period, and there's no second implementation hiding in a query.
- Period maths is pure and takes an injected clock — testable at arbitrary instants and across DST transitions.

## Tests to write
- `periodFor` at every boundary: anchor day 28 in a 28/29/30/31-day month, and DST transitions in Australian timezones.
- Concurrent `ensurePeriod` calls for the same date don't produce two `budget_period` rows (race test against the unique constraint).
- `setCap` mid-period: past periods' snapshots are byte-for-byte unchanged; current period's snapshot updates; a new period materialised afterward picks up the new standing cap.
- A user who logs nothing in a given period: `/stats`-equivalent query treats the missing `budget_period` row as "cap applies, zero spent," not an error.
- `/budget` with no arguments returns the current-period snapshot.

## Open decisions — resolved 5 Sep (round 3)
- [x] Fortnightly/weekly periods — **reverted, out of scope.** Monthly only, per Ricky's round-3 instruction. (Round 2 had briefly put these in scope; that's undone.)
- [x] Anchor shape — **`period_anchor_date` (a real date), `period_type` column dropped** — my call, see "Period derivation" above; flag if you'd rather go back to a bare `period_start_day` smallint.
- [x] Messaging when a cap is lowered below what's already spent — **warn in the confirmation that it doesn't affect past transactions**; a reminder-enabled category picks up the change in its next scheduled run, no separate notification.
- [x] `/budget` with no arguments — **shows the current-period snapshot.**

## Out of scope for this pass
- Any UI/reply formatting — that's M7, reading this module's data.
- Fortnightly/weekly (or any) period types other than monthly — reverted, see above.
- Per-category period types — moot, there's only one cycle, account-wide.

## Related
- Notion: [M4 — Budgets & Periods](https://app.notion.com/p/3d1ef5e61bdd8177bf61f4614afd5cf2)
- Coordinate schema with M3. Read by M5, M8, M11.
