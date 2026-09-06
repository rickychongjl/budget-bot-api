import type { Instant, Tier, UserId } from '../ports/common';

/**
 * Telegram Stars purchase / renewal / refund — Phase 2 (master plan §3, M8 "Out of
 * scope"). The port lives here with its only implementation so M7's billing-command
 * stubs compile against a real contract and report the feature as *unavailable* —
 * never as a silently succeeding no-op. Nothing here touches `entitlement`.
 */

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

export const BILLING_NOT_CONFIGURED_MESSAGE =
  'Premium subscriptions are not yet available. Everything on the Free plan keeps working.';

function notConfigured(): BillingOutcome {
  return { status: 'not_configured', code: 'BILLING_UNAVAILABLE', message: BILLING_NOT_CONFIGURED_MESSAGE };
}

export class NotConfiguredStarsBilling implements StarsBillingService {
  async onPurchase(_userId: UserId, _event: StarsPaymentEvent): Promise<BillingOutcome> {
    return notConfigured();
  }

  async onRenewal(_userId: UserId, _event: StarsPaymentEvent): Promise<BillingOutcome> {
    return notConfigured();
  }

  async onRefund(_userId: UserId, _chargeId: string, _receivedAt: Instant): Promise<BillingOutcome> {
    return notConfigured();
  }
}
