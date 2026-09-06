/**
 * M2 — Identity & Accounts (Phase 1). The module's public surface.
 *
 * `identity-service.ts` holds the incoming port (`IdentityService`) other modules
 * import; `default-identity-service.ts` implements it, together with
 * `ChannelConnectionDirectory` and the 5-step `/start` machine's state store.
 * `identity-repository.ts` is the outgoing port; its Drizzle implementation lives in
 * `infrastructure/database/repositories/drizzle-identity-repository.ts` and is
 * deliberately **not** re-exported here — core must not depend on infrastructure.
 *
 * Wiring (composition root):
 *   const identityRepository = new DrizzleIdentityRepository(db);
 *   const identity = new DefaultIdentityService({ repo: identityRepository, clock, ledger });
 *   const onboarding = new OnboardingService({ identity, entitlements, categories, budgets, reminders, clock });
 */
export type {
  AccountExport,
  IdentityService,
  ResolvedUser,
  UserSettings,
  UserSettingsPatch,
} from './identity-service';

export type { ChannelConnectionDirectory } from './channel-connection-directory';

export type {
  ClaimTimezoneOutcome,
  ConnectionRecord,
  IdentityRepository,
  RegisterConnectionInput,
  RegisterConnectionResult,
  UserRecord,
  UserRecordPatch,
  UserStatus,
} from './identity-repository';

export { ONBOARDING_STEPS } from './onboarding-step';
export type { OnboardingStep } from './onboarding-step';

export { DefaultIdentityService, normaliseCurrency } from './default-identity-service';
export type { DefaultIdentityServiceDeps, OnboardingStateStore } from './default-identity-service';

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

export { RefusalError } from './errors';

export {
  CURATED_AU_TIMEZONES,
  allTimezones,
  canonicalTimezone,
  isLocalDate,
  isLocalTime,
  isValidTimezone,
  localDateAt,
  localTimeAt,
  searchTimezones,
} from './timezones';
