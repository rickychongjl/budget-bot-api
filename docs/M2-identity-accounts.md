# M2 — Identity & Accounts

**Phase:** 1 (parallel, after Phase 0 lands)
**Notion status:** Agreed v1 direction, 4 Sep 2026, onboarding flow and open items revised 5 Sep, then adjusted again 5 Sep (round 3) for M4's monthly-only revert — required for the Telegram alpha
**One-line scope:** Owns who a user *is*, independently of how they reach the bot. Every other module takes an internal `user_id` and never sees a Telegram identifier.
**Reconciled 5 Sep (round 3):** onboarding collects the budget cycle (a single "budget start date," no period-type choice now that M4 is monthly-only), and fills in multiple categories/caps and reminder selections, not just one category. Starter categories are now pre-seeded — **"Food" only**, per Ricky's round-3 instruction (Rent/Mortgage and Utilities dropped). **Onboarding is 5 steps, not 6** — see "Onboarding" below and the note on step count, which is a live question back to Ricky, not a silent decision.

---

## Depends on
- **M1** for schema conventions, `Clock` port, and the `IdentityService` interface stub to fill in.
- **M4**'s finalized `period_anchor_date` contract (step 3 of onboarding collects exactly this value — see M4's plan before wiring this). Monthly-only now (M4 round-3 revert), so there's no separate period-*type* value to collect.
- **M3, M4, and M8** during onboarding step 4 (creating categories and budgets, checked against tier capacity), and **M5/M8** during optional step 5 reminder selection — onboarding actively calls these modules mid-flow, not just after.

## Depended on by
- **M7** resolves every inbound message to an internal user via this module before routing anywhere else.
- **M3, M4, M5, M8** all key their tables off `app_user.id`.
- **M3, M4, M5, M8, M11** all read the four settings this module owns: timezone, currency, period start day, reminder time.
- **M8**'s daily-quota reset and **M5**'s allowance day boundary both depend on the immutable timezone this module stores.

---

## Owns
- Tables `app_user`, `channel_connection`
- The `/start` onboarding conversation and settings commands
- Timezone, currency, `period_start_day`, `reminder_local_time`
- Account export and deletion

## Does not own
- Anything Telegram-shaped (webhook, command parsing, reply formatting) — **M7**.
- Tier and limits — **M8**.

---

## Schema
```sql
create table app_user (
  id                   uuid primary key default gen_random_uuid(),
  timezone             text        not null,               -- IANA after step 1; '' is internal pre-onboarding state
  currency_code        char(3)     not null default 'AUD',
  -- Round 3 (5 Sep): M4 reverted to monthly-only, so the round-2 period_type
  -- column is dropped. period_anchor_date survives as the sole cycle setting —
  -- it's still the "budget start date" collected at onboarding step 3, and M4
  -- derives the monthly start-day from it (anchorDate.day, capped at 28).
  -- Confirm this table-ownership split with M4's agent before building — see M4's plan.
  period_anchor_date   date,       -- the user's "budget start date"; null only before onboarding step 3 completes
  reminder_local_time  time        not null default '07:00',   -- changed from 08:00, 5 Sep
  status               text        not null default 'active'
                                   check (status in ('active','suspended','deleted')),
  onboarding_step      text        not null default 'timezone'
                                   check (onboarding_step in ('timezone','currency','anchor_date','categories','reminders','done')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create table channel_connection (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user(id) on delete cascade,
  channel      text not null check (channel in ('telegram')),
  external_id  text not null,             -- Telegram user id
  chat_id      text not null,             -- where outbound messages go
  username     text,
  is_active    boolean not null default true,
  linked_at    timestamptz not null default now(),
  unique (channel, external_id)
);
create index channel_connection_user on channel_connection (user_id);
```
Keep `external_id` and `chat_id` as separate columns even though they're equal for a Telegram private chat — they diverge the moment a group/channel context appears, and conflating them now breaks that later for no benefit today.

## Public interface
```typescript
interface IdentityService {
  resolve(channel: Channel, externalId: string): Promise<ResolvedUser | null>
  register(channel: Channel, externalId: string, chatId: string, username?: string):
    Promise<ResolvedUser>   // idempotent — re-running /start must not create a second user

  getSettings(userId: UserId): Promise<UserSettings>
  setInitialTimezone(userId: UserId, timezone: string): Promise<void> // set once only
  updateSettings(userId: UserId, patch: Partial<Omit<UserSettings, 'timezone'>>): Promise<UserSettings>

  exportAccount(userId: UserId): Promise<AccountExport>
  deleteAccount(userId: UserId): Promise<void>
}
```
`UserSettings = { timezone, currencyCode, periodAnchorDate, reminderLocalTime }` — the contract the rest of the system depends on. **Changed from the original page:** `periodStartDay` (an integer 1–28) is replaced by `periodAnchorDate` (the "budget start date" onboarding now collects) — same monthly-only cycle as the original page, just a full date instead of a bare day-of-month, since that's the more natural onboarding question and M4 derives the day-of-month from it trivially. There's no `periodType` field — round 2 briefly added one for a three-cycle-length design that's since been reverted (M4 round 3). Confirm this shape with whoever's building M4 before wiring the onboarding step that collects it.

## Onboarding — revised 5 Sep, round 3: 5 steps (see note below on the step-count question)
`/start` now reaches a usable state in **under 5 minutes** (relaxed from "under a minute" — the flow is still longer than the original one-category design, even with the period-type step gone). Order still matters — each answer makes the next question cheaper:
1. **Timezone.** Curated short list of Australian IANA zones as inline buttons, **plus a full IANA search for anything else** (this was "somewhere else" free text before; it's now an actual search, not just a fallback). Asked first, cannot be skipped.
2. **Currency.** Default AUD, confirmed with one tap.
3. **Budget start date.** The anchor date for the user's monthly budget cycle — this becomes `periodAnchorDate` and is handed to M4. (Round 2 had a separate step 4 here for choosing monthly/fortnightly/weekly; that's gone now that M4 is monthly-only — see the note below.)
4. **Fill in budget categories and caps.** No longer just one category — the user adds as many as they want, each with an optional cap, up to their tier's limit (10 Free / 30 Premium). **Pre-seed one obvious starter category — "Food"** (round 3: Rent/Mortgage and Utilities dropped, per Ricky) — rather than a blank slate, which the user can accept, rename, or delete before or during this step. The user cannot continue until there is at least one category and at least one active category budget. Handed to M3/M4.
5. **Optional reminder category selection.** The user may pick categories (up to 1 Free / 5 Premium) for the daily allowance reminder, or finish with none. **No custom reminder time this pass** — every enabled reminder uses a single fixed 07:00 local send (see M5); this step is purely about which category(s), not when.

A returning user who sends `/start` again gets a summary of their settings, not a new account — unchanged.

### Note: step count is 5, not the 6 Ricky asked me to confirm
Ricky's round-3 message asked me to "confirm M2 onboarding is 6 steps now." I can't confirm that honestly: round 2's 6-step flow included a distinct step 4 for picking a period type (monthly/fortnightly/weekly). Now that M4 is back to monthly-only, there's no real choice left to ask about — a step that offers one option with no alternative isn't really onboarding, it's just friction. I've collapsed it out, leaving **5 steps** above. If you actually want a 6th step back — e.g. an explicit "your budget renews monthly, starting on this date" confirmation screen, separate from just collecting the date in step 3 — say so and I'll add it back as a real (if choiceless) step. Otherwise, treat this as resolved at 5.

### "Reset everything" on repeated `/start` — resolved 5 Sep (round 3)
**Confirmed out of scope.** Ricky's round-2 answer ("let's not put this out of scope for now") was a double-negative typo; round 3 clarifies: *"haha I meant lets put this out of scope for now."* No reset path is built — account deletion + re-onboarding already covers a full reset if a user genuinely wants to start over.

---

## Task checklist
1. Migration for `app_user` + `channel_connection` in `db/schema/identity.ts`.
2. Implement `resolve` / `register` — enforce idempotency via the `(channel, external_id)` unique constraint, not an application-level check-then-insert.
3. Implement the 5-step onboarding state machine backing `/start` (see "Onboarding" section above): required timezone → currency → budget start date → at least one category with a budget ("Food" pre-seeded, up to tier limit) → optional reminder category selection. This module collects and hands off values to M3/M4/M5/M8; it doesn't write their tables itself. A returning user who re-sends `/start` gets a settings summary, not a new account. Persist `onboarding_step` so the flow resumes across stateless Worker invocations.
4. **Enforce timezone immutability in this module's write path, not just the Telegram UI.** `setInitialTimezone` succeeds once; every later attempt — via `updateSettings`, a forged callback, or a repeated `/start` — is rejected with `TIMEZONE_IMMUTABLE`. An idempotent replay of the *same* value is not a rejected change. Remove `timezone` from the mutable-settings type entirely so it can't even be attempted through the normal patch path.
5. Implement settings mutation rules:
   - `period_anchor_date` — changing it is a pure re-bucketing of history (periods are derived, not stored — see M4), no data rewrite needed here. (Unchanged in spirit from the original `period_start_day` rule; just applies to the new field.)
   - `currency` — refuse the change once the user has any transaction (call into M3 to check), with an explanation. No currency conversion in v1.
   - `reminder_local_time` — affects only the next scheduled send; never backfills a missed day.
6. **`exportAccount` is deferred this pass (round 5 — `/export` marked deferred, Story 7, see M11 and M3's plans).** Keep the method on `IdentityService`'s interface so the contract compiles, but don't implement the CSV assembly/authorization flow yet — M3's `exportCsv` (which this would delegate to) isn't built this pass either.
7. Implement `deleteAccount` — hard delete. Rely on `on delete cascade` from `app_user` to remove everything except `parse_event`, whose `user_id` gets nulled by M9's FK (`on delete set null`). No soft-delete grace period in v1.

## Invariants to enforce
- Exactly one `app_user` per `(channel, external_id)` — enforced by the DB constraint, never by an app-level race-prone check.
- `register` is idempotent.
- Once timezone is set it cannot change, through any path, ever, including re-run onboarding.
- `timezone` is non-null in storage. A newly registered user temporarily has `''` while `onboarding_step = 'timezone'`; no service may expose or use that sentinel as an operational timezone, and onboarding cannot advance until it is replaced with a valid IANA zone.
- Onboarding cannot complete without at least one category and an active budget for at least one category. Reminder categories are optional.
- No module outside M2 reads `channel_connection` to make a business decision — M7 reads it only to find a `chat_id`.
- Every timestamp written anywhere in the system is UTC; local dates are derived at write time using this module's timezone.

## Tests to write
- Idempotent `register`/`resolve` under concurrent duplicate calls.
- Timezone rejection on every mutation path (`updateSettings`, a simulated forged callback, a second `/start`) — including the case where the "new" value is identical to the stored one but arrives as an explicit patch rather than a no-op.
- Currency change: allowed with zero transactions, refused with one.
- Cascade delete removes every user-owned row across every module's tables except the nulled `parse_event.user_id`.

## Open items — resolved 5 Sep (round 3: Ricky's actual answers)
- [x] Starter categories: **yes, "Food" only** (round 3: Rent/Mortgage and Utilities dropped) — editable/removable during onboarding step 4.
- [x] Timezone picker: **curated AU list + full IANA search** for anything else (not just a free-text fallback — an actual search).
- [x] "Reset everything" on repeated `/start` — **confirmed out of scope**, see the "Onboarding" section above.
- [ ] Onboarding step count: I've built this as **5 steps** (period-type step removed, monthly-only). Ricky's round-3 message asked to confirm 6 — flagged as a live question, see the note under "Onboarding" above.

## Out of scope for this pass
- A second channel's linking/preferred-channel/duplicate-suppression logic — the schema seam (`channel` check constraint) is enough; no behaviour beyond it.

## Related
- Notion: [M2 — Identity & Accounts](https://app.notion.com/p/3d1ef5e61bdd81ed8366ca409f718015)
- Depends on M1 (ports, conventions). Read by M3, M4, M5, M7, M8, M11.
