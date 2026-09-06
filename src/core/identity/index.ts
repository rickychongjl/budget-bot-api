/**
 * M2 — Identity & Accounts (Phase 1).
 *
 * Implements `IdentityService` (`core/ports/identity-service.ts`) and
 * `ChannelConnectionDirectory` against `db/schema/identity.ts`, plus the 5-step
 * `/start` machine (`OnboardingService`). Timezone immutability, the settings mutation
 * rules, and hard account deletion live in `IdentityServiceImpl`; the persistence seam
 * is `IdentityRepository` (Drizzle in production, in-memory under test).
 *
 * Wiring (M7 does this):
 *   const repo = new DrizzleIdentityRepository(db);
 *   const identity = new IdentityServiceImpl(repo, clock, ledger);
 *   const onboarding = new OnboardingService({ identity, entitlements, categories, budgets, reminders, clock });
 */
export type {
  AppUserPatch,
  AppUserRecord,
  IdentityRepository,
  OnboardingStep,
  RegisterOutcome,
  SetTimezoneOutcome,
  UserStatus,
} from './repository';
export { DrizzleIdentityRepository } from './drizzle-repository';
export { IdentityServiceImpl, normaliseCurrency } from './identity-service';
export type { OnboardingStateStore } from './identity-service';
export { OnboardingService, STARTER_CATEGORY, normaliseName } from './onboarding';
export type {
  AccountSummary,
  CategorySummary,
  OnboardingDeps,
  OnboardingInput,
  OnboardingOption,
  OnboardingPrompt,
  OnboardingReply,
} from './onboarding';
