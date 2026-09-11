import { createCatalogue } from '../../../src/channels/telegram/commands/catalogue';
import { TelegramDispatcher } from '../../../src/channels/telegram/dispatcher';
import type { IdentityCollaborator } from '../../../src/channels/telegram/dispatcher';
import type { OnboardingInput, OnboardingReply } from '../../../src/core/identity/onboarding';
import type { OnboardingService } from '../../../src/core/identity/onboarding';
import { createEntitlementService } from '../../../src/core/entitlements/default-entitlement-service';
import type { ResolvedUser, UserSettings } from '../../../src/core/identity/identity-service';
import type { Channel, UserId } from '../../../src/core/shared/common';
import { NoopLogger } from '../../../src/observability/log';
import { createDomainServices, type DomainServices } from '../../support/domain-services';
import { FakeMessageSender } from '../../support/fake-message-sender';
import { InMemoryEntitlementRepository } from '../../support/in-memory-entitlement-repository';
import { InMemoryGatewayRepository } from '../../support/in-memory-gateway-repository';
import { TestClock } from '../../support/test-clock';

/**
 * The dispatcher over real M8 policy and recording doubles for M2.
 *
 * M8 is the real `DefaultEntitlementService` because admission *is* what most of these
 * tests are about — the exempt set, the refusal message, the onboarding waiver — and a
 * fake would only assert that the fake was called. M2's two surfaces (`resolve`,
 * `answer`) are small enough that a recording double is clearer than standing up an
 * identity service and walking a real user through five onboarding steps; M2's own
 * suite covers that machine.
 */

export const USER: UserId = 'user-1';
export const EXTERNAL_ID = '55501';
export const CHAT_ID = '99001';
export const SUPPORT_CONTACT = 'support@example.test';

/** M2's surfaces the dispatcher and the handlers use, recorded. */
export class FakeIdentity implements IdentityCollaborator {
  readonly deactivated: { userId: UserId; channel: Channel }[] = [];
  readonly resolveCalls: string[] = [];
  readonly registrations: { channel: Channel; externalId: string; chatId: string; username?: string }[] =
    [];
  /**
   * Recorded so `/settings`' "view only this pass" ruling has a regression guard: a
   * handler that ever writes settings shows up here. (`updateSettings` is not on
   * `IdentityCollaborator` at all, so a write would not even compile — this records
   * the reads.)
   */
  readonly settingsReads: UserId[] = [];

  settings: UserSettings = {
    timezone: 'Australia/Sydney',
    currencyCode: 'AUD',
    periodAnchorDate: '2026-01-05',
    reminderLocalTime: '07:00',
    accountCreatedOn: '2026-01-05',
  };

  /** Null means "no account yet" — the stranger case. */
  user: ResolvedUser | null = { userId: USER, isNew: false, onboarded: true };

  async resolve(_channel: Channel, externalId: string): Promise<ResolvedUser | null> {
    this.resolveCalls.push(externalId);
    return this.user;
  }

  /** Idempotent, like M2's: the same sender always resolves to the same user. */
  async register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username?: string,
  ): Promise<ResolvedUser> {
    const isNew = this.user === null;
    this.registrations.push(
      username === undefined ? { channel, externalId, chatId } : { channel, externalId, chatId, username },
    );
    this.user ??= { userId: USER, isNew: true, onboarded: false };
    return { ...this.user, isNew };
  }

  async getSettings(userId: UserId): Promise<UserSettings> {
    this.settingsReads.push(userId);
    return this.settings;
  }

  async deactivateConnection(userId: UserId, channel: Channel): Promise<void> {
    this.deactivated.push({ userId, channel });
  }
}

/** M2's onboarding machine, reduced to "what was it asked, and what does it answer". */
export class FakeOnboarding {
  readonly answers: OnboardingInput[] = [];
  readonly starts: UserId[] = [];

  reply: OnboardingReply = {
    kind: 'prompt',
    prompt: { step: 'timezone', text: 'Which timezone are you in?', options: [] },
  };

  async answer(_userId: UserId, input: OnboardingInput): Promise<OnboardingReply> {
    this.answers.push(input);
    return this.reply;
  }

  async start(userId: UserId): Promise<OnboardingReply> {
    this.starts.push(userId);
    return this.reply;
  }
}

export class FakeCallbacks {
  readonly answered: string[] = [];

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answered.push(callbackQueryId);
  }
}

export interface Harness extends DomainServices {
  dispatcher: TelegramDispatcher;
  identity: FakeIdentity;
  onboarding: FakeOnboarding;
  entitlements: ReturnType<typeof createEntitlementService<undefined>>;
  entitlementRepository: InMemoryEntitlementRepository;
  gateway: InMemoryGatewayRepository;
  sender: FakeMessageSender;
  callbacks: FakeCallbacks;
  clock: TestClock;
}

/**
 * Default clock is 2026-09-11T02:00:00Z — 12:00 on 2026-09-11 in Sydney. The anchor is
 * the 5th, so the current cycle runs 5 Sep – 4 Oct: 24 days left including today.
 */
export function createHarness(now: string | number = '2026-09-11T02:00:00Z'): Harness {
  const clock = new TestClock(now);
  const identity = new FakeIdentity();
  const onboarding = new FakeOnboarding();
  const gateway = new InMemoryGatewayRepository();
  const sender = new FakeMessageSender();
  const callbacks = new FakeCallbacks();
  const entitlementRepository = new InMemoryEntitlementRepository();

  // M3/M4/M5 for real, over one in-memory store — the handlers call their public
  // contracts and nothing else. `identity.settings` is the same object the domain
  // services read, so a test changing the currency changes it everywhere at once.
  const domain = createDomainServices(clock, identity.settings);

  const entitlements = createEntitlementService<undefined>({
    repository: entitlementRepository,
    capacity: {
      countActiveCategories: async (userId) => domain.categories.countActive(userId),
      countReminderCategories: async (userId) =>
        (await domain.reminders.enabledCategoryIds(userId)).length,
    },
    timezoneOf: async () => identity.settings.timezone,
    clock,
  });

  const dispatcher = new TelegramDispatcher({
    identity,
    entitlements,
    // The dispatcher calls `answer`; `/start` calls `start`. The double implements
    // exactly those two.
    onboarding: onboarding as unknown as OnboardingService,
    categories: domain.categories,
    budgets: domain.budgets,
    ledger: domain.ledger,
    allowance: domain.allowance,
    reminders: domain.reminders,
    gateway,
    router: createCatalogue(),
    sender,
    callbacks,
    clock,
    logger: new NoopLogger(),
    supportContact: SUPPORT_CONTACT,
  });

  return {
    ...domain,
    dispatcher,
    identity,
    onboarding,
    entitlements,
    entitlementRepository,
    gateway,
    sender,
    callbacks,
    clock,
  };
}

// ---- update fixtures ------------------------------------------------------------

let nextUpdateId = 1000;

export function textUpdate(text: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: (nextUpdateId += 1),
    message: {
      message_id: nextUpdateId,
      date: 1789000000,
      chat: { id: CHAT_ID, type: 'private' },
      from: { id: EXTERNAL_ID, username: 'ricky', is_bot: false },
      text,
      ...overrides,
    },
  };
}

export function callbackUpdate(data: string): unknown {
  return {
    update_id: (nextUpdateId += 1),
    callback_query: {
      id: `cb-${nextUpdateId}`,
      from: { id: EXTERNAL_ID, username: 'ricky', is_bot: false },
      data,
      message: {
        message_id: nextUpdateId,
        chat: { id: CHAT_ID, type: 'private' },
      },
    },
  };
}
