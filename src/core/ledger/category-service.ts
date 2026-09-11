import type { Id, Instant, UserId } from '../shared/common';

/**
 * M3 — Categories (the category half of Categories & Ledger).
 *
 * Proposed by M2 during Phase 1 and parked in the temporary `core/ports/` holding
 * pen, because `LedgerService` — the only M3 port M1 committed — has no category
 * methods at all and M2's onboarding step 4 needed *some* M3 contract to create "Food"
 * through rather than writing M3's table. M3 has now claimed it, so it lives with its
 * owning module (CLAUDE.md, "Ports and interfaces"). M5 has since claimed the last
 * resident, `ReminderSelectionService`, so `core/ports/` is gone entirely.
 *
 * Changes M3 made on adopting it: `reactivate` (M8 already gates a
 * `reactivate_category` action, and reviving an archived name has to go through
 * capacity), `findByName` (so name→category resolution uses M3's own normalization
 * rather than each caller re-implementing it), and `countActive` (the number M8's
 * capacity check compares against the tier limit). The four original methods are
 * unchanged, so M2's onboarding still compiles against it as written.
 *
 * Capacity: `create` and `reactivate` gate on M8 atomically with their write — M2 also
 * calls `assertAllowed` first during onboarding so the refusal arrives before any
 * work, but this module is the real gate.
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
   * Resolve a user-typed name through M3's normalization. Absence is expected — a
   * user mistyping a category is ordinary — so this returns null rather than throwing.
   * Archived categories are included, because "you archived that one" is a more useful
   * answer than "no such category".
   */
  findByName(userId: UserId, name: string): Promise<Category | null>;

  /** Non-archived categories — the count M8 compares against the tier limit. */
  countActive(userId: UserId): Promise<number>;

  /**
   * Creates a category. Rejects a duplicate `normalized_name` via the database's
   * unique constraint (M3 schema) and enforces tier capacity via M8
   * (`CATEGORY_LIMIT`). A name that matches an *archived* category is refused with a
   * pointer to `reactivate` rather than silently creating a second row — the unique
   * constraint spans archived rows.
   */
  create(userId: UserId, name: string): Promise<Category>;

  /** Rename an existing category after applying M3's normalization and duplicate-name rules. */
  rename(userId: UserId, categoryId: Id, name: string): Promise<Category>;

  /**
   * Archive — gated on "no transactions in the current period" (master plan §5.1,
   * resolved round 4). Any transaction whose `occurred_on` falls inside the current
   * cycle blocks the archive outright and the user is told to try again next cycle;
   * transaction history from *earlier* cycles does not block it. Once archived the
   * category never counts toward capacity again.
   *
   * During onboarding there are no transactions at all, so this is also how a user
   * drops the pre-seeded starter before finishing.
   */
  archive(userId: UserId, categoryId: Id): Promise<void>;

  /** Un-archive, re-consuming a capacity slot (subject to the tier limit, via M8). */
  reactivate(userId: UserId, categoryId: Id): Promise<Category>;
}
