import { BILLING_NOT_CONFIGURED_MESSAGE } from '../../../core/entitlements/billing';
import type { Tier } from '../../../core/shared/common';
import type { CommandHandler } from '../command-router';
import { refusalText } from '../render';

/**
 * The billing commands — `/upgrade`, `/subscribe`, `/subscription`, `/paysupport`.
 *
 * All four are real replies, not stubs, and none of them invents copy. The tier line
 * comes from M8 (`tierOf`) and the "not available" line is M8's own
 * `BILLING_NOT_CONFIGURED_MESSAGE` — if Phase 2 changes what unconfigured billing
 * says, it changes in one place and this module follows.
 *
 * M11's rule for `/upgrade`: "If unconfigured, return unavailable without generating a
 * dummy invoice." Nothing here creates an invoice.
 */

function planLine(tier: Tier): string {
  return tier === 'premium' ? "You're on Premium." : "You're on the Free plan.";
}

/**
 * `/upgrade` and `/subscribe` are one answer under two names: M11 lists both, and
 * users reach for either word. Built from one factory so they cannot drift apart.
 */
function billingOffer(name: 'upgrade' | 'subscribe'): CommandHandler {
  return {
    name,
    description: 'Premium and payment options',
    exemptFromAdmission: false,
    requiresAccount: true,

    async handle(context) {
      const tier = await context.services.entitlements.tierOf(context.requireUserId());
      return { text: `${planLine(tier)}\n\n${BILLING_NOT_CONFIGURED_MESSAGE}` };
    },
  };
}

export const upgradeCommand = billingOffer('upgrade');
export const subscribeCommand = billingOffer('subscribe');

/**
 * `/subscription` — M11: "No subscription is a normal state with an upgrade option."
 * So this is an empty state with a way forward, not a refusal; the `NO_SUBSCRIPTION`
 * wording is reused, but nothing is thrown.
 *
 * Admission-exempt: M11 requires the management route to work when ordinary product
 * messages are capped.
 */
export const subscriptionCommand: CommandHandler = {
  name: 'subscription',
  description: 'Your current plan',
  exemptFromAdmission: true,
  requiresAccount: true,

  async handle(context) {
    const tier = await context.services.entitlements.tierOf(context.requireUserId());
    if (tier === 'premium') {
      return { text: `${planLine(tier)}\n\nIt renews automatically. /paysupport if something looks wrong.` };
    }
    return {
      text: `${planLine(tier)}\n\n${refusalText('NO_SUBSCRIPTION')} Try /upgrade when you want more.`,
    };
  },
};

/**
 * `/paysupport` — Telegram requires a payment-support route for any bot that takes
 * Stars, and M11 says it is "never gated by Premium or daily allowance quota". It
 * needs no account for the same reason: someone who cannot get in is exactly who
 * needs the address.
 */
export const paysupportCommand: CommandHandler = {
  name: 'paysupport',
  description: 'Help with a payment',
  exemptFromAdmission: true,
  requiresAccount: false,

  async handle(context) {
    return {
      text:
        "Payments aren't live yet, so there's nothing to refund or cancel.\n\n" +
        `If you need a hand, contact ${context.services.supportContact}.`,
    };
  },
};
