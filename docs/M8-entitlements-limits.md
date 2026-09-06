# M8 — Entitlements & Limits

**Phase:** 1 (parallel, policy logic only — billing is Phase 2 by design)
**Notion status:** Agreed entitlement policy, 5 Sep 2026. Tier limits, message counting, category capacity, and downgrade conditions are resolved. Stars pricing resolved by explicit deferral; billing implementation is its own milestone.
**One-line scope:** One place that answers "is this user allowed to do this?", and one place that records what they've paid for.

---

## Depends on
- **M1** for the `EntitlementService` port stub.
- **M2** for `app_user` (FK) and the immutable timezone that anchors the daily-quota reset.

## Depended on by
- **M7** calls `admitMessage` as the very first gate after user resolution, before any routing.
- **M3** checks category-creation capacity here before creating/reactivating a category.
- **M4** budgets are unrestricted by tier (any permitted category can carry one); this module only gates *category count* and *reminder count*, not budget-setting itself.
- **M5** checks reminder-category capacity here before enabling a reminder.
- **M11**'s refusal-code table (`DAILY_MESSAGE_LIMIT`, `FAIR_USE_LIMIT`, `CATEGORY_LIMIT`, `REMINDER_CATEGORY_LIMIT`, `TIER_REQUIRED`) is built directly against this module.

---

## Owns
- Tables `entitlement`, `usage_counter`
- The tier check every gated action calls
- Inbound message quotas, category capacity, reminder-category limits, requested-downgrade validation, fair-use rate limiting
- Telegram Stars purchase/renewal/expiry/refund and `/paysupport` — **Phase 2, not this pass**

## Does not own
- Any feature's behaviour — this module says yes/no, the feature module does the work.
- Cost measurement for its own sake — **M9** owns metrics; this module owns only the counters that gate behaviour.

---

## Agreed tier limits — 5 Sep 2026
| Entitlement | Free | Premium |
|---|---|---|
| User messages to the bot per day | 5 for now | No daily cap; fair use applies |
| Customisable categories | 10 | 30 total |
| Categories with reminders enabled | 1 | 5 |
| Individual category budgets | every permitted category | every permitted category |
| Fair-use rate limiter | 20 / rolling 2h | 20 / rolling 2h |

The reminder limit counts categories *with reminders enabled*, not categories with budgets — Free can budget all 10 categories while reminding only 1.

## Resolved policy (build all of this — it's settled, not draft)
- **Timezone is immutable**, enforced at M2's write path; this module just relies on it for quota-reset timing.
- **Daily quota counts inbound user messages** (including expense-logging and command inputs). Bot replies, scheduled reminders, and allowance text in confirmations do **not** count.
- **Failed user sends consume no quota.** Count one successfully admitted message once, by M7's stable message identity — Telegram redelivery is the same message, not a second one.
- **Fair use**: both tiers, 20 admitted messages per rolling 2 hours, independent of the Free daily cap.
- **Category capacity — updated 5 Sep (M3 round 4), supersedes the original page:** capacity counts **non-archived** categories only. Archiving a category is itself gated by M3 (only allowed if it has no transaction in the current budget cycle) — once archived, it frees its slot immediately regardless of earlier-cycle history; reactivating it re-consumes a slot, subject to the tier limit. See M3's plan, "Category removal and the capacity loophole," for the full mechanism — this module just compares the count M3 supplies against the tier limit.
- **Requested downgrade**: user must be at ≤10 categories and ≤1 reminder-enabled category before an in-bot downgrade completes; otherwise refuse and state what must be removed first.

## Implementation defaults (explicit assumptions, build these — not additional undecided policy)
- **Window/burst**: rolling 120-minute window per user, UTC timestamps. Up to 20 may arrive together if the window has capacity; no separate shorter burst cap. An event exactly 120 minutes old leaves the window — **not** a fixed wall-clock 2-hour bucket (that would allow a 40-message boundary burst).
- **Daily reset**: midnight in the user's immutable IANA timezone.
- **Recovery messaging**: fair-use refusal: *"You've reached 20 messages in 2 hours. Try again in {minutes} minutes."* — computed from the earliest counted message's expiry, not a restarted full wait. Free daily refusal: *"You've used your 5 messages today. Your limit resets at {local reset time}."*
- **Combined limits**: if both are exhausted, return the later eligibility time and explain both.
- **Accounting boundary**: quota counts received user messages, not successful ledger writes — an admitted command, clarification answer, or invalid input still consumes a slot; a rejected over-limit attempt does not.
- **Non-message events**: bot replies, reminders, payment notifications, and Telegram redeliveries never consume quota. Callback queries are distinct events — command routing must not let button-driven actions bypass the same admission gate as typed messages.

## Public interface
```typescript
interface EntitlementService {
  tierOf(userId: UserId): Promise<'free' | 'premium'>
  admitMessage(userId: UserId, messageId: string, receivedAt: Instant):
    Promise<AdmissionResult>   // admitted, duplicate, or refused with retryAt — one atomic check-and-record
  assertAllowed(userId: UserId, action: GatedAction): Promise<void>
  assessDowngrade(userId: UserId): Promise<DowngradeEligibility>
}
```
**Message admission must be one atomic operation**, not separate check/count calls that could race under concurrent webhook redelivery.

## Provisional schema — revise before implementing (not an unresolved policy question, just an implementation task)
```sql
create table entitlement (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references app_user(id) on delete cascade,
  tier                     text not null check (tier in ('free','premium')),
  source                   text not null check (source in ('telegram_stars','manual')),
  external_subscription_id text,
  status                   text not null check (status in ('active','expired','cancelled','refunded')),
  current_period_end       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index entitlement_one_active on entitlement (user_id) where status = 'active';

-- Revise usage_counter to match resolved policy: stable message-ID accounting
-- and rolling-window support, not the original entries/llm_calls metrics.
create table usage_counter (
  user_id       uuid not null references app_user(id) on delete cascade,
  message_id    text not null,             -- M7's stable logical message ID
  admitted_at   timestamptz not null,      -- for rolling-window + daily-reset queries
  local_date    date not null,             -- user-local date at admission, for the daily cap
  primary key (user_id, message_id)
);
create index usage_counter_window on usage_counter (user_id, admitted_at);
create index usage_counter_daily on usage_counter (user_id, local_date);
```

---

## Task checklist
1. Migration for `entitlement` + revised `usage_counter` (`db/schema/entitlement.ts`).
2. Implement `admitMessage` as a single atomic transaction: check daily quota (Free only) + rolling window together, then insert the `usage_counter` row keyed by `message_id` — a duplicate `message_id` (Telegram redelivery) is a no-op admit, not a second count.
3. Implement `assertAllowed` for: category creation (10/30, all-categories-count), reminder enablement (1/5), requested downgrade (≤10 categories AND ≤1 reminder-enabled).
4. Implement `assessDowngrade` returning what must be removed if not yet eligible — never silently delete anything itself (that's M3's job, and out of scope this pass anyway per the M3 gap).
5. Implement `tierOf` reading from `entitlement` with `status = 'active'`; **revalidate on every gated action** rather than trusting a cached tier — don't let Premium stay active indefinitely just because downgrade cleanup is incomplete.
6. Stub the Stars purchase/renewal/refund handlers to compile against the port but return "not configured" — real implementation is Phase 2.

## Invariants to enforce
- Message admission is exactly-once per stable `message_id`, even under concurrent redelivery.
- A rejected over-limit attempt never itself consumes a slot.
- Category/reminder capacity checks are atomic with the domain write they gate — a concurrent category addition can't slip past a downgrade check mid-flight.
- `tierOf` reflects `current_period_end`/`status`, re-checked every call, not cached indefinitely.

## Tests to write
- 21st message within a rolling 120-minute window is refused; the 22nd is admitted once the earliest of the 20 ages out — not a fixed-bucket reset.
- A burst of 21 messages exactly at the 2-hour wall-clock boundary cannot exploit a fixed-bucket implementation (this is explicitly the failure mode the window design is protecting against).
- Free's 6th message of the local day is refused with the correct local reset time; Premium's 100th message that day is admitted.
- Duplicate `message_id` (simulated Telegram redelivery) admits once, not twice.
- Requested downgrade at 11 categories / 2 reminders is refused with correct cleanup instructions; at 10/1 it's eligible.
- Concurrent category-creation attempts near the cap can't both succeed and exceed it.

## Genuinely open — needs your call (per master plan §5.4), not an engineering default
- [ ] Telegram Stars price and its AUD approximation — explicitly deferred; needs live pricing validation before Phase 2, not before this pass.
- [ ] Whether custom reminder times differ by tier (affects M5, tracked here since it's a tier-gate question).
- [ ] Interactive `/history` editing: Premium-gated (as proposed) or both tiers.

## Out of scope for this pass
- Real Telegram Stars checkout, subscription state machine, `/paysupport` case handling — Phase 2. Build the commands as stubs (M7's job) that this module reports as "unavailable," not as silently-succeeding no-ops.

## Related
- Notion: [M8 — Entitlements & Limits](https://app.notion.com/p/3d1ef5e61bdd81b183c9f51eea7f1b37)
- Called by M7 (every message), M3 (category creation), M5 (reminder enablement).
