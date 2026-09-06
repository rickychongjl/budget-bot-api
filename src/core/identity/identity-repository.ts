import type { Channel, CurrencyCode, Instant, LocalDate, LocalTime, UserId } from '../ports/common';
import type { ChannelConnection } from '../ports/messaging';
import type { OnboardingStep } from './onboarding-step';

/**
 * The outgoing port for M2 — the persistence seam. `DefaultIdentityService` and
 * `OnboardingService` talk to this interface only; `DrizzleIdentityRepository`
 * (`infrastructure/database/repositories/`) is the one place that sees a DB handle
 * (M1 §4 / master plan §6 rule 3). `InMemoryIdentityRepository` in `test/support`
 * mirrors the same constraints so the service logic is unit-testable.
 *
 * Two operations carry the module's invariants and must be *atomic in the store*, not
 * check-then-act in the caller:
 *   - `registerConnection`  — one `app_user` per `(channel, external_id)`.
 *   - `claimInitialTimezone` — timezone is written at most once.
 */

export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface UserRecord {
  id: UserId;
  /** Empty only before onboarding step 1 completes; a non-empty IANA zone is immutable. */
  timezone: string;
  currencyCode: CurrencyCode;
  periodAnchorDate: LocalDate | null;
  /** `HH:MM`. */
  reminderLocalTime: LocalTime;
  status: UserStatus;
  onboardingStep: OnboardingStep;
  createdAt: Instant;
  updatedAt: Instant;
}

/** The mutable columns. `timezone` is deliberately absent — see `claimInitialTimezone`. */
export type UserRecordPatch = Partial<
  Pick<UserRecord, 'currencyCode' | 'periodAnchorDate' | 'reminderLocalTime' | 'onboardingStep'>
>;

export interface RegisterConnectionInput {
  channel: Channel;
  /** The channel's own identifier for the person (a Telegram user id). */
  externalId: string;
  /** Where outbound messages go; equal to `externalId` for a Telegram private chat. */
  chatId: string;
  username: string | null;
  now: Instant;
}

export interface RegisterConnectionResult {
  userId: UserId;
  isNew: boolean;
  onboardingStep: OnboardingStep;
}

export interface ConnectionRecord {
  userId: UserId;
  onboardingStep: OnboardingStep;
}

export type ClaimTimezoneOutcome =
  /** The empty pre-onboarding value is now `timezone`. */
  | 'set'
  /** The column was already non-empty; the caller decides whether the value matches (idempotent replay). */
  | 'already_set'
  | 'missing';

export interface IdentityRepository {
  findConnection(channel: Channel, externalId: string): Promise<ConnectionRecord | null>;

  /**
   * Insert-or-find keyed on the `(channel, external_id)` unique constraint. Under
   * concurrent duplicate calls exactly one `app_user` row may exist afterwards. On the
   * existing path the connection's `chat_id`/`username` are refreshed and it is
   * re-activated (a user who blocked the bot and came back).
   */
  registerConnection(input: RegisterConnectionInput): Promise<RegisterConnectionResult>;

  findUser(userId: UserId): Promise<UserRecord | null>;

  /** `update app_user set timezone = $1 where id = $2 and timezone = ''` — the DB arbitrates. */
  claimInitialTimezone(userId: UserId, timezone: string, now: Instant): Promise<ClaimTimezoneOutcome>;

  updateUser(userId: UserId, patch: UserRecordPatch, now: Instant): Promise<UserRecord | null>;

  /** Hard delete; `on delete cascade` removes every user-owned row. No-op if absent. */
  deleteUser(userId: UserId): Promise<void>;

  findActiveConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null>;

  deactivateConnection(userId: UserId, channel: Channel): Promise<void>;
}
