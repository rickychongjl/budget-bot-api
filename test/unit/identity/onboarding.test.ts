import { describe, expect, it } from 'vitest';
import { isIdentityError } from '../../../src/core/identity/errors';
import {
  decodeOnboardingState,
  encodeOnboardingState,
  OnboardingHandoffError,
  type OnboardingState,
} from '../../../src/core/identity/onboarding';
import { harness, onboarded, registered } from './doubles';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isIdentityError(error) ? error.code : `unexpected: ${String(error)}`;
  }
}

/** Walk a fresh user through steps 1–3 and return the step-4 state. */
async function toCategoriesStep(h: ReturnType<typeof harness>, externalId = '1001') {
  const userId = await registered(h, externalId);
  let { state } = await h.onboarding.begin(userId);
  ({ state } = await h.onboarding.apply(state, { type: 'choose_timezone', timezone: 'Australia/Brisbane' }));
  ({ state } = await h.onboarding.apply(state, { type: 'choose_currency' }));
  ({ state } = await h.onboarding.apply(state, { type: 'choose_anchor_date', date: '2026-09-01' }));
  return { userId, state };
}

describe('happy path — 5 steps', () => {
  it('walks timezone → currency → anchor date → categories+caps → reminders → complete', async () => {
    const h = harness('2026-09-06T00:30:00.000Z'); // 10:30 Brisbane
    const userId = await registered(h);

    // 1. timezone — asked first, curated list offered
    let out = await h.onboarding.begin(userId);
    expect(out.state.step).toBe('timezone');
    expect(out.prompt.step).toBe('timezone');
    if (out.prompt.step === 'timezone') {
      expect(out.prompt.suggestions.map((s) => s.id)).toContain('Australia/Brisbane');
    }
    out = await h.onboarding.apply(out.state, { type: 'choose_timezone', timezone: 'Australia/Brisbane' });

    // 2. currency — default AUD, confirmed with one tap
    expect(out.prompt).toEqual({ step: 'currency', defaultCurrencyCode: 'AUD' });
    out = await h.onboarding.apply(out.state, { type: 'choose_currency' });

    // 3. anchor date — suggested date is today in the user's zone, from the clock
    expect(out.prompt).toEqual({ step: 'anchor_date', suggestedDate: '2026-09-06' });
    out = await h.onboarding.apply(out.state, { type: 'choose_anchor_date', date: '2026-09-01' });

    const settings = await h.identity.getSettings(userId);
    expect(settings).toEqual({
      timezone: 'Australia/Brisbane',
      currencyCode: 'AUD',
      periodAnchorDate: '2026-09-01',
      reminderLocalTime: '07:00',
    });

    // 4. categories — Food pre-seeded, add two more, cap one
    expect(out.prompt.step).toBe('categories');
    expect(out.state.categories.map((c) => c.name)).toEqual(['Food']);
    out = await h.onboarding.apply(out.state, { type: 'update_category', name: 'food', capMinorUnits: 60_000n });
    out = await h.onboarding.apply(out.state, { type: 'add_category', name: '  Fun   money ' });
    out = await h.onboarding.apply(out.state, { type: 'add_category', name: 'Transport', capMinorUnits: 20_000n });
    expect(out.state.categories.map((c) => c.name)).toEqual(['Food', 'Fun money', 'Transport']);
    expect(h.ledger.created).toHaveLength(0); // nothing handed off until confirm

    out = await h.onboarding.apply(out.state, { type: 'confirm_categories' });
    expect(h.ledger.created.map((c) => c.name)).toEqual(['Food', 'Fun money', 'Transport']);
    expect(h.budgets.caps).toEqual([
      { categoryId: 'cat-1', cap: 60_000n },
      { categoryId: 'cat-3', cap: 20_000n },
    ]);
    // M8 gated every creation, before it happened.
    expect(h.entitlements.asserted).toEqual(['create_category', 'create_category', 'create_category']);
    expect(out.state.categories.every((c) => c.categoryId !== null)).toBe(true);

    // 5. reminders — Free tier: exactly one
    expect(out.prompt.step).toBe('reminders');
    if (out.prompt.step === 'reminders') expect(out.prompt.limit).toBe(1);
    out = await h.onboarding.apply(out.state, { type: 'select_reminder', name: 'Food', selected: true });
    expect(await codeOf(h.onboarding.apply(out.state, { type: 'select_reminder', name: 'Transport', selected: true }))).toBe(
      'REMINDER_CATEGORY_LIMIT',
    );
    out = await h.onboarding.apply(out.state, { type: 'confirm_reminders' });

    expect(out.state.step).toBe('complete');
    expect(out.prompt.step).toBe('complete');
    expect(h.reminders.enabled).toEqual(['cat-1']);
    expect(h.entitlements.asserted.at(-1)).toBe('enable_reminder');

    // 6. (not a step) — `/start` again: a summary, not a new account, not step 1
    const again = await h.onboarding.begin(userId);
    expect(again.prompt).toEqual({ step: 'summary', settings });
    expect(h.repo.users.size).toBe(1);
  });

  it('Premium tier allows up to 5 reminder categories and 30 categories', async () => {
    const h = harness();
    h.entitlements.tier = 'premium';
    let { state } = await toCategoriesStep(h);
    for (let i = 1; i <= 29; i++) {
      ({ state } = await h.onboarding.apply(state, { type: 'add_category', name: `C${i}` }));
    }
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: 'C30' }))).toBe('CATEGORY_LIMIT');
    ({ state } = await h.onboarding.apply(state, { type: 'confirm_categories' }));
    for (const name of ['Food', 'C1', 'C2', 'C3', 'C4']) {
      ({ state } = await h.onboarding.apply(state, { type: 'select_reminder', name, selected: true }));
    }
    expect(await codeOf(h.onboarding.apply(state, { type: 'select_reminder', name: 'C5', selected: true }))).toBe(
      'REMINDER_CATEGORY_LIMIT',
    );
    // Deselecting frees a slot.
    ({ state } = await h.onboarding.apply(state, { type: 'select_reminder', name: 'C4', selected: false }));
    ({ state } = await h.onboarding.apply(state, { type: 'select_reminder', name: 'C5', selected: true }));
    ({ state } = await h.onboarding.apply(state, { type: 'confirm_reminders' }));
    expect(h.reminders.enabled).toHaveLength(5);
  });
});

describe('step 1 — timezone', () => {
  it('search returns IANA matches for anything outside the curated list', async () => {
    const h = harness();
    const userId = await registered(h);
    const { state } = await h.onboarding.begin(userId);
    const out = await h.onboarding.apply(state, { type: 'search_timezone', query: 'auck' });
    expect(out.state.step).toBe('timezone'); // unchanged
    expect(out.prompt.step === 'timezone' && out.prompt.searchResults?.[0]?.id).toBe('Pacific/Auckland');
  });

  it('an invalid zone is INVALID_ARGUMENT and the state does not advance', async () => {
    const h = harness();
    const userId = await registered(h);
    const { state } = await h.onboarding.begin(userId);
    expect(await codeOf(h.onboarding.apply(state, { type: 'choose_timezone', timezone: 'Nowhere/Land' }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect((await h.identity.getSettings(userId)).timezone).toBe('');
  });

  it('a forged step-1 callback for an onboarded user is TIMEZONE_IMMUTABLE', async () => {
    const h = harness();
    const userId = await onboarded(h, '1001', 'Australia/Brisbane');
    const forgedState: OnboardingState = { userId, step: 'timezone', categories: [] };
    expect(
      await codeOf(h.onboarding.apply(forgedState, { type: 'choose_timezone', timezone: 'Australia/Perth' })),
    ).toBe('TIMEZONE_IMMUTABLE');
    expect((await h.identity.getSettings(userId)).timezone).toBe('Australia/Brisbane');
  });

  it('a second /start never re-asks step 1 once the timezone is set', async () => {
    const h = harness();
    const userId = await registered(h);
    let { state } = await h.onboarding.begin(userId);
    ({ state } = await h.onboarding.apply(state, { type: 'choose_timezone', timezone: 'Australia/Hobart' }));

    // Gateway lost its state (or the user typed /start mid-flow): resume at step 2.
    const resumed = await h.onboarding.begin(userId);
    expect(resumed.state.step).toBe('currency');

    // Gateway still holds a stale step-1 state: reconciled forward, not replayed.
    const stale: OnboardingState = { userId, step: 'timezone', categories: [] };
    const reconciled = await h.onboarding.begin(userId, stale);
    expect(reconciled.state.step).toBe('currency');
  });
});

describe('step 2/3 — currency and anchor date', () => {
  it('an explicit currency choice is written; the default is a no-op write', async () => {
    const h = harness();
    const userId = await registered(h);
    let { state } = await h.onboarding.begin(userId);
    ({ state } = await h.onboarding.apply(state, { type: 'choose_timezone', timezone: 'Pacific/Auckland' }));
    const out = await h.onboarding.apply(state, { type: 'choose_currency', currencyCode: 'NZD' });
    expect(out.state.step).toBe('anchor_date');
    expect((await h.identity.getSettings(userId)).currencyCode).toBe('NZD');
  });

  it('a bad anchor date is INVALID_ARGUMENT; wrong-step input is STALE_ACTION', async () => {
    const h = harness();
    const userId = await registered(h);
    let { state } = await h.onboarding.begin(userId);
    ({ state } = await h.onboarding.apply(state, { type: 'choose_timezone', timezone: 'Australia/Perth' }));
    ({ state } = await h.onboarding.apply(state, { type: 'choose_currency' }));
    expect(await codeOf(h.onboarding.apply(state, { type: 'choose_anchor_date', date: '2026-13-01' }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.onboarding.apply(state, { type: 'confirm_categories' }))).toBe('STALE_ACTION');
    expect(await codeOf(h.onboarding.apply(state, { type: 'choose_timezone', timezone: 'Australia/Perth' }))).toBe(
      'STALE_ACTION',
    );
  });

  it('resuming a saved step-2/3 state after the anchor date landed jumps to categories with Food seeded', async () => {
    const h = harness();
    const userId = await onboarded(h);
    const saved: OnboardingState = { userId, step: 'anchor_date', categories: [] };
    const out = await h.onboarding.begin(userId, saved);
    expect(out.state.step).toBe('categories');
    expect(out.state.categories.map((c) => c.name)).toEqual(['Food']);
  });
});

describe('step 4 — categories', () => {
  it('Food can be edited or removed before hand-off; names are unique case-insensitively', async () => {
    const h = harness();
    let { state } = await toCategoriesStep(h);
    ({ state } = await h.onboarding.apply(state, { type: 'update_category', name: 'Food', newName: 'Groceries' }));
    expect(state.categories.map((c) => c.name)).toEqual(['Groceries']);
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: 'groceries' }))).toBe(
      'INVALID_ARGUMENT',
    );
    ({ state } = await h.onboarding.apply(state, { type: 'remove_category', name: 'GROCERIES' }));
    expect(state.categories).toEqual([]);
    expect(await codeOf(h.onboarding.apply(state, { type: 'remove_category', name: 'Groceries' }))).toBe(
      'CATEGORY_NOT_FOUND',
    );
  });

  it('rejects empty names, over-long names, and non-positive caps', async () => {
    const h = harness();
    const { state } = await toCategoriesStep(h);
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: '   ' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: 'x'.repeat(41) }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: 'Fun', capMinorUnits: 0n }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: 'Fun', capMinorUnits: -5n }))).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('Free tier caps the draft at 10 categories', async () => {
    const h = harness();
    let { state } = await toCategoriesStep(h);
    for (let i = 1; i <= 9; i++) {
      ({ state } = await h.onboarding.apply(state, { type: 'add_category', name: `C${i}` }));
    }
    expect(await codeOf(h.onboarding.apply(state, { type: 'add_category', name: 'C10' }))).toBe('CATEGORY_LIMIT');
  });

  it('confirming with no categories skips step 5 and completes', async () => {
    const h = harness();
    let { state } = await toCategoriesStep(h);
    ({ state } = await h.onboarding.apply(state, { type: 'remove_category', name: 'Food' }));
    const out = await h.onboarding.apply(state, { type: 'confirm_categories' });
    expect(out.state.step).toBe('complete');
    expect(h.ledger.created).toEqual([]);
  });

  it('a partial hand-off failure surfaces the progress made, and a retry does not recreate categories', async () => {
    const h = harness();
    let { state } = await toCategoriesStep(h);
    ({ state } = await h.onboarding.apply(state, { type: 'add_category', name: 'Fun', capMinorUnits: 5_000n }));
    ({ state } = await h.onboarding.apply(state, { type: 'add_category', name: 'Bills' }));
    h.ledger.failCreateFor = 'Bills';

    const error = await h.onboarding.apply(state, { type: 'confirm_categories' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OnboardingHandoffError);
    const partial = (error as OnboardingHandoffError).state;
    expect(partial.step).toBe('categories');
    expect(partial.categories.map((c) => c.categoryId)).toEqual(['cat-1', 'cat-2', null]);
    expect(partial.categories[1]?.capCommitted).toBe(true);
    expect(h.ledger.created.map((c) => c.name)).toEqual(['Food', 'Fun']);

    // Once M3 is back, retrying from the partial state only creates what's missing.
    h.ledger.failCreateFor = null;
    const out = await h.onboarding.apply(partial, { type: 'confirm_categories' });
    expect(out.state.step).toBe('reminders');
    expect(h.ledger.created.map((c) => c.name)).toEqual(['Food', 'Fun', 'Bills']);
    expect(h.budgets.caps).toEqual([{ categoryId: 'cat-2', cap: 5_000n }]); // not set twice
  });

  it('an M8 refusal at hand-off is surfaced with its code and stops before M3 is called', async () => {
    const h = harness();
    const { state } = await toCategoriesStep(h);
    h.entitlements.refuse = 'create_category';
    const error = await h.onboarding.apply(state, { type: 'confirm_categories' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OnboardingHandoffError);
    expect(h.ledger.created).toEqual([]);
  });

  it('a handed-off category can no longer be edited or removed in this flow', async () => {
    const h = harness();
    let { state } = await toCategoriesStep(h);
    h.ledger.failCreateFor = 'Zzz';
    ({ state } = await h.onboarding.apply(state, { type: 'add_category', name: 'Zzz' }));
    const partial = (
      (await h.onboarding.apply(state, { type: 'confirm_categories' }).catch((e: unknown) => e)) as OnboardingHandoffError
    ).state;
    expect(await codeOf(h.onboarding.apply(partial, { type: 'remove_category', name: 'Food' }))).toBe('STALE_ACTION');
    expect(await codeOf(h.onboarding.apply(partial, { type: 'update_category', name: 'Food', newName: 'F' }))).toBe(
      'STALE_ACTION',
    );
  });
});

describe('step 5 — reminders', () => {
  it('a partial reminder hand-off is retryable without double-enabling', async () => {
    const h = harness();
    h.entitlements.tier = 'premium';
    let { state } = await toCategoriesStep(h);
    ({ state } = await h.onboarding.apply(state, { type: 'add_category', name: 'Fun' }));
    ({ state } = await h.onboarding.apply(state, { type: 'confirm_categories' }));
    ({ state } = await h.onboarding.apply(state, { type: 'select_reminder', name: 'Food', selected: true }));
    ({ state } = await h.onboarding.apply(state, { type: 'select_reminder', name: 'Fun', selected: true }));

    h.reminders.failFor = 'cat-2';
    const error = await h.onboarding.apply(state, { type: 'confirm_reminders' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OnboardingHandoffError);
    const partial = (error as OnboardingHandoffError).state;
    expect(partial.categories.map((c) => c.reminderCommitted)).toEqual([true, false]);

    h.reminders.failFor = null;
    const out = await h.onboarding.apply(partial, { type: 'confirm_reminders' });
    expect(out.state.step).toBe('complete');
    expect(h.reminders.enabled).toEqual(['cat-1', 'cat-2']);
  });

  it('input for a finished flow is STALE_ACTION', async () => {
    const h = harness();
    const userId = await onboarded(h);
    const done: OnboardingState = { userId, step: 'complete', categories: [] };
    expect(await codeOf(h.onboarding.apply(done, { type: 'confirm_reminders' }))).toBe('STALE_ACTION');
  });
});

describe('state persistence', () => {
  it('round-trips through encode/decode including the bigint cap', () => {
    const state: OnboardingState = {
      userId: 'u-1',
      step: 'categories',
      categories: [
        {
          name: 'Food',
          capMinorUnits: 12_345_678_901_234n,
          categoryId: 'cat-9',
          capCommitted: true,
          reminder: true,
          reminderCommitted: false,
        },
        { name: 'Fun', capMinorUnits: null, categoryId: null, capCommitted: false, reminder: false, reminderCommitted: false },
      ],
    };
    const json = encodeOnboardingState(state);
    expect(JSON.parse(json).categories[0].capMinorUnits).toBe('12345678901234');
    expect(decodeOnboardingState(json)).toEqual(state);
  });

  it('rejects malformed state', () => {
    expect(() => decodeOnboardingState('nope')).toThrow(/valid JSON/);
    expect(() => decodeOnboardingState('{"v":1,"userId":"u","step":"launch","categories":[]}')).toThrow(/shape/);
    expect(() =>
      decodeOnboardingState('{"v":1,"userId":"u","step":"categories","categories":[{"name":"x","capMinorUnits":"1.5"}]}'),
    ).toThrow(/shape/);
  });
});
