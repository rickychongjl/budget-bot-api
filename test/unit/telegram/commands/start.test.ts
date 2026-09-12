import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, CHAT_ID, EXTERNAL_ID, USER } from '../harness';
import type { Harness } from '../harness';

/**
 * `/start` — the only handler that creates an account, and the only one a stranger
 * can reach (besides `/help` and `/paysupport`, which create nothing).
 *
 * Registration stays `/start`-only — Ricky's call, 11 Sep 2026, closing stage 4B's
 * open question 1.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/start', () => {
  it('registers a stranger and starts onboarding', async () => {
    h.identity.user = null;

    const text = await reply(h, '/start');

    expect(h.identity.registrations).toEqual([
      { channel: 'telegram', externalId: EXTERNAL_ID, chatId: CHAT_ID, username: 'ricky' },
    ]);
    expect(h.onboarding.starts).toEqual([USER]);
    expect(text).toContain('timezone');
  });

  it('registers again for a returning user, because that is what re-activates a blocked connection', async () => {
    await reply(h, '/start');

    // M2's `register` is idempotent by contract, and it is also the only thing that
    // flips `is_active` back on after the 403 path switched it off. A handler that
    // skipped it for a known user would leave someone who blocked and unblocked the
    // bot permanently unreachable.
    expect(h.identity.registrations).toHaveLength(1);
    expect(h.onboarding.starts).toEqual([USER]);
  });

  it('does not create a second user when sent twice', async () => {
    await reply(h, '/start');
    await reply(h, '/start');

    expect(h.identity.registrations).toHaveLength(2);
    // Same user both times — M2: "re-running /start must not create a second user".
    expect(h.onboarding.starts).toEqual([USER, USER]);
  });

  it('shows a returning user their settings rather than a new account', async () => {
    h.onboarding.reply = {
      kind: 'summary',
      text: "You're all set.",
      summary: {
        settings: h.identity.settings,
        tier: 'free',
        categories: [{ id: 'c1', name: 'Food', capMinorUnits: 60000n, reminder: true }],
      },
    };

    const text = await reply(h, '/start');

    expect(text).toContain("You're all set.");
    expect(text).toContain('Food');
    expect(text).toContain('Australia/Sydney');
  });
});
