import type { Instant, RefusalCode, Tier, UserId } from '../shared/common';

/**
 * M8 — Entitlements & Limits. One place that answers "is this user allowed to do
 * this?". Policy only this pass — Stars billing is Phase 2 (`./billing.ts`).
 *
 * This is the module's incoming port, owned by the module it belongs to (it used to
 * live in the shared `core/ports/` folder). The four method signatures are lifted
 * verbatim from `docs/M8-entitlements-limits.md` ("Public interface"); the supporting
 * types were refined by the M8 agent (M1 build-log: "the owning module may refine").
 * The implementation is `DefaultEntitlementService` (`./default-entitlement-service.ts`).
 */

export type AdmissionResult =
  | { outcome: 'admitted' }
  /** A Telegram redelivery of an already-counted message — a no-op admit, not a second count. */
  | { outcome: 'duplicate' }
  | {
      outcome: 'refused';
      /** `DAILY_MESSAGE_LIMIT` or `FAIR_USE_LIMIT` — whichever clears *later* when both are hit. */
      code: RefusalCode;
      /** Earliest instant at which a new message would be admitted. */
      retryAt: Instant;
      /** User-facing recovery text (M8 "Recovery messaging"), rendered by M7. */
      message: string;
    };

/**
 * Options for `admitMessage`. Added by M7 stage 4B — the two limits this call enforces
 * had to become separable.
 *
 * Free admits 5 messages per user-local day, and a callback tap is an admitted event
 * (M8 "Non-message events"), so `/start` plus the five onboarding answers is six
 * events: a brand-new Free user was refused `DAILY_MESSAGE_LIMIT` before they could
 * finish signing up. Ricky's ruling (11 Sep 2026): **the daily cap is a product limit
 * on a working account and is waived until onboarding completes; fair use is abuse
 * protection and is never waived.**
 *
 * The message is still recorded either way — `usage_counter.counts_toward_daily`
 * carries the distinction, so an exempt message still fills the rolling window but
 * does not eat the day's quota once the account is live.
 */
export interface AdmitMessageOptions {
  /**
   * Skip **only** the Free daily cap for this message. Defaults to false. The caller
   * that sets it is M7's dispatcher, for a user whose `onboarding_step !== 'done'`.
   * There is deliberately no option to skip fair use.
   */
  skipDailyCap?: boolean;
}

export type GatedAction =
  | { kind: 'create_category' }
  | { kind: 'reactivate_category' }
  | { kind: 'enable_reminder' }
  | { kind: 'request_downgrade' };

export interface CapacityCounts {
  /** Non-archived categories — the only ones that count (M3 round 4). */
  categories: number;
  /** Categories with a reminder enabled (not categories with budgets). */
  reminderCategories: number;
}

export interface DowngradeEligibility {
  eligible: boolean;
  /** The tier the assessment was made against. A Free user has nothing to downgrade. */
  tier: Tier;
  current: CapacityCounts;
  /** Free's limits — the target the user must fit inside. */
  limits: CapacityCounts;
  /** What must be removed first when not yet eligible (≤10 categories AND ≤1 reminder). Zeros when eligible. */
  mustRemove: CapacityCounts;
  /** Cleanup instructions for the user; empty string when eligible. Never acted on by M8 itself. */
  message: string;
}

/**
 * The typed refusal `assertAllowed` throws. M7 renders `code` via M11's refusal-code
 * table and may show `message` verbatim. `retryAt` is set only for time-based limits.
 */
export class EntitlementRefusal extends Error {
  override readonly name = 'EntitlementRefusal';
  readonly code: RefusalCode;
  readonly retryAt: Instant | null;

  constructor(code: RefusalCode, message: string, retryAt: Instant | null = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}

export function isEntitlementRefusal(error: unknown): error is EntitlementRefusal {
  return error instanceof EntitlementRefusal;
}

export interface EntitlementService {
  tierOf(userId: UserId): Promise<Tier>;

  /** One atomic check-and-record — daily quota + rolling window + dedupe by `messageId`. */
  admitMessage(
    userId: UserId,
    messageId: string,
    receivedAt: Instant,
    options?: AdmitMessageOptions,
  ): Promise<AdmissionResult>;

  /** Throws a typed refusal (`EntitlementRefusal`) if the action would exceed a capacity limit. */
  assertAllowed(userId: UserId, action: GatedAction): Promise<void>;

  assessDowngrade(userId: UserId): Promise<DowngradeEligibility>;
}
