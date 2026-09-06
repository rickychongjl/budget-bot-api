import type {
  Channel,
  CurrencyCode,
  Id,
  Instant,
  LocalDate,
  LocalTime,
  UserId,
} from '../ports/common';

/**
 * The repository seam `IdentityServiceImpl` is written against (master plan §6, rule
 * 3: domain code takes an injected `Clock` and a repository interface, never a raw DB
 * handle). `DrizzleIdentityRepository` is the production edge;
 * `InMemoryIdentityRepository` (`core/testing`) backs the unit tests.
 *
 * Every method that writes takes `now: Instant` from the caller's `Clock` — the
 * repository never reads the wall clock itself, so `updated_at` / `linked_at` are
 * deterministic under `TestClock`.
 */

export type UserStatus = 'active' | 'suspended' | 'deleted';

/** `app_user`, one row. `timezone === ''` means onboarding step 1 hasn't completed. */
export interface UserRecord {
  id: UserId;
  timezone: string;
  currencyCode: CurrencyCode;
  periodAnchorDate: LocalDate | null;
  reminderLocalTime: LocalTime;
  status: UserStatus;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

/** `channel_connection`, one row. Same shape as M7's `ChannelConnection` port DTO. */
export interface ConnectionRecord {
  id: Id;
  userId: UserId;
  channel: Channel;
  externalId: string;
  chatId: string;
  username: string | null;
  isActive: boolean;
  linkedAt: Instant;
}

export interface RegisterConnectionInput {
  channel: Channel;
  externalId: string;
  chatId: string;
  username: string | null;
  now: Instant;
}

export interface RegisterConnectionResult {
  connection: ConnectionRecord;
  /** True when this call created the user + connection; false when it found an existing one. */
  created: boolean;
}

/** The three mutable settings. `timezone` is structurally absent — it has its own set-once path. */
export interface UserSettingsPatch {
  currencyCode?: CurrencyCode;
  periodAnchorDate?: LocalDate;
  reminderLocalTime?: LocalTime;
}

export interface ConnectionRefresh {
  chatId: string;
  username: string | null;
}

export interface IdentityRepository {
  findConnection(channel: Channel, externalId: string): Promise<ConnectionRecord | null>;

  /**
   * Create `app_user` + `channel_connection` atomically, or return the existing
   * connection. Idempotency is the `(channel, external_id)` unique constraint, never a
   * check-then-insert: under concurrent duplicate calls exactly one creates, the rest
   * observe the conflict and return the winner's row.
   */
  registerConnection(input: RegisterConnectionInput): Promise<RegisterConnectionResult>;

  /** Re-`/start` from an existing user: refresh `chat_id`/`username` and set `is_active = true`. */
  refreshConnection(connectionId: Id, refresh: ConnectionRefresh): Promise<void>;

  findUser(userId: UserId): Promise<UserRecord | null>;

  /**
   * `update app_user set timezone = $1 where id = $2 and timezone = ''` — the set-once
   * guarantee lives in the predicate, so two racing first-time calls can't both win.
   * Returns true iff this call claimed it.
   */
  claimInitialTimezone(userId: UserId, timezone: string, now: Instant): Promise<boolean>;

  /** Applies `patch` + `updated_at = now`. Null when the user doesn't exist. */
  updateUser(userId: UserId, patch: UserSettingsPatch, now: Instant): Promise<UserRecord | null>;

  /** Hard delete; `on delete cascade` removes every user-owned row. True iff a row was deleted. */
  deleteUser(userId: UserId): Promise<boolean>;
}
