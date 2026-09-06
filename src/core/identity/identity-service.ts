import { RefusalError } from '../domain/refusal';
import { canonicalTimezone, isLocalDate, isLocalTime } from '../domain/timezone';
import type { ChannelConnectionDirectory } from '../ports/channel-connection-directory';
import type { Clock } from '../ports/clock';
import type { Channel, CurrencyCode, UserId } from '../ports/common';
import type { AccountExport, IdentityService, ResolvedUser, UserSettings } from '../ports/identity-service';
import type { LedgerService } from '../ports/ledger-service';
import type { ChannelConnection } from '../ports/messaging';
import type { AppUserRecord, IdentityRepository, OnboardingStep } from './repository';

/**
 * The step marker the `/start` machine reads and advances. Implemented by
 * `IdentityServiceImpl` and consumed by `OnboardingService`; not a cross-module port.
 */
export interface OnboardingStateStore {
  onboardingStep(userId: UserId): Promise<OnboardingStep>;
  setOnboardingStep(userId: UserId, step: OnboardingStep): Promise<void>;
  /** The raw row — the onboarding machine needs `timezone` before `getSettings` is legal. */
  userRecord(userId: UserId): Promise<AppUserRecord>;
}

/**
 * `IdentityService` (M2) over an `IdentityRepository`.
 *
 * What this class owns, and where each invariant actually lives:
 *   - one user per `(channel, external_id)` ........ the repository's unique constraint
 *   - timezone written once, never changed ......... `setTimezoneIfUnset` (conditional
 *     update) + a runtime guard here so an `updateSettings` patch carrying `timezone`
 *     is refused even when the value is identical (M2 checklist step 4)
 *   - currency frozen after the first transaction ... asks M3 via `LedgerService.history`
 *   - anchor-date change is a pure re-bucket ........ nothing here touches the ledger
 *   - `reminder_local_time` affects the next send ... a plain column write; M5 reads it
 *
 * `exportAccount` is deferred (master plan §5.8) and throws `NOT_YET_AVAILABLE`.
 */
export class IdentityServiceImpl implements IdentityService, ChannelConnectionDirectory, OnboardingStateStore {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
  ) {}

  // ---- resolution ----------------------------------------------------------------

  async resolve(channel: Channel, externalId: string): Promise<ResolvedUser | null> {
    const found = await this.repo.findConnection(channel, externalId);
    if (!found) return null;
    return { userId: found.userId, isNew: false, onboarded: found.onboardingStep === 'done' };
  }

  async register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username?: string,
  ): Promise<ResolvedUser> {
    if (externalId.trim() === '' || chatId.trim() === '') {
      throw new RefusalError('INVALID_ARGUMENT', 'externalId and chatId are required');
    }
    const out = await this.repo.register(channel, externalId, chatId, username ?? null, this.clock.now());
    return { userId: out.userId, isNew: out.isNew, onboarded: out.onboardingStep === 'done' };
  }

  // ---- settings ------------------------------------------------------------------

  async getSettings(userId: UserId): Promise<UserSettings> {
    const user = await this.userRecord(userId);
    if (user.timezone === null) {
      throw new RefusalError('ONBOARDING_REQUIRED', 'Finish /start first — a timezone has not been chosen yet.');
    }
    return toSettings(user, user.timezone);
  }

  async setInitialTimezone(userId: UserId, timezone: string): Promise<void> {
    const canonical = canonicalTimezone(timezone);
    if (!canonical) {
      throw new RefusalError('INVALID_ARGUMENT', `"${timezone}" is not a timezone I recognise.`);
    }
    const outcome = await this.repo.setTimezoneIfUnset(userId, canonical, this.clock.now());
    if (outcome === 'set') return;
    if (outcome === 'missing') throw new RefusalError('RESOURCE_NOT_FOUND', 'No such user.');
    // Already set — an identical replay (Telegram redelivery, a re-run /start) is not a
    // change and succeeds; anything else is the immutable-timezone rule.
    const user = await this.userRecord(userId);
    if (user.timezone === canonical) return;
    throw timezoneImmutable(user.timezone);
  }

  async updateSettings(userId: UserId, patch: Partial<Omit<UserSettings, 'timezone'>>): Promise<UserSettings> {
    // The type already excludes `timezone`; this catches a forged/JS caller that sends
    // it anyway — refused even if the value equals what is stored (M2 tests).
    if ('timezone' in (patch as Record<string, unknown>)) {
      const user = await this.userRecord(userId);
      throw timezoneImmutable(user.timezone);
    }

    const user = await this.userRecord(userId);
    if (user.timezone === null) {
      throw new RefusalError('ONBOARDING_REQUIRED', 'Choose a timezone (step 1 of /start) before changing other settings.');
    }

    const next: Parameters<IdentityRepository['updateUser']>[1] = {};

    if (patch.currencyCode !== undefined) {
      const code = normaliseCurrency(patch.currencyCode);
      if (code !== user.currencyCode) {
        if (await this.hasAnyTransaction(userId)) {
          throw new RefusalError(
            'INVALID_ARGUMENT',
            `Your currency is fixed at ${user.currencyCode} because you've already logged transactions in it — ` +
              `there's no currency conversion yet. To budget in ${code}, delete this account and start again.`,
          );
        }
        next.currencyCode = code;
      }
    }

    if (patch.periodAnchorDate !== undefined) {
      if (patch.periodAnchorDate === null) {
        throw new RefusalError('INVALID_ARGUMENT', 'A budget start date is required once set.');
      }
      if (!isLocalDate(patch.periodAnchorDate)) {
        throw new RefusalError('INVALID_ARGUMENT', 'Send the budget start date as YYYY-MM-DD.');
      }
      // Periods are derived, not stored (M4) — writing the anchor re-buckets history by
      // itself. Deliberately no ledger/budget call here.
      if (patch.periodAnchorDate !== user.periodAnchorDate) next.periodAnchorDate = patch.periodAnchorDate;
    }

    if (patch.reminderLocalTime !== undefined) {
      if (!isLocalTime(patch.reminderLocalTime)) {
        throw new RefusalError('INVALID_ARGUMENT', 'Send the reminder time as HH:MM (24-hour).');
      }
      // Takes effect at the next scheduled send; never backfills a missed day (M5 reads
      // this column when it selects due users).
      if (patch.reminderLocalTime !== user.reminderLocalTime) next.reminderLocalTime = patch.reminderLocalTime;
    }

    if (Object.keys(next).length === 0) return toSettings(user, user.timezone);
    const updated = await this.repo.updateUser(userId, next, this.clock.now());
    if (!updated || updated.timezone === null) throw new RefusalError('RESOURCE_NOT_FOUND', 'No such user.');
    return toSettings(updated, updated.timezone);
  }

  // ---- export / delete -----------------------------------------------------------

  async exportAccount(_userId: UserId): Promise<AccountExport> {
    // Deferred — round 5, Story 7 (master plan §5.8). M3's `exportCsv` isn't built either.
    throw new RefusalError('NOT_YET_AVAILABLE', 'Account export is not available yet.');
  }

  async deleteAccount(userId: UserId): Promise<void> {
    // Hard delete. `on delete cascade` from app_user removes every user-owned row;
    // `parse_event.user_id` is nulled by M9's FK. No soft-delete grace period in v1.
    await this.repo.deleteUser(userId);
  }

  // ---- ChannelConnectionDirectory (M7 / M5) ---------------------------------------

  activeConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null> {
    return this.repo.activeConnection(userId, channel);
  }

  deactivateConnection(userId: UserId, channel: Channel): Promise<void> {
    return this.repo.deactivateConnection(userId, channel);
  }

  // ---- OnboardingStateStore (internal) -------------------------------------------

  async onboardingStep(userId: UserId): Promise<OnboardingStep> {
    return (await this.userRecord(userId)).onboardingStep;
  }

  async setOnboardingStep(userId: UserId, step: OnboardingStep): Promise<void> {
    const updated = await this.repo.updateUser(userId, { onboardingStep: step }, this.clock.now());
    if (!updated) throw new RefusalError('RESOURCE_NOT_FOUND', 'No such user.');
  }

  async userRecord(userId: UserId): Promise<AppUserRecord> {
    const user = await this.repo.findUser(userId);
    if (!user) throw new RefusalError('RESOURCE_NOT_FOUND', 'No such user.');
    return user;
  }

  // ---- helpers -------------------------------------------------------------------

  private async hasAnyTransaction(userId: UserId): Promise<boolean> {
    const page = await this.ledger.history(userId, { limit: 1 });
    return page.items.length > 0;
  }
}

function toSettings(user: AppUserRecord, timezone: string): UserSettings {
  return {
    timezone,
    currencyCode: user.currencyCode,
    periodAnchorDate: user.periodAnchorDate,
    reminderLocalTime: user.reminderLocalTime,
  };
}

function timezoneImmutable(current: string | null): RefusalError {
  return new RefusalError(
    'TIMEZONE_IMMUTABLE',
    current
      ? `Your timezone is fixed at ${current} and can't be changed.`
      : 'Your timezone can only be set once.',
  );
}

let cachedCurrencies: ReadonlySet<string> | undefined;

/** ISO 4217 alpha-3 as the runtime knows it (`Intl.supportedValuesOf('currency')`). */
export function normaliseCurrency(input: CurrencyCode): CurrencyCode {
  const code = input.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new RefusalError('INVALID_ARGUMENT', 'Send a 3-letter currency code, e.g. AUD.');
  }
  cachedCurrencies ??= new Set(Intl.supportedValuesOf('currency'));
  if (!cachedCurrencies.has(code)) {
    throw new RefusalError('INVALID_ARGUMENT', `"${code}" isn't a currency I recognise.`);
  }
  return code;
}
