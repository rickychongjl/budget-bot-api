import type { Clock } from '../ports/clock';
import type { Channel, UserId } from '../ports/common';
import type {
  AccountExport,
  IdentityService,
  ResolvedUser,
  UserSettings,
} from '../ports/identity-service';
import type { LedgerService } from '../ports/ledger-service';
import { IdentityError } from './errors';
import type { IdentityRepository, UserRecord, UserSettingsPatch } from './repository';
import {
  validateCurrencyCode,
  validateLocalDate,
  validateLocalTime,
  validateTimezone,
} from './validation';

/** The only keys `updateSettings` accepts. `timezone` is deliberately absent. */
const MUTABLE_SETTING_KEYS = new Set<keyof UserSettingsPatch>([
  'currencyCode',
  'periodAnchorDate',
  'reminderLocalTime',
]);

export interface IdentityServiceDeps {
  repo: IdentityRepository;
  clock: Clock;
  /**
   * M3's port — only `history` is used, to answer "does this user have any
   * transaction?" for the currency-change rule (checklist step 5). `history` is
   * called with `limit: 1`; a non-empty page means the change is refused.
   */
  ledger: Pick<LedgerService, 'history'>;
}

/**
 * `IdentityService` (M2). Every write goes through the injected repository with a
 * `now` from the injected `Clock` — no `Date.now()` anywhere in this module.
 */
export class IdentityServiceImpl implements IdentityService {
  readonly #repo: IdentityRepository;
  readonly #clock: Clock;
  readonly #ledger: Pick<LedgerService, 'history'>;

  constructor(deps: IdentityServiceDeps) {
    this.#repo = deps.repo;
    this.#clock = deps.clock;
    this.#ledger = deps.ledger;
  }

  async resolve(channel: Channel, externalId: string): Promise<ResolvedUser | null> {
    const connection = await this.#repo.findConnection(channel, externalId);
    return connection ? { userId: connection.userId, isNew: false } : null;
  }

  /**
   * Idempotent. The repository's create-or-return is backed by the
   * `(channel, external_id)` unique constraint, so concurrent duplicate calls converge
   * on one user. A returning user's connection is refreshed (new username, a chat
   * re-opened after blocking the bot → `is_active` back to true) but never re-created.
   */
  async register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username?: string,
  ): Promise<ResolvedUser> {
    const normalisedUsername = username ?? null;
    const { connection, created } = await this.#repo.registerConnection({
      channel,
      externalId,
      chatId,
      username: normalisedUsername,
      now: this.#clock.now(),
    });

    if (
      !created &&
      (connection.chatId !== chatId ||
        connection.username !== normalisedUsername ||
        !connection.isActive)
    ) {
      await this.#repo.refreshConnection(connection.id, { chatId, username: normalisedUsername });
    }

    return { userId: connection.userId, isNew: created };
  }

  async getSettings(userId: UserId): Promise<UserSettings> {
    return toSettings(await this.#requireUser(userId));
  }

  /**
   * Succeeds once, ever. The claim is `update … where timezone = ''` inside the
   * repository, so the set-once guarantee is the predicate, not a read-then-write.
   * A replay of the *same* value (a redelivered callback) is a no-op, not a rejected
   * change; any *different* value is `TIMEZONE_IMMUTABLE`.
   */
  async setInitialTimezone(userId: UserId, timezone: string): Promise<void> {
    const canonical = validateTimezone(timezone);
    const claimed = await this.#repo.claimInitialTimezone(userId, canonical, this.#clock.now());
    if (claimed) return;

    const user = await this.#requireUser(userId);
    if (user.timezone === canonical) return; // idempotent replay
    throw new IdentityError(
      'TIMEZONE_IMMUTABLE',
      `timezone is already set to ${user.timezone} and cannot be changed`,
    );
  }

  /**
   * Mutation rules (checklist step 5):
   *   - `timezone` present in the patch at all — even the stored value, even via a
   *     forged/untyped caller — is `TIMEZONE_IMMUTABLE`. The type already omits it;
   *     this is the runtime guard behind the type.
   *   - `currencyCode`: refused with `CURRENCY_LOCKED` once the user has any
   *     transaction (asked of M3). Same-value patches are a no-op and always allowed.
   *   - `periodAnchorDate`: a pure re-bucketing — periods are derived by M4, not
   *     stored, so nothing here rewrites history. Cannot be cleared once set.
   *   - `reminderLocalTime`: stored only; M5 computes targets for the current local
   *     date alone, so the change affects the next scheduled send and never backfills.
   */
  async updateSettings(
    userId: UserId,
    patch: Partial<Omit<UserSettings, 'timezone'>>,
  ): Promise<UserSettings> {
    const raw = patch as Record<string, unknown>;
    if ('timezone' in raw) {
      throw new IdentityError(
        'TIMEZONE_IMMUTABLE',
        'timezone cannot be changed after onboarding, not even to the same value',
      );
    }
    for (const key of Object.keys(raw)) {
      if (!MUTABLE_SETTING_KEYS.has(key as keyof UserSettingsPatch)) {
        throw new IdentityError('INVALID_ARGUMENT', `unknown setting ${JSON.stringify(key)}`);
      }
    }

    const current = await this.#requireUser(userId);
    const effective: UserSettingsPatch = {};

    if ('currencyCode' in raw) {
      const code = validateCurrencyCode(raw['currencyCode']);
      if (code !== current.currencyCode) {
        const page = await this.#ledger.history(userId, { limit: 1 });
        if (page.items.length > 0) {
          throw new IdentityError(
            'CURRENCY_LOCKED',
            `currency stays ${current.currencyCode}: it can't change once you've logged a transaction (no conversion in v1)`,
          );
        }
        effective.currencyCode = code;
      }
    }

    if ('periodAnchorDate' in raw) {
      if (raw['periodAnchorDate'] === null) {
        throw new IdentityError('INVALID_ARGUMENT', 'budget start date cannot be cleared');
      }
      const anchor = validateLocalDate(raw['periodAnchorDate']);
      if (anchor !== current.periodAnchorDate) effective.periodAnchorDate = anchor;
    }

    if ('reminderLocalTime' in raw) {
      const time = validateLocalTime(raw['reminderLocalTime']);
      if (time !== current.reminderLocalTime) effective.reminderLocalTime = time;
    }

    if (Object.keys(effective).length === 0) return toSettings(current);

    const updated = await this.#repo.updateUser(userId, effective, this.#clock.now());
    if (!updated) throw notFound(userId);
    return toSettings(updated);
  }

  /** Deferred this pass (master plan §5.8). Typed refusal so M7 renders "not yet available". */
  async exportAccount(_userId: UserId): Promise<AccountExport> {
    throw new IdentityError('NOT_YET_AVAILABLE', 'not implemented: account export is deferred');
  }

  /**
   * Hard delete. `on delete cascade` from `app_user` removes every user-owned row in
   * every module's table; `parse_event.user_id` is nulled by M9's `on delete set null`.
   * Idempotent — a retried delete of an already-deleted user is a no-op, so a webhook
   * redelivery never surfaces an error for a mutation that already committed (M11).
   */
  async deleteAccount(userId: UserId): Promise<void> {
    await this.#repo.deleteUser(userId);
  }

  async #requireUser(userId: UserId): Promise<UserRecord> {
    const user = await this.#repo.findUser(userId);
    if (!user) throw notFound(userId);
    return user;
  }
}

function notFound(userId: UserId): IdentityError {
  return new IdentityError('RESOURCE_NOT_FOUND', `no user ${userId}`);
}

export function toSettings(user: UserRecord): UserSettings {
  return {
    timezone: user.timezone,
    currencyCode: user.currencyCode,
    periodAnchorDate: user.periodAnchorDate,
    reminderLocalTime: user.reminderLocalTime,
  };
}

/** True once steps 1–3 have written their settings — what `ONBOARDING_REQUIRED` gates on. */
export function hasCompletedCoreOnboarding(settings: UserSettings): boolean {
  return settings.timezone !== '' && settings.periodAnchorDate !== null;
}
