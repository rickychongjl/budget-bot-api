import type { Channel, CurrencyCode, LocalDate, LocalTime, UserId } from './common';

/**
 * M2 — Identity & Accounts. Owns who a user *is*, independent of how they reach the
 * bot. Every other module takes a `UserId` and never sees a Telegram identifier.
 *
 * Interface lifted verbatim from `docs/M2-identity-accounts.md` ("Public interface").
 * Stub only — the M2 agent fills in the bodies.
 */

export interface ResolvedUser {
  userId: UserId;
  /** True when `register` created the row rather than finding an existing one. */
  isNew: boolean;
}

/**
 * The settings contract the rest of the system depends on. `timezone` is present for
 * reads but is immutable after onboarding (M2 enforces this in the write path, not
 * just the UI) — hence `Omit<..., 'timezone'>` on the patch.
 */
export interface UserSettings {
  timezone: string;
  currencyCode: CurrencyCode;
  /** The "budget start date" collected at onboarding step 3; null until then. */
  periodAnchorDate: LocalDate | null;
  /** Fixed 07:00 for every user this pass (5 Sep decision); still stored per-user. */
  reminderLocalTime: LocalTime;
}

/**
 * Full account export. `/export` is deferred (round 5, Story 7) — the method stays on
 * the interface so the contract compiles; the CSV assembly is not built this pass.
 */
export interface AccountExport {
  user: unknown;
  transactions: readonly unknown[];
}

export interface IdentityService {
  resolve(channel: Channel, externalId: string): Promise<ResolvedUser | null>;

  /** Idempotent — re-running `/start` must not create a second user. */
  register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username?: string,
  ): Promise<ResolvedUser>;

  getSettings(userId: UserId): Promise<UserSettings>;

  /** Succeeds once; every later attempt is rejected `TIMEZONE_IMMUTABLE`. */
  setInitialTimezone(userId: UserId, timezone: string): Promise<void>;

  updateSettings(
    userId: UserId,
    patch: Partial<Omit<UserSettings, 'timezone'>>,
  ): Promise<UserSettings>;

  /** Deferred this pass — signature kept so the contract compiles. */
  exportAccount(userId: UserId): Promise<AccountExport>;

  /** Hard delete. Relies on `on delete cascade`; `parse_event.user_id` is nulled. */
  deleteAccount(userId: UserId): Promise<void>;
}
