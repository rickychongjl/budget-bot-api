/**
 * M8 — Entitlements & Limits (Phase 1, policy only — billing is Phase 2).
 *
 * Implements `EntitlementService` (`core/ports/entitlement-service.ts`) against
 * `db/schema/entitlement.ts`. Owns the tier check, inbound message quotas (5/day
 * Free, 20/rolling-2h both tiers), category/reminder capacity, requested-downgrade
 * validation. `admitMessage` is one atomic check-and-record.
 *
 * Wiring (M7 / the composition root):
 *
 *   const store = new DrizzleEntitlementStore(db);
 *   const entitlements = createEntitlementService({
 *     store,
 *     capacity: { activeCategoryCount, reminderCategoryCount },   // supplied by M3 / M5
 *     timezoneOf: (id) => identity.getSettings(id).then((s) => s.timezone), // M2
 *     clock,
 *   });
 *
 * M3/M5 make a capacity check atomic with their write via
 * `entitlements.gate(userId, { kind: 'create_category' }, (tx) => tx.insert(...))`.
 */
export { EntitlementServiceImpl, createEntitlementService } from './service';
export type { EntitlementServiceDeps } from './service';
export { DEFAULT_LIMITS, MINUTE_MS } from './limits';
export type { EntitlementLimits, FairUseWindow, TierLimits } from './limits';
export type {
  CapacityReader,
  EntitlementReads,
  EntitlementRow,
  EntitlementStore,
  EntitlementTx,
  TimezoneReader,
  UsageRow,
  UserLockScope,
  WindowUsage,
} from './ports';
export { DrizzleEntitlementStore } from './drizzle-store';
export type { DbExecutor } from './drizzle-store';
export { MemoryEntitlementStore } from './memory-store';
export { NotConfiguredStarsBilling, BILLING_NOT_CONFIGURED_MESSAGE } from './billing';
export {
  addLocalDays,
  formatLocalTime,
  localDateOf,
  localMidnightInstant,
  nextLocalMidnight,
  offsetMsAt,
} from './local-time';
