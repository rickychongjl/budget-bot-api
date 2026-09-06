/**
 * M8 — Entitlements & Limits (Phase 1, policy only — billing is Phase 2).
 *
 * The module's public surface: the incoming `EntitlementService` contract, its
 * default implementation, the outgoing repository/capacity ports, the settled tier
 * limits, the refusal wording and the local-time helpers. No logic lives here.
 *
 * Adapters live outside core:
 *   infrastructure/database/repositories/drizzle-entitlement-repository.ts (production)
 *   test/support/in-memory-entitlement-repository.ts                       (tests)
 *
 * Wiring (M7 / the composition root):
 *
 *   const repository = new DrizzleEntitlementRepository(db);
 *   const entitlements = createEntitlementService({
 *     repository,
 *     capacity: { countActiveCategories, countReminderCategories },  // supplied by M3 / M5
 *     timezoneOf: (id) => identity.getSettings(id).then((s) => s.timezone), // M2
 *     clock,
 *   });
 *
 * M3/M5 make a capacity check atomic with their write via
 * `entitlements.gate(userId, { kind: 'create_category' }, (tx) => tx.insert(...))`.
 */
export { EntitlementRefusal, isEntitlementRefusal } from './entitlement-service';
export type {
  AdmissionResult,
  CapacityCounts,
  DowngradeEligibility,
  EntitlementService,
  GatedAction,
} from './entitlement-service';

export { DefaultEntitlementService, createEntitlementService } from './default-entitlement-service';
export type { EntitlementServiceDeps } from './default-entitlement-service';

export type {
  CapacityReader,
  EntitlementReads,
  EntitlementRepository,
  EntitlementRow,
  EntitlementTransaction,
  TimezoneReader,
  UsageRow,
  UserLockScope,
  WindowUsage,
} from './entitlement-repository';

export { DEFAULT_LIMITS, MINUTE_MS } from './limits';
export type { EntitlementLimits, FairUseWindow, TierLimits } from './limits';

export { BILLING_NOT_CONFIGURED_MESSAGE, NotConfiguredStarsBilling } from './billing';
export type { BillingOutcome, StarsBillingService, StarsPaymentEvent } from './billing';

export {
  ALREADY_FREE,
  categoryLimitRefusal,
  combinedRefusal,
  dailyRefusal,
  downgradeCleanup,
  fairUseRefusal,
  reminderLimitRefusal,
} from './messages';

export {
  addLocalDays,
  formatLocalTime,
  localDateOf,
  localMidnightInstant,
  nextLocalMidnight,
  offsetMsAt,
} from './local-time';
