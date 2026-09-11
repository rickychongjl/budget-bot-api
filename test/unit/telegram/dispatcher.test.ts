import { beforeEach, describe, expect, it } from 'vitest';
import {
  APOLOGY,
  FREE_TEXT_NOT_WIRED_REPLY,
  GROUP_CHAT_REPLY,
  PAYMENTS_NOT_LIVE_REPLY,
  TEXT_ONLY_REPLY,
} from '../../../src/channels/telegram/dispatcher';
import { UNKNOWN_COMMAND } from '../../../src/channels/telegram/commands/catalogue';
import { parseUpdate } from '../../../src/channels/telegram/update-parser';
import { BILLING_NOT_CONFIGURED_MESSAGE } from '../../../src/core/entitlements/billing';
import { RefusalError } from '../../../src/core/shared/errors';
import { createHarness, callbackUpdate, textUpdate, SUPPORT_CONTACT, USER } from './harness';
import type { Harness } from './harness';

/**
 * M11's routing order, one test per branch.
 *
 * The order is the whole point of this file: M11 (5 Sep) revised M7's original page so
 * that a recognised command beats a pending clarification, and `/cancel`, `/help`,
 * `/subscription` and `/paysupport` are exactly the commands that were unreachable
 * under the old order. Those four have explicit regression tests below.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function dispatch(update: unknown): Promise<void> {
  await h.dispatcher.dispatch(parseUpdate(update));
}

describe('chat scope', () => {
  it('answers a group chat with a private-chat instruction and never resolves the user', async () => {
    await dispatch(
      textUpdate('/today', { chat: { id: '-100123', type: 'supergroup' } }),
    );

    expect(h.sender.onlyText).toBe(GROUP_CHAT_REPLY);
    // M11's shared contract: a group request never sees account data, and resolving
    // someone *is* account data.
    expect(h.identity.resolveCalls).toHaveLength(0);
  });
});

describe('user resolution', () => {
  it('refuses an unresolved sender with ONBOARDING_REQUIRED', async () => {
    h.identity.user = null;

    await dispatch(textUpdate('hello'));

    expect(h.sender.onlyText).toContain('/start');
  });

  it('still answers /help and /paysupport without an account', async () => {
    h.identity.user = null;

    await dispatch(textUpdate('/help'));
    await dispatch(textUpdate('/paysupport'));

    expect(h.sender.callCount).toBe(2);
    expect(h.sender.sent[0]!.message.text).toContain('/cancel');
    expect(h.sender.sent[1]!.message.text).toContain(SUPPORT_CONTACT);
  });
});

describe('admission', () => {
  it('sends exactly one message — M8s own copy — when the user is over the cap', async () => {
    // Free is five admitted messages per local day; the sixth is refused.
    for (let i = 0; i < 5; i += 1) await dispatch(textUpdate(`spent ${i}`));
    h.sender.sent.length = 0;

    await dispatch(textUpdate('one too many'));

    expect(h.sender.callCount).toBe(1);
    // M8's own wording, verbatim — M7 renders `result.message` and writes none of its own.
    expect(h.sender.onlyText).toContain("You've used your 5 messages today");
    expect(h.sender.onlyText).toContain('Australia/Sydney');
  });

  it('keeps the management commands reachable at the cap', async () => {
    for (let i = 0; i < 5; i += 1) await dispatch(textUpdate(`spent ${i}`));
    h.sender.sent.length = 0;

    await dispatch(textUpdate('/help'));
    await dispatch(textUpdate('/subscription'));
    await dispatch(textUpdate('/paysupport'));

    expect(h.sender.callCount).toBe(3);
    for (const { message } of h.sender.sent) {
      expect(message.text).not.toContain("You've used your");
    }
  });

  it('waives the daily cap while the user is still onboarding, but still records the message', async () => {
    h.identity.user = { userId: USER, isNew: false, onboarded: false };

    // Six answers — one more than Free's daily cap — all admitted.
    for (let i = 0; i < 6; i += 1) await dispatch(textUpdate(`answer ${i}`));

    expect(h.sender.callCount).toBe(6);
    expect(h.onboarding.answers).toHaveLength(6);
    // Fair use still sees every one of them: the waiver is the daily cap only.
    expect(h.entitlementRepository.usageRows(USER)).toHaveLength(6);
    expect(h.entitlementRepository.usageRows(USER).every((r) => !r.countsTowardDaily)).toBe(true);
  });

  it('leaves the day intact once onboarding finishes', async () => {
    h.identity.user = { userId: USER, isNew: false, onboarded: false };
    for (let i = 0; i < 6; i += 1) await dispatch(textUpdate(`answer ${i}`));

    // Sign-up done: the five-a-day quota starts from zero, not from six.
    h.identity.user = { userId: USER, isNew: false, onboarded: true };
    h.sender.sent.length = 0;
    for (let i = 0; i < 5; i += 1) await dispatch(textUpdate(`spent ${i}`));

    expect(h.sender.callCount).toBe(5);
    for (const { message } of h.sender.sent) {
      expect(message.text).not.toContain("You've used your");
    }
  });

  it('says nothing at all for a duplicate that M8 has already counted', async () => {
    const update = textUpdate('same message twice');

    await dispatch(update);
    h.sender.sent.length = 0;
    // Same `update_id`: `inbound_update` normally stops this earlier, but M8's dedupe
    // is the backstop and must not produce a second reply.
    await dispatch(update);

    expect(h.sender.callCount).toBe(0);
  });
});

describe('event kinds', () => {
  it('tells a sticker sender that only text works', async () => {
    await dispatch(textUpdate('', { text: undefined, sticker: { file_id: 'x' } }));

    expect(h.sender.onlyText).toBe(TEXT_ONLY_REPLY);
  });

  it('answers a payment event without charging anything', async () => {
    await dispatch({
      update_id: 7001,
      pre_checkout_query: { id: 'pc-1', from: { id: '55501' }, total_amount: 100 },
    });

    expect(h.sender.onlyText).toBe(PAYMENTS_NOT_LIVE_REPLY);
  });

  it('always acknowledges a callback query, even an unrouted one', async () => {
    await dispatch(callbackUpdate('hist:next:abc'));

    expect(h.callbacks.answered).toHaveLength(1);
    // No handler for `hist:` until 4C, so the press is stale by definition.
    expect(h.sender.onlyText).toContain('out of date');
  });

  it('routes an onboarding button to M2 with its step attached', async () => {
    await dispatch(callbackUpdate('ob:timezone:Australia/Sydney'));

    expect(h.onboarding.answers).toEqual([{ value: 'Australia/Sydney', step: 'timezone' }]);
  });

  it('drops an unknown step rather than inventing one', async () => {
    await dispatch(callbackUpdate('ob:not_a_step:value'));

    // M2 decides staleness; forwarding a made-up step would defeat that check.
    expect(h.onboarding.answers).toEqual([{ value: 'value' }]);
  });
});

describe('commands beat a pending prompt (M11 revision)', () => {
  beforeEach(async () => {
    await h.gateway.setPendingPrompt({
      userId: USER,
      kind: 'clarify',
      payload: { question: 'which category?' },
      now: h.clock.now(),
    });
  });

  it('/cancel clears the prompt instead of answering it', async () => {
    await dispatch(textUpdate('/cancel'));

    expect(h.gateway.has(USER)).toBe(false);
    expect(h.sender.onlyText).toContain('Dropped it');
  });

  it.each(['/help', '/subscription', '/paysupport'])(
    '%s is answered while a prompt is open',
    async (command) => {
      await dispatch(textUpdate(command));

      // The prompt survives — these commands answer a question *about* the bot, they
      // do not abandon the user's conversation.
      expect(h.gateway.has(USER)).toBe(true);
      expect(h.sender.onlyText).not.toBe(FREE_TEXT_NOT_WIRED_REPLY);
    },
  );

  it('free text is still treated as the answer', async () => {
    await dispatch(textUpdate('groceries'));

    // 4D supplies the handler; 4B proves the branch is reached.
    expect(h.sender.onlyText).toBe(FREE_TEXT_NOT_WIRED_REPLY);
  });
});

describe('commands', () => {
  it('answers an unknown command with a pointer to /help', async () => {
    await dispatch(textUpdate('/nonsense'));

    expect(h.sender.onlyText).toBe(UNKNOWN_COMMAND);
  });

  it('/cancel with nothing open says so instead of pretending', async () => {
    await dispatch(textUpdate('/cancel'));

    expect(h.sender.onlyText).toContain("nothing waiting");
  });

  it('/upgrade reports the tier and M8s own billing copy', async () => {
    await dispatch(textUpdate('/upgrade'));

    expect(h.sender.onlyText).toContain('Free plan');
    expect(h.sender.onlyText).toContain(BILLING_NOT_CONFIGURED_MESSAGE);
  });

  it('/export is the one true stub', async () => {
    await dispatch(textUpdate('/export'));

    expect(h.sender.onlyText).toContain("isn't available yet");
  });
});

describe('onboarding', () => {
  it('routes free text from a half-signed-up user to the onboarding machine', async () => {
    h.identity.user = { userId: USER, isNew: false, onboarded: false };

    await dispatch(textUpdate('Sydney'));

    expect(h.onboarding.answers).toEqual([{ value: 'Sydney' }]);
    expect(h.sender.onlyText).toContain('timezone');
  });
});

describe('failure handling', () => {
  it('deactivates the connection once when the user has blocked the bot', async () => {
    h.sender.script({ status: 'skipped', reason: 'blocked' });

    await dispatch(textUpdate('/help'));

    expect(h.identity.deactivated).toEqual([{ userId: USER, channel: 'telegram' }]);
  });

  it('sends exactly one apology when something throws, and no second message', async () => {
    h.identity.resolve = async () => {
      throw new Error('database is on fire');
    };

    await dispatch(textUpdate('/help'));

    expect(h.sender.callCount).toBe(1);
    expect(h.sender.onlyText).toBe(APOLOGY);
  });

  it('renders a thrown refusal as its own copy, not as an apology', async () => {
    h.identity.resolve = async () => {
      throw new RefusalError('CATEGORY_NOT_FOUND', "You don't have a category called \"Foo\".");
    };

    await dispatch(textUpdate('/help'));

    expect(h.sender.onlyText).toBe("You don't have a category called \"Foo\".");
  });
});
