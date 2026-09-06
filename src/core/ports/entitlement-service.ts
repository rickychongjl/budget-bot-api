import type { Id, Instant, RefusalCode, Tier, UserId } from './common';

/**
 * M8 — Entitlements & Limits. One place that answers "is this user allowed to do
 * this?". Policy only this pass — Stars billing is Phase 2.
 *
 * Interface lifted verbatim from `docs/M8-entitlements-limits.md` ("Public interface").
 * Stub only.
 */

export type AdmissionResult =
  | { outcome: 'admitted' }
  /** A Telegram redelivery of an already-counted message — a no-op admit, not a second count. */
  | { outcome: 'duplicate' }
  | { outcome: 'refused'; code: RefusalCode; retryAt: Instant; message: string };

export type GatedAction =
  | { kind: 'create_category' }
  | { kind: 'reactivate_category' }
  | { kind: 'enable_reminder' }
  | { kind: 'request_downgrade' };

export interface DowngradeEligibility {
  eligible: boolean;
  /** What must be removed first when not yet eligible (≤10 categories AND ≤1 reminder). */
  mustRemove: {
    categories: number;
    reminderCategories: number;
  };
}

export interface EntitlementService {
  tierOf(userId: UserId): Promise<Tier>;

  /** One atomic check-and-record — daily quota + rolling window + dedupe by `messageId`. */
  admitMessage(
    userId: UserId,
    messageId: string,
    receivedAt: Instant,
  ): Promise<AdmissionResult>;

  /** Throws a typed refusal if the action would exceed a capacity limit. */
  assertAllowed(userId: UserId, action: GatedAction): Promise<void>;

  assessDowngrade(userId: UserId): Promise<DowngradeEligibility>;
}
