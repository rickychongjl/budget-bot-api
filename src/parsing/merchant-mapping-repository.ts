import type { Id, Instant, UserId } from '../core/ports/common';
import type { MerchantMapping, MerchantMappingSource } from './types';

/**
 * Stage 4 (M6 "End-to-end flow"): merchant memory — the outgoing port only. The
 * Drizzle implementation lives in
 * `src/infrastructure/database/repositories/drizzle-merchant-mapping-repository.ts`
 * (CLAUDE.md: concrete Drizzle repositories belong under `infrastructure/`).
 *
 * The implementation is the ONLY writer of `merchant_category_mapping`, and its
 * write method is named for the one situation that may call it — after the user
 * explicitly confirmed or corrected a category. There is no `upsertFromLlm`; the
 * pipeline cannot express that intent.
 */
export interface ConfirmedMapping {
  userId: UserId;
  normalizedMerchant: string;
  displayMerchant: string;
  categoryId: Id;
  source: MerchantMappingSource;
}

export interface MerchantMappingRepository {
  /** Exact match on `(user_id, normalized_merchant)` — no fuzzy matching in v1. */
  find(userId: UserId, normalizedMerchant: string): Promise<MerchantMapping | null>;

  /**
   * Insert or update a mapping the user has explicitly confirmed/corrected.
   * On conflict the category, display name and source are replaced (`user_corrected`
   * wins over an older `user_confirmed`), `times_used` is kept.
   */
  saveConfirmed(mapping: ConfirmedMapping, now: Instant): Promise<MerchantMapping>;

  /** Bump `times_used` / `last_used_at` after a mapping hit was used to record. */
  markUsed(id: Id, now: Instant): Promise<void>;

  remove(userId: UserId, normalizedMerchant: string): Promise<void>;
}
