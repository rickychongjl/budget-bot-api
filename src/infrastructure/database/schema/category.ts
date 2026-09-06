/**
 * M3 — Categories & Ledger owns this file (category half).
 *
 * Tables: `category`.
 *
 * Split out from `transaction.ts` on purpose: M4's `budget.category_id` FKs into
 * `category`, while `transaction.budget_period_id` FKs into M4's `budget_period` —
 * the coupling runs both ways, so M3 and M4 coordinate their schema PR (master plan §4).
 *
 * Conventions: see `identity.ts` header. Specifics from M3's plan:
 *   - `unique (user_id, normalized_name)`.
 *   - `is_archived boolean not null default false`; capacity = count of non-archived rows.
 */
export {};
