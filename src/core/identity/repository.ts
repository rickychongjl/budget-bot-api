import type { ONBOARDING_STEPS } from '../../db/schema/identity';
import type { Channel, CurrencyCode, Instant, LocalDate, LocalTime, UserId } from '../ports/common';
import type { ChannelConnection } from '../ports/messaging';

/**
 * The persistence seam for M2. `IdentityServiceImpl` and `OnboardingService` talk to
 * this interface only; `DrizzleIdentityRepository` is the one place that sees a DB
 * handle (M1 §4 / master plan §6 rule 3). `InMemoryIdentityRepository` in
 * `core/testing` mirrors the same constraints so the service logic is unit-testable.
 *
 * Two operations carry the module's invariants and must be *atomic in the store*, not
 * check-then-act in the caller:
 *   - `register`           — one `app_user` per `(channel, external_id)`.
 *   - `setTimezoneIfUnset` — timezone is written at most once.
 */

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface AppUserRecord {
  id: UserId;
  /** Null until onboarding step 1 completes; immutable afterwards. */
  timezone: string | null;
  currencyCode: CurrencyCode;
  periodAnchorDate: LocalDate | null;
  /** `HH:MM`. */
  reminderLocalTime: LocalTime;
  status: UserStatus;
  onboardingStep: OnboardingStep;
  createdAt: Instant;
  updatedAt: Instant;
}

/** The mutable columns. `timezone` is deliberately absent — see `setTimezoneIfUnset`. */
export type AppUserPatch = Partial<
  Pick<AppUserRecord, 'currencyCode' | 'periodAnchorDate' | 'reminderLocalTime' | 'onboardingStep'>
>;

export interface RegisterOutcome {
  userId: UserId;
  isNew: boolean;
  onboardingStep: OnboardingStep;
}

export interface ConnectionLookup {
  userId: UserId;
  onboardingStep: OnboardingStep;
}

export type SetTimezoneOutcome =
  /** The column was null and is now `timezone`. */
  | 'set'
  /** The column was already non-null; the caller decides whether the value matches (idempotent replay). */
  | 'already_set'
  | 'missing';

export interface IdentityRepository {
  findConnection(channel: Channel, externalId: string): Promise<ConnectionLookup | null>;

  /**
   * Insert-or-find keyed on the `(channel, external_id)` unique constraint. Under
   * concurrent duplicate calls exactly one `app_user` row may exist afterwards. On the
   * existing path the connection's `chat_id`/`username` are refreshed and it is
   * re-activated (a user who blocked the bot and came back).
   */
  register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username: string | null,
    now: Instant,
  ): Promise<RegisterOutcome>;

  findUser(userId: UserId): Promise<AppUserRecord | null>;

  /** `update app_user set timezone = $1 where id = $2 and timezone is null` — the DB arbitrates. */
  setTimezoneIfUnset(userId: UserId, timezone: string, now: Instant): Promise<SetTimezoneOutcome>;

  updateUser(userId: UserId, patch: AppUserPatch, now: Instant): Promise<AppUserRecord | null>;

  /** Hard delete; `on delete cascade` removes every user-owned row. No-op if absent. */
  deleteUser(userId: UserId): Promise<void>;

  activeConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null>;

  deactivateConnection(userId: UserId, channel: Channel): Promise<void>;
}
