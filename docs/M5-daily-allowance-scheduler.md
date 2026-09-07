# M5 — Daily Allowance & Scheduler

**Phase:** 3 (after M3+M4 land)
**Notion status:** Agreed v1 direction, 4 Sep 2026 — the product's differentiator. Schema/delivery gap from the 5 Sep multi-category decision is now **resolved**: bundled delivery, single fixed 07:00 local send.
**One-line scope:** Turns a budgeting-cycle cap into a single number the user can act on today, delivered before they overspend rather than after.
**Reconciled 5 Sep:** Ricky's answered the open questions here directly — bundle the reminder categories into one message (not one send per category, reversing the earlier recommendation), default the send time to a fixed 07:00 local for everyone (moved from 08:00, and no custom times), never suppress the reminder even if the user already logged something, and include days-left-in-cycle in the message text.

---

## Depends on
- **M1** for the `Clock` port, the `DailyAllowanceService` port stub, and the self-dispatching-cron pattern forced by the Workers Free plan's 10ms CPU / 50-subrequest limits.
- **M3** (`spendInPeriod`, `spentOn`) for spend totals — already net of refunds, excluding income.
- **M4** (`activeBudgets`, `budget_period`) for caps and period boundaries.
- **M2** for the user's immutable timezone (day boundary) and reminder time.

## Depended on by
- **M7** delivers every scheduled allowance message via `MessageSender`, and appends `available_today` to every logging confirmation.
- **M8** gates whether `/today` itself is admitted as a quota-counted message (the allowance figure *in* a bot reply never counts).
- **M11**'s `/today` and `/remind` command contracts are built directly against this module's read/write shape.

---

## Owns
- Table `daily_allowance_send`
- The allowance formula
- The cron trigger and its fan-out
- `/today` and the allowance line appended to every logging confirmation

## Does not own
- Spend totals — **M3**. Caps/period boundaries — **M4**. Message delivery — **M7**.

---

## Schema — resolved 5 Sep: per-category targets, bundled delivery

The Notion page's original schema was one row per `(user_id, local_date)` — a single scalar target for the whole user. The 5 Sep tier decision (both tiers can budget multiple categories, with a reminder enabled on 1 of them for Free / 5 for Premium) made that shape wrong: **allowance targets are persisted per category**, independent of whether that category has a reminder enabled at all (an unreminded budgeted category still needs a correct `/today` figure). Ricky's also resolved *how delivery works*: **bundled into one message, not one send per category.**

```sql
create table daily_allowance_send (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references app_user(id) on delete cascade,
  category_id              uuid not null references category(id) on delete cascade,
  local_date               date not null,
  daily_target_minor_units bigint not null,
  budget_period_id         uuid not null references budget_period(id) on delete cascade,
  delivery_status          text not null default 'not_applicable'
                             check (delivery_status in ('not_applicable','pending','sent','failed','skipped')),
  attempts                 smallint not null default 0,
  sent_at                  timestamptz,
  created_at               timestamptz not null default now(),
  unique (user_id, category_id, local_date)
);
create index daily_allowance_send_pending
  on daily_allowance_send (delivery_status) where delivery_status = 'pending';
```
One row per `(user, category, date)` regardless of delivery shape — that part of the earlier recommendation stands. `delivery_status` now has an extra state: **`not_applicable`** is the default and applies to a target computed for a category with no reminder enabled (e.g. via an on-demand `/today` compute) — it's never going to be sent, so it shouldn't show up as `pending` in the retry index. Only reminder-eligible categories' rows ever move through `pending → sent/failed/skipped`.

**Delivery is one bundle per user per send-time, covering every reminder-eligible category at once:**
1. At send time, gather every reminder-eligible category for the user; ensure each has a row for today (insert `pending` if it doesn't exist yet, compute the target).
2. Revalidate each candidate row immediately before building the message (category retained, reminder still enabled, budget still active) — drop any that fail.
3. If nothing survives revalidation, mark the surviving `pending` rows (if any were already inserted) `skipped` and send nothing.
4. Otherwise render **one message** covering every surviving category, call M7's `MessageSender` once, and mark every row included in that message `sent`/`failed` **together** — it was one Telegram call with one outcome, so the rows in the bundle share that outcome (all `sent`, or all left `pending` with `attempts` incremented for a retryable failure).
A category that's budgeted but has no reminder enabled never enters this pipeline at all — its row stays `not_applicable`, populated only when something (like `/today`) asks for it directly.

---

## Formula (unchanged, applies per category/budget)
```javascript
remaining    = period_cap - (expenses - refunds) in the period, to the end of yesterday
days_left    = period_end - today_local + 1        // includes today
daily_target = max(0, floor(remaining / days_left))
```
Through the day: `available_today = daily_target - spent_today`. May go negative; shown negative.

## Why the morning target is persisted — the single most important decision here
`daily_target` is computed once per category per date, written, and **never recomputed for that date**. If it were recomputed live from current spend, overspending at lunch would immediately spread across the remaining days, `available_today` would quietly stay positive, and the user would never see they'd gone over. Persisting means today has a fixed budget: going over is visible today as a negative number, and the correction arrives tomorrow from a genuinely smaller remaining balance. **Recalculation on a transaction change touches `available_today` only — never `daily_target`.**

## Backfill rule
If the user's offline or the cron misses a day, the missed day is **not** backfilled. `daily_target` is only ever computed for the current local date.

## Scheduling under the Workers Free plan
10ms CPU per invocation, 50 subrequests per invocation — one tick cannot loop over every due user. **Since the default reminder time is now a fixed 07:00 for everyone (no per-user customisation), every eligible user is due in the same ~15-minute window each day** — the fan-out ceiling matters even more than it would with staggered custom times.
```
cron: every 15 minutes
  1. one indexed query: users whose local time now matches reminder_local_time (07:00 fixed)
     AND who have at least one reminder-eligible category without a sent/skipped row for today
  2. for each due user -> subrequest to this Worker's own /internal/send-allowance
     (fresh invocation, fresh 10ms budget)
  3. each invocation: gather the user's reminder-eligible categories -> compute/insert target rows ->
     revalidate -> build one bundled message -> ask M7 to deliver once -> mark the bundle's rows sent/failed/skipped together
```
**Every 15 minutes, not hourly** — Adelaide/Darwin sit at UTC+9:30; an hourly tick would deliver a 07:00 message at 06:30 or 07:30. The self-dispatch isn't premature optimisation — it's the difference between the free plan working at all. **Ceiling: 50 due users per tick**, ample for alpha; the day it binds is the day Workers Paid (US$5/month) is justified. `/internal/send-allowance` is reachable only from the Worker itself, guarded by a shared secret header, never routed publicly.

## Category removal and scheduled reminders — agreed 5 Sep, must be built now
- A removed category gets no further scheduled reminders. Removal (in M3) disables its reminder selection and invalidates pending jobs/retries here.
- Due-selection (step 1 above) is only a preliminary check. **Immediately before building the bundle, revalidate that each candidate category still exists, is retained, has an enabled reminder, and has an active budget.** Apply the same check on every retry.
- **This is a bundle, so it can partially empty**: drop ineligible categories from the message and send only the remaining eligible ones. If the bundle becomes empty (every category dropped), mark the delivery `skipped` and send nothing — don't recreate dropped categories from a cached job.
- Coordinate removal with final dispatch admission so a job can't pass a stale check and be dispatched after removal commits.
- A reminder already handed to Telegram before removal commits is an in-flight delivery, not a future scheduled send — removal doesn't recall messages already sent.

## Delivery failures (unchanged from the page)
- **User blocked the bot (403)** → mark `skipped`, set `channel_connection.is_active = false` (via M2/M7), stop trying.
- **Rate limited (429)** → leave `pending`, next tick retries; after 3 `attempts`, mark `failed`.
- **Transient/5xx** → same as rate limited.

## Public interface
```typescript
interface DailyAllowanceService {
  findDue(now: Instant, limit: number): Promise<DueSend[]>   // now (user, category) pairs, not just users
  computeAndSend(userId: UserId, categoryId: Id): Promise<SendOutcome>

  availableToday(userId: UserId, categoryId?: Id): Promise<AllowanceView[]>  // all budgeted categories if omitted
}

type AllowanceView = {
  categoryId: Id
  dailyTarget: MinorUnits
  spentToday: MinorUnits
  availableToday: MinorUnits   // may be negative
  periodEnd: LocalDate
  daysLeft: number
}
```
When no row exists yet for today (user joined this afternoon, or reminder time hasn't arrived), `availableToday` computes the target on demand and persists it, so the morning message and the day's first `/today` always agree.

## Message shape
For a **logging confirmation** (single category, unchanged): one sentence, one number, no preamble — *"You can spend $18 on food today to stay on budget."* Negative figures state the number plainly and say what tomorrow looks like — consequence, not a scolding.

For the **scheduled bundled reminder** (new shape, 5 Sep): one line per eligible category, plus a closing line stating days remaining in the current cycle — e.g. *"You can spend $18 on Food and $42 on Fun today to stay on budget. 12 days left in this cycle."* Negative figures within the bundle stay visible and plain, same as the single-category case. The days-left figure comes straight off the domain formula's `daysLeft` — no separate calculation needed.

Suppression was considered and explicitly rejected: **the reminder still sends even on a day the user already logged an expense before 07:00.**

---

## Task checklist
1. Migration for the resolved `daily_allowance_send` (per-category targets, `not_applicable` default status).
2. Implement `periodFor`-consuming, pure `computeTarget(remaining, daysLeft): MinorUnits` in `core/allowance/daily-target.ts`, injected-clock, unit-testable without a DB.
3. Implement the cron handler: due-user query → subrequest fan-out → `/internal/send-allowance` handler that gathers reminder-eligible categories, ensures/insert target rows, revalidates, builds one bundled message, calls M7's `MessageSender` once, marks the bundle's rows sent/failed/skipped together.
4. Implement the pre-send revalidation (category exists/retained/reminder-enabled/active budget) as a guard that can drop individual categories from a bundle without failing the whole send.
5. Implement `availableToday` with on-demand compute-and-persist for a category with no row yet today (status `not_applicable` if it has no reminder, since it'll never be sent).
6. Wire the "notify M5" call from M3's `record` (recalculates `available_today`, never `daily_target`).
7. Implement the bundled + single-category message renderers per the "Message shape" section, including the days-left line in the bundled case.

## Invariants to enforce
- At most one `daily_allowance_send` per `(user_id, category_id, local_date)`.
- `daily_target` for a given `(user, category, date)` is written once, never updated.
- `days_left` always includes today, so the last day of a period divides by 1, never 0.
- The formula lives in a pure domain function with an injected clock — unit-tested at period boundaries, DST transitions, half-hour offsets.
- Every row included in one bundled send shares that send's outcome — never partially `sent` and partially `pending` for the same bundle/attempt.
- A category with no reminder enabled never transitions out of `not_applicable`.

## Tests to write
- Formula at `days_left = 1` (last day of period) and at period rollover (M4 is monthly-only, round 3 — no need to test other cycle lengths).
- Two concurrent inserts for the same `(user, category, date)` — unique constraint prevents a double-send.
- A transaction recorded mid-day changes `available_today` but not the persisted `daily_target` for that date.
- A category removed after being queued for a bundle is dropped from that bundle at dispatch, not before; the remaining eligible categories in the bundle still send; a bundle that empties out entirely is marked `skipped`, not `sent` or `failed`.
- Adelaide/Darwin (UTC+9:30) reminder fires within the intended 15-minute tick window around 07:00 local, not 30 minutes off.
- A user with 5 reminder-enabled categories (Premium) gets exactly one Telegram message at 07:00 covering all 5, not 5 separate messages.
- Suppression: a user who logs an expense at 06:00 still gets the 07:00 reminder.

## Open decisions — resolved 5 Sep
- [x] Bundled vs. per-category delivery — **bundled**, one message covering every reminder-eligible category.
- [x] Custom reminder times — **no**, fixed 07:00 local for every user, no tier distinction.
- [x] Suppress the scheduled message if the user already logged before reminder time — **no, always send.**
- [x] Message on day 1 of a new period (large `daysLeft`) — **report the true figure, no special-casing.**

## Out of scope for this pass
- Custom per-category or per-user reminder times (fixed 07:00 for everyone).

## Related
- Notion: [M5 — Daily Allowance & Scheduler](https://app.notion.com/p/3d1ef5e61bdd81959690f830d5c89bf3)
- Depends on M2, M3, M4. Delivered via M7. Gated by M8.
