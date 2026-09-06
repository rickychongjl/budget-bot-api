/**
 * M8 — Entitlements & Limits (Phase 1, policy only — billing is Phase 2).
 *
 * Implements `EntitlementService` (`core/ports/entitlement-service.ts`) against
 * `db/schema/entitlement.ts`. Owns the tier check, inbound message quotas (5/day
 * Free, 20/rolling-2h both tiers), category/reminder capacity, requested-downgrade
 * validation. `admitMessage` must be one atomic check-and-record.
 *
 * Empty until the M8 agent's PR.
 */
export {};
