/**
 * M5 — Daily Allowance & Scheduler (Phase 3, after M3+M4 land).
 *
 * Implements `DailyAllowanceService` (`core/ports/daily-allowance-service.ts`)
 * against `db/schema/allowance.ts`. Owns the allowance formula
 * (`core/domain/allowance.ts`, pure), the self-dispatching cron fan-out, bundled
 * 07:00 delivery, `/today`. Invoked from `src/index.ts`'s `scheduled` handler and
 * an internal `/internal/send-allowance` route guarded by `INTERNAL_DISPATCH_SECRET`.
 *
 * Empty until the M5 agent's PR.
 */
export {};
