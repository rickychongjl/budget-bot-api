/**
 * M2 — Identity & Accounts (Phase 1).
 *
 * Implements `IdentityService` (`core/ports/identity-service.ts`) against
 * `db/schema/identity.ts`, plus the channel-agnostic 5-step onboarding state machine
 * that M7 drives. Wiring for production:
 *
 *   const repo     = new DrizzleIdentityRepository(createDatabase(env.HYPERDRIVE.connectionString));
 *   const identity = new IdentityServiceImpl({ repo, clock: new SystemClock(), ledger });
 *   const onboard  = new OnboardingService({ identity, ledger, budgets, entitlements, reminders, clock });
 */
export * from './errors';
export * from './validation';
export * from './timezones';
export * from './repository';
export * from './identity-service';
export * from './onboarding';
export * from './drizzle-repository';
