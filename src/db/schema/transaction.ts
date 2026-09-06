/**
 * M3 — Categories & Ledger owns this file (ledger half).
 *
 * Tables: `transaction`.
 *
 * Conventions: see `identity.ts` header. Specifics from M3's plan:
 *   - `category_id` -> `category(id) on delete set null`;
 *     `budget_period_id` -> `budget_period(id) on delete set null` (M4-owned table).
 *   - `direction text check (direction in ('expense','income','refund'))`.
 *   - `amount_minor_units bigint not null check (amount_minor_units > 0)` — sign lives
 *     in `direction`, never in the amount.
 *   - `occurred_on date` (user-local) is separate from `occurred_at timestamptz`.
 *   - `parse_route text check (... in ('command','mechanical','mapping','llm'))`.
 *   - `status` defaults `'confirmed'`; hot indexes are partial: `where status = 'confirmed'`.
 *   - Proposed (confirm with M3/M4 before finalising): `category_name_snapshot text`,
 *     populated at write time, so a real category removal later doesn't break `/history`.
 */
export {};
