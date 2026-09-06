import type { Instant, RefusalCode, Tier, UserId } from './common';

/**
 * M8 — Entitlements & Limits. One place that answers "is this user allowed to do
 * this?". Policy only this pass — Stars billing is Phase 2.
 *
 * Interface lifted verbatim from `docs/M8-entitlements-limits.md` ("Public interface").
 * The four method signatures are the contract. The supporting types below were
 * refined by the M8 agent (M1 build-log: "the owning module may refine"); the
 * implementation lives in `core/entitlements/`.
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
  ): Promise<AdmissionResult>;

  /** Throws a typed refusal (`EntitlementRefusal`) if the action would exceed a capacity limit. */
  assertAllowed(userId: UserId, action: GatedAction): Promise<void>;

  assessDowngrade(userId: UserId): Promise<DowngradeEligibility>;
}

// ---------------------------------------------------------------------------
// Telegram Stars billing — Phase 2. Present so M7's `/upgrade`, `/subscribe`,
// `/subscription`, `/paysupport` stubs have a port to compile against; this pass's
// only implementation answers `not_configured` for everything.
// ---------------------------------------------------------------------------

export interface StarsPaymentEvent {
  /** Telegram `telegram_payment_charge_id` — the stable identity for dedupe/refund. */
  chargeId: string;
  /** Telegram `subscription_expiration_date`, if the payment is a subscription. */
  periodEnd: Instant | null;
  amountStars: number;
  receivedAt: Instant;
}

export type BillingOutcome =
  | { status: 'applied'; tier: Tier; currentPeriodEnd: Instant | null }
  | { status: 'not_configured'; code: 'BILLING_UNAVAILABLE'; message: string };

export interface StarsBillingService {
  onPurchase(userId: UserId, event: StarsPaymentEvent): Promise<BillingOutcome>;
  onRenewal(userId: UserId, event: StarsPaymentEvent): Promise<BillingOutcome>;
  onRefund(userId: UserId, chargeId: string, receivedAt: Instant): Promise<BillingOutcome>;
}
