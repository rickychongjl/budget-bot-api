import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityServiceImpl } from '../../../src/core/identity/identity-service';
import { OnboardingService, STARTER_CATEGORY } from '../../../src/core/identity/onboarding';
import type { OnboardingReply } from '../../../src/core/identity/onboarding';
import { InMemoryIdentityRepository } from '../../../src/core/testing/in-memory-identity-repository';
import { TestClock } from '../../../src/core/testing/test-clock';
import {
  FakeBudgets,
  FakeCategories,
  FakeEntitlements,
  FakeLedger,
  FakeReminders,
  formatTwoDecimals,
  parseTwoDecimals,
} from './fakes';

/**
 * The 5-step `/start` machine end to end, against fakes of the M3/M4/M5/M8 ports it
 * hands off to. Asserts the hand-off *shapes* (what M2 gives each port), the tier
 * gating being routed through M8, and that timezone cannot move through any path
 * the machine exposes.
 */

let repo: InMemoryIdentityRepository;
let clock: TestClock;
let identity: IdentityServiceImpl;
let categories: FakeCategories;
let budgets: FakeBudgets;
let reminders: FakeReminders;
let entitlements: FakeEntitlements;
let onboarding: OnboardingService;

beforeEach(() => {
  repo = new InMemoryIdentityRepository();
  // 2026-09-06 09:00 Sydney (AEST, UTC+10) — 2026-09-05 23:00 UTC, so "today" differs by zone.
  clock = new TestClock('2026-09-05T23:00:00.000Z');
  identity = new IdentityServiceImpl(repo, clock, new FakeLedger());
  categories = new FakeCategories();
  budgets = new FakeBudgets();
  reminders = new FakeReminders();
  entitlements = new FakeEntitlements(categories, reminders);
  onboarding = new OnboardingService({
    identity,
    entitlements,
    categories,
    budgets,
    reminders,
    clock,
    parseAmount: parseTwoDecimals,
    formatAmount: formatTwoDecimals,
  });
});

function prompt(reply: OnboardingReply) {
  if (reply.kind !== 'prompt') throw new Error(`expected prompt, got ${reply.kind}: ${JSON.stringify(reply)}`);
  return reply.prompt;
}

async function newUser(externalId = '1') {
  return (await identity.register('telegram', externalId, externalId, 'ricky')).userId;
}

/** Drives steps 1–3 so tests can focus on 4 and 5. */
async function throughStep3(userId: string) {
  await onboarding.answer(userId, { value: 'Australia/Sydney', step: 'timezone' });
  await onboarding.answer(userId, { value: 'AUD', step: 'currency' });
  return onboarding.answer(userId, { value: '2026-09-01', step: 'anchor_date' });
}

describe('happy path — 5 steps', () => {
  it('walks timezone -> currency -> budget start date -> categories -> reminders -> done', async () => {
    const userId = await newUser();

    // 1. timezone: curated AU buttons, cannot be skipped.
    const p1 = prompt(await onboarding.start(userId));
    expect(p1.step).toBe('timezone');
    expect(p1.options.map((o) => o.value)).toContain('Australia/Brisbane');
    expect(p1.options.find((o) => o.value === 'Australia/Sydney')?.label).toBe('Sydney');

    const p2 = prompt(await onboarding.answer(userId, { value: 'Australia/Sydney', step: 'timezone' }));
    expect(p2.step).toBe('currency');
    expect(p2.options).toEqual([{ label: 'AUD', value: 'AUD' }]);
    expect((await repo.findUser(userId))?.timezone).toBe('Australia/Sydney');

    // 2. currency: one tap.
    const p3 = prompt(await onboarding.answer(userId, { value: 'AUD', step: 'currency' }));
    expect(p3.step).toBe('anchor_date');
    // "Today" is the user's local date (Sydney), not UTC's.
    expect(p3.options.map((o) => o.value)).toEqual(['2026-09-06', '2026-09-01', '2026-10-01']);

    // 3. budget start date -> periodAnchorDate, the shape M4 derives the monthly cycle from.
    const p4 = prompt(await onboarding.answer(userId, { value: '2026-09-01', step: 'anchor_date' }));
    expect(p4.step).toBe('categories');
    expect((await identity.getSettings(userId)).periodAnchorDate).toBe('2026-09-01');

    // 4. "Food" is pre-seeded through M8's gate and M3's create — not written by M2.
    expect(entitlements.assertions).toEqual(['create_category']);
    expect((await categories.list(userId)).map((c) => c.name)).toEqual([STARTER_CATEGORY]);
    expect(p4.text).toContain('Food — no cap');
    expect(p4.options).toEqual([{ label: 'Done', value: 'done' }]);

    // Cap Food, add two more (one capped, one not), remove one.
    prompt(await onboarding.answer(userId, { value: 'Food 600' }));
    prompt(await onboarding.answer(userId, { value: 'Eating out 250.50' }));
    prompt(await onboarding.answer(userId, { value: 'Fun' }));
    const p5 = prompt(await onboarding.answer(userId, { value: 'remove Fun' }));
    expect(p5.text).toContain('Food — AUD 600.00/month');
    expect(p5.text).toContain('Eating out — AUD 250.50/month');
    expect(p5.text).not.toContain('• Fun');

    const foodId = (await categories.list(userId)).find((c) => c.name === 'Food')?.id;
    expect(budgets.rows.map((b) => [b.categoryId, b.capMinorUnits])).toEqual([
      [foodId, 60000n],
      [expect.any(String), 25050n],
    ]);

    // 5. reminders: Free picks 1 — the machine completes as soon as the limit is reached.
    const p6 = prompt(await onboarding.answer(userId, { value: 'done', step: 'categories' }));
    expect(p6.step).toBe('reminders');
    expect(p6.text).toContain('07:00');
    expect(p6.options.map((o) => o.label)).toEqual(['Food', 'Eating out']);

    const done = await onboarding.answer(userId, { value: foodId ?? '', step: 'reminders' });
    expect(done.kind).toBe('complete');
    if (done.kind !== 'complete') return;
    expect(entitlements.assertions.at(-1)).toBe('enable_reminder');
    expect(await reminders.enabledCategoryIds(userId)).toEqual([foodId]);
    expect(done.summary.settings).toEqual({
      timezone: 'Australia/Sydney',
      currencyCode: 'AUD',
      periodAnchorDate: '2026-09-01',
      reminderLocalTime: '07:00',
    });
    expect(done.summary.categories).toEqual([
      { id: foodId, name: 'Food', capMinorUnits: 60000n, reminder: true },
      { id: expect.any(String), name: 'Eating out', capMinorUnits: 25050n, reminder: false },
    ]);
    expect(done.text).toContain('Timezone: Australia/Sydney (fixed)');
    expect(done.text).toContain('starting on day 1');
    expect((await identity.resolve('telegram', '1'))?.onboarded).toBe(true);
  });

  it('a repeat /start after completion returns a settings summary, not a new account', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    await onboarding.answer(userId, { value: 'done' });
    await onboarding.answer(userId, { value: 'Food' });

    const again = await onboarding.start(userId);
    expect(again.kind).toBe('summary');
    expect(repo.users.size).toBe(1);
    // ...and the transport-level register call is idempotent too.
    const re = await identity.register('telegram', '1', '1', 'ricky');
    expect(re).toEqual({ userId, isNew: false, onboarded: true });
    expect(repo.users.size).toBe(1);
    // Free text after completion is not swallowed as an onboarding answer.
    expect((await onboarding.answer(userId, { value: 'coffee 4.50' })).kind).toBe('summary');
  });

  it('/start mid-flow resumes at the current step (and re-seeds nothing twice)', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    expect(prompt(await onboarding.start(userId)).step).toBe('categories');
    expect(prompt(await onboarding.start(userId)).step).toBe('categories');
    expect((await categories.list(userId, { includeArchived: true })).length).toBe(1);
  });
});

describe('step 1 — timezone search', () => {
  it('searches IANA for anything off the curated list and accepts a tapped result', async () => {
    const userId = await newUser();
    await onboarding.start(userId);
    const search = prompt(await onboarding.answer(userId, { value: 'auckland' }));
    expect(search.step).toBe('timezone');
    expect(search.options.map((o) => o.value)).toEqual(['Pacific/Auckland']);

    const next = prompt(await onboarding.answer(userId, { value: 'Pacific/Auckland', step: 'timezone' }));
    expect(next.step).toBe('currency');
    expect((await repo.findUser(userId))?.timezone).toBe('Pacific/Auckland');
  });

  it('re-prompts with the curated list when nothing matches', async () => {
    const userId = await newUser();
    const p = prompt(await onboarding.answer(userId, { value: 'zzzz' }));
    expect(p.step).toBe('timezone');
    expect(p.text).toContain("couldn't find");
    expect(p.options.map((o) => o.value)).toContain('Australia/Melbourne');
    expect((await repo.findUser(userId))?.timezone).toBeNull();
  });
});

describe('timezone cannot move through the machine', () => {
  it('a forged step-1 callback mid-flow is TIMEZONE_IMMUTABLE and leaves the user where they were', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    const reply = await onboarding.answer(userId, { value: 'Australia/Perth', step: 'timezone' });
    expect(reply.kind).toBe('refused');
    if (reply.kind !== 'refused') return;
    expect(reply.code).toBe('TIMEZONE_IMMUTABLE');
    expect(reply.prompt?.step).toBe('categories');
    expect((await repo.findUser(userId))?.timezone).toBe('Australia/Sydney');
  });

  it('a forged step-1 callback after completion is TIMEZONE_IMMUTABLE; an identical replay just re-summarises', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    await onboarding.answer(userId, { value: 'done' });
    await onboarding.answer(userId, { value: 'Food' });

    const forged = await onboarding.answer(userId, { value: 'Australia/Perth', step: 'timezone' });
    expect(forged).toMatchObject({ kind: 'refused', code: 'TIMEZONE_IMMUTABLE', prompt: null });

    const replay = await onboarding.answer(userId, { value: 'Australia/Sydney', step: 'timezone' });
    expect(replay.kind).toBe('summary');
    expect((await repo.findUser(userId))?.timezone).toBe('Australia/Sydney');
  });

  it('a stale non-timezone callback is STALE_ACTION with the current prompt', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    const reply = await onboarding.answer(userId, { value: 'NZD', step: 'currency' });
    expect(reply).toMatchObject({ kind: 'refused', code: 'STALE_ACTION' });
    if (reply.kind === 'refused') expect(reply.prompt?.step).toBe('categories');
    expect((await identity.getSettings(userId)).currencyCode).toBe('AUD');
  });
});

describe('step 2 / 3 validation', () => {
  it('rejects an unknown currency and re-prompts', async () => {
    const userId = await newUser();
    await onboarding.answer(userId, { value: 'Australia/Sydney' });
    const reply = await onboarding.answer(userId, { value: 'XXX' });
    expect(reply).toMatchObject({ kind: 'refused', code: 'INVALID_ARGUMENT' });
    if (reply.kind === 'refused') expect(reply.prompt?.step).toBe('currency');
    expect(await identity.onboardingStep(userId)).toBe('currency');
  });

  it('accepts a typed non-default currency', async () => {
    const userId = await newUser();
    await onboarding.answer(userId, { value: 'Pacific/Auckland' });
    prompt(await onboarding.answer(userId, { value: 'nzd' }));
    expect((await identity.getSettings(userId)).currencyCode).toBe('NZD');
  });

  it('rejects a bad date and re-prompts with the date options', async () => {
    const userId = await newUser();
    await onboarding.answer(userId, { value: 'Australia/Sydney' });
    await onboarding.answer(userId, { value: 'AUD' });
    const reply = await onboarding.answer(userId, { value: '1/9/2026' });
    expect(reply).toMatchObject({ kind: 'refused', code: 'INVALID_ARGUMENT' });
    if (reply.kind === 'refused') expect(reply.prompt?.options.length).toBe(3);
    expect((await identity.getSettings(userId)).periodAnchorDate).toBeNull();
  });

  it('warns when the chosen day is past the 28th (M4 caps the start day)', async () => {
    const userId = await newUser();
    await onboarding.answer(userId, { value: 'Australia/Sydney' });
    await onboarding.answer(userId, { value: 'AUD' });
    const p = prompt(await onboarding.answer(userId, { value: '2026-08-31' }));
    expect(p.text).toContain('28th');
  });
});

describe('step 4 — capacity and input rules', () => {
  it('routes every create through M8 and surfaces CATEGORY_LIMIT without writing', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    // A trailing number is the cap syntax ("Cat 2" = cap Cat at 2), so names must not end in one.
    for (let i = 2; i <= 10; i++) prompt(await onboarding.answer(userId, { value: `Cat${i}` }));
    expect((await categories.list(userId)).length).toBe(10);

    const reply = await onboarding.answer(userId, { value: 'One too many' });
    expect(reply).toMatchObject({ kind: 'refused', code: 'CATEGORY_LIMIT' });
    if (reply.kind === 'refused') expect(reply.prompt?.step).toBe('categories');
    expect((await categories.list(userId)).length).toBe(10);
    expect(entitlements.assertions.filter((k) => k === 'create_category')).toHaveLength(11);
  });

  it('premium gets the wider limit from the same port', async () => {
    const userId = await newUser();
    entitlements.tiers.set(userId, 'premium');
    const p = prompt(await throughStep3(userId));
    expect(p.text).toContain('up to 30 categories');
  });

  it('a duplicate name without a cap is explained; with a cap it updates the cap', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    const dup = await onboarding.answer(userId, { value: 'food' });
    expect(dup).toMatchObject({ kind: 'refused', code: 'INVALID_ARGUMENT' });
    prompt(await onboarding.answer(userId, { value: 'FOOD 300' }));
    expect(budgets.rows).toHaveLength(1);
    expect(budgets.rows[0]?.capMinorUnits).toBe(30000n);
    expect((await categories.list(userId)).length).toBe(1);
  });

  it('rejects a malformed cap and a zero cap without creating anything', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    expect(await onboarding.answer(userId, { value: 'Fun 12.345' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await onboarding.answer(userId, { value: 'Fun 0' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await categories.list(userId)).map((c) => c.name)).toEqual(['Food']);
  });

  it('refuses to finish step 4 with no categories', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    prompt(await onboarding.answer(userId, { value: 'remove Food' }));
    const reply = await onboarding.answer(userId, { value: 'done' });
    expect(reply).toMatchObject({ kind: 'refused', code: 'INVALID_ARGUMENT' });
    expect(await identity.onboardingStep(userId)).toBe('categories');
  });
});

describe('step 5 — reminder selection', () => {
  it('free tier: a second selection is REMINDER_CATEGORY_LIMIT from M8 (belt and braces)', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    prompt(await onboarding.answer(userId, { value: 'Fun' }));
    await onboarding.answer(userId, { value: 'done' });
    await reminders.enable(userId, (await categories.list(userId))[0]?.id ?? ''); // simulate a prior selection
    const reply = await onboarding.answer(userId, { value: 'Fun' });
    expect(reply).toMatchObject({ kind: 'refused', code: 'REMINDER_CATEGORY_LIMIT' });
  });

  it('premium: picks several, Done finishes; the summary lists them all', async () => {
    const userId = await newUser();
    entitlements.tiers.set(userId, 'premium');
    await throughStep3(userId);
    prompt(await onboarding.answer(userId, { value: 'Fun' }));
    prompt(await onboarding.answer(userId, { value: 'Transport' }));
    const p = prompt(await onboarding.answer(userId, { value: 'done' }));
    expect(p.text).toContain('up to 5');

    prompt(await onboarding.answer(userId, { value: 'Food' }));
    const p2 = prompt(await onboarding.answer(userId, { value: 'fun' }));
    expect(p2.options.map((o) => o.label)).toEqual(['Transport', 'Done']);
    const done = await onboarding.answer(userId, { value: 'done', step: 'reminders' });
    expect(done.kind).toBe('complete');
    if (done.kind === 'complete') {
      expect(done.summary.categories.filter((c) => c.reminder).map((c) => c.name)).toEqual(['Food', 'Fun']);
      expect(done.text).toContain('Daily reminder at 07:00: Food, Fun');
    }
  });

  it('requires at least one reminder category before Done', async () => {
    const userId = await newUser();
    await throughStep3(userId);
    await onboarding.answer(userId, { value: 'done' });
    expect(await onboarding.answer(userId, { value: 'done' })).toMatchObject({ kind: 'refused', code: 'INVALID_ARGUMENT' });
    expect(await onboarding.answer(userId, { value: 'Nope' })).toMatchObject({ kind: 'refused', code: 'CATEGORY_NOT_FOUND' });
    expect(await identity.onboardingStep(userId)).toBe('reminders');
  });
});
