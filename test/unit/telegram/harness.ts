import { createCatalogue } from '../../../src/channels/telegram/commands/catalogue';
import { TelegramDispatcher } from '../../../src/channels/telegram/dispatcher';
import type { IdentityCollaborator } from '../../../src/channels/telegram/dispatcher';
import type { OnboardingInput, OnboardingReply } from '../../../src/core/identity/onboarding';
import type { OnboardingService } from '../../../src/core/identity/onboarding';
import { createEntitlementService } from '../../../src/core/entitlements/default-entitlement-service';
import type { ResolvedUser } from '../../../src/core/identity/identity-service';
import type { Channel, UserId } from '../../../src/core/shared/common';
import { NoopLogger } from '../../../src/observability/log';
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

/** M2's `resolve`/`deactivateConnection`, recorded. */
export class FakeIdentity implements IdentityCollaborator {
  readonly deactivated: { userId: UserId; channel: Channel }[] = [];
  readonly resolveCalls: string[] = [];

  /** Null means "no account yet" — the stranger case. */
  user: ResolvedUser | null = { userId: USER, isNew: false, onboarded: true };

  async resolve(_channel: Channel, externalId: string): Promise<ResolvedUser | null> {
    this.resolveCalls.push(externalId);
    return this.user;
  }

  async deactivateConnection(userId: UserId, channel: Channel): Promise<void> {
    this.deactivated.push({ userId, channel });
  }
}

/** M2's onboarding machine, reduced to "what was it asked, and what does it answer". */
export class FakeOnboarding {
  readonly answers: OnboardingInput[] = [];

  reply: OnboardingReply = {
    kind: 'prompt',
    prompt: { step: 'timezone', text: 'Which timezone are you in?', options: [] },
  };

  async answer(_userId: UserId, input: OnboardingInput): Promise<OnboardingReply> {
    this.answers.push(input);
    return this.reply;
  }
}

export class FakeCallbacks {
  readonly answered: string[] = [];

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answered.push(callbackQueryId);
  }
}

export interface Harness {
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

export function createHarness(now: string | number = '2026-09-11T02:00:00Z'): Harness {
  const clock = new TestClock(now);
  const identity = new FakeIdentity();
  const onboarding = new FakeOnboarding();
  const gateway = new InMemoryGatewayRepository();
  const sender = new FakeMessageSender();
  const callbacks = new FakeCallbacks();
  const entitlementRepository = new InMemoryEntitlementRepository();

  const entitlements = createEntitlementService<undefined>({
    repository: entitlementRepository,
    capacity: {
      countActiveCategories: async () => 0,
      countReminderCategories: async () => 0,
    },
    timezoneOf: async () => 'Australia/Sydney',
    clock,
  });

  const dispatcher = new TelegramDispatcher({
    identity,
    entitlements,
    // The dispatcher only ever calls `answer`; the double implements exactly that.
    onboarding: onboarding as unknown as OnboardingService,
    gateway,
    router: createCatalogue(),
    sender,
    callbacks,
    clock,
    logger: new NoopLogger(),
    supportContact: SUPPORT_CONTACT,
  });

  return {
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
