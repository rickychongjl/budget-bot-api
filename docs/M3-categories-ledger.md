# M3 — Categories & Ledger

**Phase:** 2 (parallel with M4 — coordinate schema, see below)
**Notion status:** Agreed v1 direction, 4 Sep 2026, category-capacity discussion added 5 Sep — required for the Telegram alpha. One real gap, now partially resolved (see below).
**One-line scope:** The system of record for what the user spent. Every confirmed transaction enters through this module; nothing else writes to the ledger.
**Reconciled 5 Sep:** the category-removal/capacity loophole is now **fully resolved** (round 4) — see "Category removal" below for the final mechanism. Multiple-transaction and retention open items confirmed as originally scoped; backdating floor is **confirmed** (round 3: account creation date). **Round 5: `/export` (CSV export) is deferred** — Ricky's marked it out of scope for this pass (Story 7, per M11). `exportCsv` is not built this build; see "Money" area below and the task checklist.

**Build status (8 Sep 2026, `phase-2` branch):** built, together with M4 in one PR.
Every checklist item below is done except `exportCsv`, which is deferred by design.
Decisions taken while building, all recorded in `docs/build-log.md`:
- **`category_name_snapshot` is not in the migration** — the plan flagged it as a
  proposal to confirm before shipping; confirmed *skipped*. It arrives with the
  deferred real-removal feature that actually needs it.
- `CategoryService` moved out of the temporary `core/ports/` holding pen into
  `core/ledger/`, and gained `findByName`, `countActive` and `reactivate`.
- `RefusalError` moved from `core/identity/errors.ts` to `core/shared/errors.ts`, as
  M2's own header anticipated once a second module threw it.
- `UserSettings` gained `accountCreatedOn` so M3 can enforce the backdating floor
  without reading `app_user`.

---

## Depends on
- **M1** for conventions and the `LedgerService` port stub.
- **M2** for `app_user` (FK) and settings context.
- **M4** for period resolution — this module asks M4 which period a date belongs to; it never derives that itself. **Schema coupling: `transaction.budget_period_id` FKs into M4's `budget_period` table, and M4's `budget.category_id` FKs back into this module's `category` table.** Coordinate the schema PR with whoever's building M4 — see master plan §4.

## Depended on by
- **M5** reads `spendInPeriod` / `spentOn` as its only read paths into the ledger — both already exclude `income` and net out `refund` by construction.
- **M6** hands this module validated transaction candidates to record.
- **M7** renders confirmations and `/history`/`/stats`/`/export` output from this module's data.
- **M8** checks category/reminder capacity against this module's category count before allowing creation.
- **M2**'s `exportAccount` delegates the actual CSV pull here.

---

## Owns
- Tables `category`, `transaction`
- Recording, correcting, deleting transactions
- Money representation rules
- History and CSV export (**CSV export deferred this pass, round 5 — see below**)

## Does not own
- Turning text into a transaction candidate — **M6**.
- Caps and periods — **M4**.
- Tier limits and message rate limiting — **M8**. (There's no separate monthly transaction-entry cap; the daily quota is about inbound *messages*, not ledger writes.)

---

## Schema
```sql
create table category (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user(id) on delete cascade,
  name            text not null,
  normalized_name text not null,
  sort_order      integer not null default 0,
  is_archived     boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (user_id, normalized_name)
);

create table transaction (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references app_user(id) on delete cascade,
  category_id         uuid references category(id) on delete set null,
  budget_period_id    uuid references budget_period(id) on delete set null,
  direction           text not null check (direction in ('expense','income','refund')),
  amount_minor_units  bigint not null check (amount_minor_units > 0),
  currency_code       char(3) not null,
  occurred_on         date not null,        -- user-local calendar date
  occurred_at         timestamptz not null,
  merchant_display    text,
  normalized_merchant text,
  note                text,
  raw_text            text,                 -- original user message
  parse_route         text not null check (parse_route in ('command','mechanical','mapping','llm')),
  parse_confidence    numeric(4,3),
  status              text not null default 'confirmed'
                                  check (status in ('confirmed','pending','deleted')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index transaction_user_date on transaction (user_id, occurred_on desc)
  where status = 'confirmed';
create index transaction_period on transaction (budget_period_id)
  where status = 'confirmed';
```

**Recommended addition for this pass** (not in the original Notion schema — see the gap in §"Category removal" below): add a `category_name_snapshot text` column to `transaction`, populated at write time from `category.name`, following the exact precedent M3 already sets for `currency_code`. This is what makes a *real* category removal (not just archive) possible later without breaking `/history`/`/export` rendering. Flag this to whoever owns M3/M4 schema coordination before finalizing the migration — it's a proposal, confirm before shipping.

## Money
Amounts are `bigint` minor units — `8240`, never `82.40`. Floating point never touches a monetary value at any layer. The decimal→minor-units conversion happens once, at the boundary where the parser's output becomes a domain value, and validates scale against the currency's exponent first — `82.404` is a validation failure, not a rounding opportunity. `currency_code` is copied onto each transaction (not joined from the user) so history still renders correctly if the user's default currency ever changes. No conversion in v1 — a message in another currency triggers a clarification.

## Direction semantics — the one part of this module that changes numbers
- **`expense`** — counts against the category cap. Default.
- **`refund`** — reduces spend against the cap (money for an earlier expense that never really left).
- **`income`** — recorded, but never offsets any cap. Salary inflating a grocery cap on payday would make the daily allowance meaningless on exactly the day it matters most.
A reimbursement is `refund` when it maps to a known expense, `income` when it doesn't. When the parser can't tell (M6's `Alex gave me 80` example), clarify — never guess.

## Public interface
```typescript
interface LedgerService {
  record(userId: UserId, candidate: ValidatedCandidate): Promise<Transaction>
  correct(userId: UserId, transactionId: Id, patch: TransactionPatch): Promise<Transaction>
  softDelete(userId: UserId, transactionId: Id): Promise<void>
  deleteLast(userId: UserId): Promise<Transaction | null>

  history(userId: UserId, page: PageRequest): Promise<Page<Transaction>>
  exportCsv(userId: UserId): Promise<ReadableStream>

  spendInPeriod(userId: UserId, budgetPeriodId: Id, upTo?: LocalDate): Promise<MinorUnits>
  spentOn(userId: UserId, localDate: LocalDate): Promise<MinorUnits>
}
```
`spendInPeriod`/`spentOn` return `expenses - refunds`, excluding `income` by construction — M5 can't accidentally get the wrong total.

---

## Task checklist
1. Migration for `category` + `transaction` (coordinate with M4's `budget`/`budget_period` migration — see Depends on).
2. Implement `record`:
   a. Resolve `occurred_on` from `occurred_at` + the user's timezone (from M2), once, at write time.
   b. Ask M4 (`ensurePeriod`) for the `budget_period_id` covering `occurred_on`, materialising it if needed.
   c. Resolve category — create only if the user explicitly confirmed a new name; never invent one silently.
   d. Insert `status = 'confirmed'`. **Steps b–d in one DB transaction** — a partially-written ledger row that no period owns must never be visible to a budget query.
   e. Notify M5 to recalculate `available_today` (not `daily_target` — that's frozen, see M5).
3. Implement `correct`/`softDelete`/`deleteLast`. `deleteLast` picks by `created_at` (most recent action), not `occurred_on` (most recent date) — `/delete` means "the one I just typed."
4. Implement `history` (paginated) — build this now. **`exportCsv` is deferred this pass (round 5, Story 7)** — keep the method on `LedgerService`'s interface (so the contract compiles and M7 has something to stub against) but don't implement the streaming/CSV-assembly logic yet; M7 stubs `/export` to "not yet available." When it does get built: streamed, not buffered (a Worker has 128 MB); columns date, direction, amount, currency, category, merchant, note; no internal IDs, no `raw_text`; and **it must scope strictly to the requesting `userId`** — Ricky flagged this explicitly as a data-breach concern before the deferral, and it stays a required test case whenever this ships.
5. Enforce category capacity: check with M8 before creating or reactivating a category, including user-confirmed categories arriving via the parsing flow. **The count M8 checks against is simply non-archived categories** (see "Category removal" above) — archived categories never count, so this module's count query needs no special carve-out; M8 just compares it to the tier limit.
6. Implement the archive rule above: **`archive` first asks M4 for the current period's bounds, then rejects the archive if any transaction referencing the category has `occurred_on` within that period** — with a clear user-facing message telling them to try again next cycle. If none exist, the archive proceeds and the slot frees immediately (no special flag needed — the category is simply no longer counted, per step 5). **Do not build real removal/merge for used categories this pass** — that's a separate deferred feature, unrelated to this archive-eligibility gate.

## Category removal and the capacity loophole — resolved 5 Sep (round 4)
The Notion page originally called this out as unresolved: *"introduce an explicit remove/merge operation distinct from archive... finalize the removal contract before implementing cleanup. Never silently delete financial history to meet a tier limit."* Archiving preserved history but still counted against capacity, so it couldn't satisfy a downgrade on its own. Rounds 2–3 explored two candidate mechanisms (a lifetime zero-transactions rule, and a separate month-scoped active-category set) without settling on one. **Ricky's round-4 answer picks a third, simpler option and closes this out:**

**Final rule: a category can only be archived if it has no transactions in the current budget cycle (period).** If any transaction referencing the category has `occurred_on` within the current period, the archive action is rejected outright — the user has to wait until next cycle. If it has none in the current period, archiving proceeds, even if the category has transaction history from earlier periods.

**What this means for capacity:**
- **Archived categories never count toward tier capacity, full stop.** No "used vs. never-used" carve-out is needed — capacity is simply a count of non-archived categories. This is a simpler rule than either of the round-2/3 candidates.
- The loophole (add a category, transact against it, hit the cap, archive it, add a near-duplicate, repeat) is closed because you can't archive something you've transacted against *this cycle* — the earliest you could free that slot is next period, which is a real cost, not a free bypass.
- **Note this is more permissive across cycles than the round-2/3 proposals:** a category used heavily in past periods but untouched in the *current* one can be archived and its slot freed immediately, history and all. That's Ricky's deliberate choice here, not an oversight.

**Mechanism:**
- `archive(categoryId)` asks M4 for the current period's bounds (`periodFor` for today), then checks whether any `transaction` row for that category has `occurred_on` inside `[period_start, period_end]`. If yes → reject with a clear message ("can't archive Food — you've logged an expense in it this cycle; try again next cycle"). If no → archive, and the category immediately stops counting toward capacity.
- No zero-transactions-ever check, and no month-scoped "active set" query — this is entirely a gate on the archive action itself, not a parallel capacity-counting scheme.

**Still deferred to Phase 2 (alongside billing), unchanged from the original scoping:** real removal of a category *with* transaction history — someone who's logged 200 transactions against "Coffee," wants it gone, and isn't willing to wait for an empty cycle to archive it. This is what the in-bot downgrade path needs and still doesn't have. When you do build it, the `category_name_snapshot` column above is the proposed mechanism: null out `category_id` via the existing `on delete set null`, but keep the display label on the transaction row itself so `/history`/`/export` don't need a live join to a category that no longer exists. Leave the in-bot downgrade path stubbed ("not yet available") until then.

**Also required whenever a category is removed or archived** (agreed 5 Sep, applies today, not just to future real removal): disable every reminder selection referencing it and invalidate pending scheduled sends/retries through M5 — coordinate this so a failure can't leave a removed category eligible for scheduling. M5 must independently recheck category existence/reminder-eligibility immediately before dispatch; invalidating the queue entry alone isn't sufficient.

## Invariants to enforce
- `amount_minor_units` is always positive; direction carries the sign.
- A confirmed transaction with a category that has an active budget always has a `budget_period_id`.
- `raw_text` is retained for every parsed transaction, so a correction can show the user what they originally sent.
- Every read used for budget maths filters `status = 'confirmed'`.
- Every query behind `history` (and `exportCsv`, once it's built — see task checklist) is scoped to the requesting `userId` — no code path can return another user's rows.
- Archiving is blocked while a category has any transaction in the current period; once archived (regardless of earlier-period history) it never counts toward capacity.

## Tests to write
- Money boundary: `82.404` rejected, `82.40` → `8240` exactly, for AUD (2 decimal places).
- `record` atomicity: a simulated failure between period resolution and insert leaves no orphaned row.
- `deleteLast` picks by `created_at` even when a backdated entry has a later `created_at` but earlier `occurred_on`, and vice versa.
- Refund vs. income: `spendInPeriod` nets refunds out, ignores income, in the same period.
- Category archive: **attempting to archive a category with a transaction in the current period is rejected**, with a clear message; **archiving a category with no transaction in the current period succeeds and frees its slot immediately**, even if it has transaction history from earlier periods. Reactivating an archived category re-consumes a capacity slot (subject to the tier limit).
- `history` scoping: called with one user's ID, never returns another user's rows. (`exportCsv` gets the same test once it's built — deferred this pass.)
- Backdating floor (confirmed, account creation date): an `occurred_on` before `app_user.created_at`'s local date is rejected; on or after is accepted.

## Open decisions — resolved 5 Sep
- [x] Multiple transactions in one message — **confirmed: only one transaction per message this pass**, ask the user to split them.
- [x] Split transactions across categories — **confirmed: same reasoning, one transaction per message.**
- [x] Backdating window — **confirmed 5 Sep (round 3): account creation date is the floor.** Ricky: *"can do account creation date too."* Reject a backdated `occurred_on` earlier than `app_user.created_at`'s local date.
- [x] Retention for soft-deleted rows — **confirmed: keep forever for now**, a cleanup job can be added later (M9's territory, not blocking this module).

## Out of scope for this pass
- Category removal/merge (real deletion) — see gap above.
- Split transactions across multiple categories.
- **`exportCsv` / `/export`** — deferred, round 5 (Story 7, per M11). Keep the port signature, skip the implementation.

## Related
- Notion: [M3 — Categories & Ledger](https://app.notion.com/p/3d1ef5e61bdd81528175fe7d19c70195)
- Coordinate schema with M4. Read by M5, M6, M7, M8.
