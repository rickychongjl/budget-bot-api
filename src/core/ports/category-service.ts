import type { Id, Instant, UserId } from '../shared/common';

/**
 * M3 — Categories (the category half of Categories & Ledger). **Proposed by M2, owned
 * by M3** — see build-log (M2, open questions).
 *
 * M3's plan owns the `category` table and M11 routes `/categories` to M3, but
 * `LedgerService` (the only M3 port M1 committed) has no category methods at all.
 * M2's onboarding step 4 has to create "Food" and the user's other categories through
 * *some* M3 contract rather than writing M3's table, so this is the smallest surface
 * that lets it do so. M3 is free to rename/widen; only M2's onboarding calls it today.
 *
 * Capacity: `create`/`reactivate` are expected to call M8's `assertAllowed` themselves
 * (M3 checklist step 5) — M2 also calls it before `create` during onboarding so the
 * refusal arrives before any write, but M3 is the atomic gate.
 */
export interface Category {
  id: Id;
  userId: UserId;
  name: string;
  normalizedName: string;
  sortOrder: number;
  isArchived: boolean;
  createdAt: Instant;
}

export interface CategoryService {
  /** Non-archived categories only unless `includeArchived` is set; `sort_order` then name. */
  list(userId: UserId, opts?: { includeArchived?: boolean }): Promise<readonly Category[]>;

  /**
   * Creates a category. Must reject a duplicate `normalized_name` via the DB unique
   * constraint (M3 schema) and enforce tier capacity via M8 (`CATEGORY_LIMIT`).
   */
  create(userId: UserId, name: string): Promise<Category>;

  /** Rename an existing category after applying M3's normalization and duplicate-name rules. */
  rename(userId: UserId, categoryId: Id, name: string): Promise<Category>;

  /**
   * Archive — gated on "no transactions in the current period" (master plan §5.1).
   * During onboarding there are no transactions, so this is how a user drops the
   * pre-seeded starter before finishing.
   */
  archive(userId: UserId, categoryId: Id): Promise<void>;
}
