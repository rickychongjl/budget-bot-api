/**
 * M5 — Daily Allowance & Scheduler (Phase 3, after M3+M4 land).
 *
 * Implements `DailyAllowanceService` (`./allowance-service.ts`) against
 * `infrastructure/database/schema/allowance.ts`. Owns the allowance formula
 * (`./daily-target.ts`, pure), the self-dispatching cron fan-out, bundled
 * 07:00 delivery, `/today`. Invoked from `src/index.ts`'s `scheduled` handler and
 * an internal `/internal/send-allowance` route guarded by `INTERNAL_DISPATCH_SECRET`.
 *
 * The contract below is fixed; `DefaultAllowanceService` and the repository
 * implementation are empty until the M5 agent's PR.
 */
export type { AllowanceView, DailyAllowanceService, DueSend, SendOutcome } from './allowance-service';
export { computeDailyTarget } from './daily-target';
