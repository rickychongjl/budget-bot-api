import type { Tier } from '../shared/common';

/**
 * Agreed tier limits — `docs/M8-entitlements-limits.md`, 5 Sep 2026. Settled policy,
 * not configuration: the values are injectable only so tests can exercise the
 * combined-limits branch (unreachable under the real numbers, since Free's 5/day
 * makes 20/2h impossible to hit).
 */
export interface TierLimits {
  /** Inbound user messages per user-local day. `null` = no daily cap (fair use still applies). */
  dailyMessages: number | null;
  /** Non-archived categories. */
  categories: number;
  /** Categories with a reminder enabled. */
  reminderCategories: number;
}

export interface FairUseWindow {
  /** Admitted messages allowed inside one window. */
  maxMessages: number;
  /** Rolling window length in milliseconds. A message exactly this old has left the window. */
  windowMs: number;
}

export interface EntitlementLimits {
  tiers: Record<Tier, TierLimits>;
  /** Applies to both tiers, independently of the daily cap. */
  fairUse: FairUseWindow;
}

export const MINUTE_MS = 60_000;

export const DEFAULT_LIMITS: EntitlementLimits = {
  tiers: {
    free: { dailyMessages: 5, categories: 10, reminderCategories: 1 },
    premium: { dailyMessages: null, categories: 30, reminderCategories: 5 },
  },
  fairUse: { maxMessages: 20, windowMs: 120 * MINUTE_MS },
};
