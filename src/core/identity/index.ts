/**
 * M2 — Identity & Accounts (Phase 1).
 *
 * Implements `IdentityService` (`./identity-service.ts`) against
 * `infrastructure/database/schema/identity.ts`. Owns `/start` onboarding (5 steps),
 * the settings commands, timezone immutability, account export/deletion.
 *
 * The contract below is fixed; `DefaultIdentityService` and the repository
 * implementation are empty until the M2 agent's PR.
 */
export type { AccountExport, IdentityService, ResolvedUser, UserSettings } from './identity-service';
