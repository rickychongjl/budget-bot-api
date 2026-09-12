import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

/**
 * `/settings` — **view only this pass** (Ricky, 11 Sep 2026).
 *
 * This file is the regression guard for that decision. The compiler is the first one:
 * `CommandServices.identity` is `Pick<IdentityService, 'getSettings' | 'register'>`, so
 * a handler reaching for `updateSettings` does not compile. These tests cover what the
 * compiler cannot — that the reply itself neither writes nor offers to.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/settings', () => {
  it('shows the account without offering to change it', async () => {
    const text = await reply(h, '/settings');

    expect(text).toContain('Australia/Sydney');
    expect(text).toContain('AUD');
    expect(text).toContain('Free');
    expect(text).toContain('07:00');
    expect(text).toContain('not change them yet');
  });

  it('reads settings and never writes them', async () => {
    await reply(h, '/settings');

    expect(h.identity.settingsReads).toContain(USER);
    // Nothing in the harness's M2 double can be mutated by a handler, and nothing was.
    expect(h.identity.settings.currencyCode).toBe('AUD');
    expect(h.identity.settings.timezone).toBe('Australia/Sydney');
  });

  it('says the timezone is fixed rather than silently omitting it', async () => {
    // M2 enforces immutability in its write path; the UI should not pretend the field
    // does not exist, or the user wonders where their timezone went.
    expect(await reply(h, '/settings')).toContain('fixed when you signed up');
  });

  it('ignores arguments instead of pretending to accept an edit', async () => {
    const text = await reply(h, '/settings currency USD');

    expect(text).toContain('AUD');
    expect(h.identity.settings.currencyCode).toBe('AUD');
  });
});
