# M4 — Budgets & Periods

**Phase:** 2 (parallel with M3 — coordinate schema, see below)
**Notion status:** Agreed v1 direction, 4 Sep 2026 — required for the Telegram alpha.
**One-line scope:** Owns what "this budgeting cycle" means and how much the user has agreed to spend in it. Every other module that needs a period boundary asks this one; nobody does date maths independently.
**Reconciled 5 Sep (round 3):** the round-2 expansion to three period types (monthly/fortnightly/weekly) is **reverted**. Ricky: *"actually lets skip the complexity and only say that we can have a monthly budget."* Monthly-only, as originally scoped. The one lasting change from round 2 is cosmetic: the anchor is stored as a full `period_anchor_date` (the "budget start date" M2's onboarding collects) rather than a bare `period_start_day` smallint — see "Period derivation" below for why that's still worth keeping even monthly-only.

**Build status (8 Sep 2026, `phase-2` branch):** built, together with M3 in one PR.
Every checklist item below is done. Decisions taken while building, recorded in
`docs/build-log.md`:
- **`period_anchor_date` kept, `period_type` dropped** — the plan's open call, taken
  as written. M2's shipped `app_user` schema already had the column.
- `BudgetService` gained `currentBudgets(userId, localDate)` — the read `/budget` with
  no arguments needs (checklist step 7). It returns the standing rule, the derived
  period, and the snapshot cap (null when nothing has been materialised), so M7 can
  show both figures after a mid-period change without a second call.
- `PeriodMaterialiser<X>` is a separate M4-owned contract that lets M3 materialise a
  period inside its own write transaction without either module depending on Drizzle
  (CLAUDE.md, "Transactions"). It reuses M8's `CapacityReader<X>` / `gate` pattern.

**Restructured 12 Sep 2026 (Ricky's call): the cap is no longer a column on `budget`
or `budget_period`.** It lives in `category_period_cap`, a history keyed by category
and cycle, and a cycle's cap is the row with the greatest key at or before it. See
"Where the cap lives" below; `docs/build-log.md` records why.

---

## Depends on
- **M1** for conventions and the `BudgetService` port stub.
- **M2** for `app_user` (FK), and `period_anchor_date` as a setting (the "budget start date" collected during onboarding). Account-wide, not per-category.
- **M3** for `category` (FK from `budget.category_id`). **Schema coupling runs both ways: M3's `transaction.budget_period_id` FKs into this module's `budget_period` table.** Coordinate the schema PR with whoever's building M3 — see master plan §4.

## Depended on by
- **M3** asks this module (`ensurePeriod`) for the `budget_period_id` covering a transaction's date, on every `record`.
- **M5** reads a period's cap from here (`ensurePeriod` — `BudgetPeriod.capMinorUnits`, resolved from `category_period_cap`) as the denominator for the daily-allowance formula.
- **M8** checks category/budget capacity against this module's `budget` rows.
- **M11**'s `/budget` and `/stats` command contracts are built directly on this module's read/write shape.

---

## Owns
- Tables `budget`, `budget_period`, `category_period_cap`
- Period derivation from a date + the user's `period_anchor_date` (monthly only — one cycle, account-wide)
- Lazy materialisation of periods
- `/budget` command behaviour

## Does not own
- What was actually spent — **M3**.
- How much can be spent today — **M5**, which reads a period's cap from here.
- Tier category capacity / reminder-category limits — **M8**.

---

## Where the cap lives — three tables (restructured 12 Sep)
`budget` is the **standing rule** — this category is budgeted. `budget_period` is a **materialised cycle** — the period a transaction or a daily target hangs off. Neither carries an amount, nor a currency. `category_period_cap` is the **cap history**: a row says "from cycle `period_key` on, this category's cap is `cap_minor_units`", and **a cycle's cap is the row with the greatest key at or before it.**

The original design snapshotted the cap onto `budget_period` at materialisation so a September raise could not rewrite August. It did that job — but only for cycles something had touched. A cycle nobody logged in, ran `/today` in, or was reminded in had no row, and opening it later (a backdated expense) stamped whatever the standing cap was *by then*. Ricky's call, 12 Sep: keep a per-category, per-cycle cap in one place and derive everything else. Under the lookup:

- `setCap` writes the **current cycle's** row (an upsert, so two changes in one cycle leave one row, the later).
- Every later cycle reads that row until a later row supersedes it — the carry-forward, with **no job copying rows at rollover** (the same reason there is no cron opening periods).
- Every earlier cycle keeps the row that governed it, because rows are only ever written for the cycle that is current. A past cycle's cap is immutable by construction.
- A cycle opened late — a backdated expense — gets the cap that applied *then*. Before any row existed, the category had no cap, and M3 records the transaction with a null `budget_period_id` exactly as it would for an uncapped category.
- `deactivate` writes a **null** row for the current cycle, so the last cap does not leak into cycles where there is no budget. Re-adding the budget overwrites it (same cycle) or supersedes it (a later one).

`BudgetPeriod.capMinorUnits` and `BudgetView.capMinorUnits` still exist on the domain types — M5 and M7 did not change — but both are **resolved from the history on every read**, never stored. `Budget` has no cap at all; read amounts through `currentBudgets` or a `BudgetPeriod`.

## Schema
```sql
create table budget (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references app_user(id) on delete cascade,
  category_id      uuid references category(id) on delete set null,
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
  created_at       timestamptz not null default now(),
  unique (budget_id, period_key)
);
create index budget_period_lookup on budget_period (user_id, period_start, period_end);

create table category_period_cap (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references app_user(id) on delete cascade,
  category_id      uuid not null references category(id) on delete cascade,
  period_key       text not null,           -- the cycle this row takes effect from
  cap_minor_units  bigint check (cap_minor_units is null or cap_minor_units > 0),
                                            -- null: removed in this cycle, no cap from here on
  currency_code    char(3) not null,        -- what the cap is in: the account's currency when
                                            -- the row was written (M3's transaction precedent)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (category_id, period_key)
);
create index category_period_cap_user_key on category_period_cap (user_id, period_key);
```
The governing row for a cycle: `where category_id = ? and period_key <= ? order by period_key desc limit 1`. For every category at once: `distinct on (category_id)` with the same ordering. `'YYYY-MM'` keys sort chronologically as text, so both are index scans. Migration `0007` created the table and **backfilled it from the old columns** (snapshots → cycle rows; removed budgets → null rows; active standing caps → the cycle they were last set in) before dropping them; `test/integration/migration-0007-category-period-cap.test.ts` pins that. Migration `0008` then moved `currency_code` from `budget` onto the cap rows — an amount and its denomination on one row, as `transaction` does — backfilling each category's rows from its live budget (else its last removed one, else the account) before dropping the column; `migration-0008-currency-on-cap.test.ts` pins that.

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
3. Resolve the cycle's cap from category_period_cap (greatest key <= this cycle).
   No cap governs it -> no period: null for M3's seam, a refusal for ensurePeriod.
4. insert into budget_period ... on conflict (budget_id, period_key) do nothing,
   then select; attach the resolved cap to the returned BudgetPeriod.
```
The upsert matters: two concurrent messages at a period boundary would otherwise race. **There is deliberately no cron for this** — a nightly job opening periods for every user does work proportional to the whole user base to serve the few users active that day. A user who logs nothing in October simply has no October row; `/stats` for October must treat "no row" as "cap applies, nothing spent," not as an error.

## Changing a cap
`/budget groceries 600` touches the standing `budget` and upserts the **current cycle's** row in `category_period_cap` — the user means "my budget is 600 now," not "from next month." Later cycles read that row until a later one supersedes it; earlier cycles keep theirs, untouched. "Now" includes today's daily figure (**Ricky, 11 Sep 2026** — a raise today should give you more to spend today): once both M4 rows are written, M4 tells M5 (`BudgetAllowanceNotifier.capChanged`) and M5 re-prices today's persisted target from the new cap and spend to the end of yesterday. The re-price never re-sends a reminder already delivered that morning; `/today` simply shows the new number. This is the single exception to M5's "never recomputed for that date" rule, and the only trigger for it — see M5, "Why the morning target is persisted".

The notification is best-effort and runs after M4's own writes: M5 failing leaves the cap correct and today's figure catching up tomorrow, which is where it landed before the hook existed.

**Resolved 5 Sep — messaging when a cap is lowered below what's already spent this period:** the confirmation explicitly warns the user that the change doesn't retroactively affect transactions already made this period. If the category has a reminder enabled, no separate immediate notification goes out — the user sees the corrected figure in the `/budget` confirmation and `/today` immediately (11 Sep), and in the next scheduled reminder run (M5).

## Public interface
```typescript
interface BudgetService {
  periodFor(userId: UserId, localDate: LocalDate): Promise<Period>
  ensurePeriod(userId: UserId, budgetId: Id, localDate: LocalDate): Promise<BudgetPeriod>
  activeBudgets(userId: UserId): Promise<Budget[]>

  currentBudgets(userId: UserId, localDate: LocalDate): Promise<BudgetView[]>   // budget + period + governing cap

  setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget>
  deactivate(userId: UserId, budgetId: Id): Promise<void>
}
```
`Budget` carries no amount (12 Sep). `BudgetPeriod.capMinorUnits` and `BudgetView.capMinorUnits` are resolved from the history on read.

---

## Task checklist
1. Migration for `budget` + `budget_period` (coordinate with M3's `category`/`transaction` migration). **Also coordinate with M2's agent on the `period_anchor_date` column on `app_user`** — it lives in M2's schema file but this module is the one that interprets it; confirm the exact shape together before either side writes a migration against it.
2. Implement `periodFor` as a **pure function with an injected clock** in `core/budgets/period.ts` — no DB access — so it's unit-testable at arbitrary instants.
3. Implement `ensurePeriod` with the upsert-then-select pattern above; verify it's race-safe under concurrent calls for the same `(budget_id, period_key)`.
4. Implement `setCap` — writes both the standing `budget` row and, if a `budget_period` already exists for the current period, updates its snapshot too (only the current period's snapshot, never a past one). Include the "doesn't affect past transactions" warning in the confirmation copy.
5. Implement `deactivate` — `is_active = false`, preserving historical `budget_period` rows (they still reference the now-inactive `budget`).
6. Confirm both tiers can set a budget on any permitted category, independent of reminder selection (5 Sep decision) — the `budget_one_active_per_category` index is unaffected by which categories have reminders enabled; that's M5/M8's concern, not this module's.
7. Implement `/budget` with no arguments to show the **current-period snapshot** (confirmed 5 Sep — matches what the user experiences today; only differs from the standing rule right after a mid-period change, in which case show both). *Superseded 12 Sep: there is one figure, the governing cap for the current cycle.*

**12 Sep 2026 — cap history (done, `phase-4`):**
8. `category_period_cap` table, migration `0007` with its backfill, the cap columns dropped from `budget` and `budget_period`.
9. `findGoverningCap` / `findGoverningCaps` on the repository; `materialise` resolves the cap before it writes a period, and writes none when nothing governs the cycle.
10. `setCap` upserts the current cycle's row; `deactivate` writes a null row for it.
11. M7's `/budget`, `/stats`, `/categories` and M2's account summary read caps through `currentBudgets`; `Budget.capMinorUnits` is gone.

## Invariants to enforce
- `period_start <= period_end`; consecutive periods for one budget are contiguous, no gap, no overlap.
- A `category_period_cap` row is only ever written for the cycle that is current when it is written — so every past cycle's governing row, and therefore its cap, is immutable.
- An active budget always has a governing cap for the current cycle (`setCap` writes it in the same call); `currentBudgets` throws, loudly, if it ever does not.
- All period maths runs through `periodFor` — no other module derives a period, and there's no second implementation hiding in a query.
- Period maths is pure and takes an injected clock — testable at arbitrary instants and across DST transitions.

## Tests to write
- `periodFor` at every boundary: anchor day 28 in a 28/29/30/31-day month, and DST transitions in Australian timezones.
- Concurrent `ensurePeriod` calls for the same date don't produce two `budget_period` rows (race test against the unique constraint).
- `setCap` mid-period: past cycles resolve to the rows that governed them, unchanged; the current cycle resolves to the new cap; a later cycle materialised afterward picks it up.
- The August case: a cap set in July, raised in September, August never touched; a backdated August expense resolves to July's cap. Before any row existed, it resolves to no cap and M3 records a null `budget_period_id`.
- `deactivate` then re-add in a later cycle: the cycles between resolve to no cap.
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
