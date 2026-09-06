import type { Instant, UserId } from '../ports/common';
import type {
  BillingOutcome,
  StarsBillingService,
  StarsPaymentEvent,
} from '../ports/entitlement-service';

/**
 * Telegram Stars purchase / renewal / refund — Phase 2 (master plan §3, M8 "Out of
 * scope"). This implementation exists so M7's billing-command stubs compile against
 * a real port and report the feature as *unavailable* — never as a silently
 * succeeding no-op. Nothing here touches `entitlement`.
 */
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
