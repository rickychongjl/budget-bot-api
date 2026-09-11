import { normalizeCategoryName } from '../ledger';
import { formatMinorUnits, toMinorUnits } from '../shared/money';
import { sanitiseDisplayText } from '../shared/text';
import type { BudgetService } from '../budgets/budget-service';
import type { Category, CategoryService } from '../ledger';
import type { Clock } from '../shared/clock';
import type { CurrencyCode, Id, MinorUnits, RefusalCode, Tier, UserId } from '../shared/common';
import type { EntitlementService } from '../entitlements/entitlement-service';
import type { ReminderSelectionService } from '../allowance/reminder-selection-service';
import type { OnboardingStateStore } from './default-identity-service';
import { RefusalError } from './errors';
import type { IdentityService, UserSettings } from './identity-service';
import type { OnboardingStep } from './onboarding-step';
import {
  CURATED_AU_TIMEZONES,
  canonicalTimezone,
  isLocalDate,
  localDateAt,
  searchTimezones,
} from './timezones';

/**
 * The 5-step `/start` state machine (M2 §Onboarding, resolved at 5 steps — the
 * doc's own open item, see build-log):
 *
 *   1. timezone     curated AU buttons + IANA search      -> IdentityService.setInitialTimezone
 *   2. currency     default AUD, one tap                   -> IdentityService.updateSettings
 *   3. anchor_date  the monthly "budget start date"        -> IdentityService.updateSettings
 *   4. categories   at least 1 category + 1 cap             -> M8 assertAllowed, M3 create, M4 setCap
 *   5. reminders    optional; up to 1 Free / 5 Premium      -> M8 assertAllowed, M5 enable
 *
 * Transport-neutral: M7 turns `OnboardingPrompt.options` into inline buttons whose
 * callback data carries `{ step, value }`, and forwards free text as `{ value }`. All
 * copy is plain text (no Telegram markup) so M7 can send it verbatim; user-supplied
 * names are echoed only through `escapeForPrompt`.
 *
 * This module never writes M3/M4/M5/M8 tables — it collects values and hands them
 * off through those modules' ports (M2 checklist step 3). Where a port's owning module
 * hasn't landed yet (M3 `CategoryService`, M5 `ReminderSelectionService`, and the
 * `toMinorUnits`/`formatMinorUnits` domain functions) the *contract* is called, not
 * stubbed around; production wiring supplies the real implementations.
 *
 * Timezone immutability is not the machine's job: a timezone answer at any step is
 * routed to `setInitialTimezone`, whose write path rejects a change with
 * `TIMEZONE_IMMUTABLE` and accepts an identical replay — so a forged step-1 callback
 * after onboarding, or a second `/start`, cannot move it.
 */

export interface OnboardingInput {
  /** Free text or a button's value. */
  value: string;
  /** Present when the input came from a button; lets a stale/forged callback be detected. */
  step?: OnboardingStep;
}

export interface OnboardingOption {
  label: string;
  value: string;
}

export interface OnboardingPrompt {
  step: OnboardingStep;
  text: string;
  options: readonly OnboardingOption[];
}

export interface CategorySummary {
  id: Id;
  name: string;
  capMinorUnits: MinorUnits | null;
  reminder: boolean;
}

export interface AccountSummary {
  settings: UserSettings;
  tier: Tier;
  categories: readonly CategorySummary[];
}

export type OnboardingReply =
  | { kind: 'prompt'; prompt: OnboardingPrompt }
  /** Step 5 just finished. */
  | { kind: 'complete'; summary: AccountSummary; text: string }
  /** A returning user sent `/start` — settings, not a new account. */
  | { kind: 'summary'; summary: AccountSummary; text: string }
  /** A refusal (capacity, immutable timezone, bad input) — with the prompt to show next, if any. */
  | { kind: 'refused'; code: RefusalCode; message: string; prompt: OnboardingPrompt | null };

export interface OnboardingDeps {
  identity: IdentityService & OnboardingStateStore;
  entitlements: EntitlementService;
  categories: CategoryService;
  budgets: BudgetService;
  reminders: ReminderSelectionService;
  clock: Clock;
  /** Decimal text -> minor units, validated against the currency's exponent. Defaults to M3's `toMinorUnits`. */
  parseAmount?: (decimal: string, currency: CurrencyCode) => MinorUnits;
  /** Minor units -> display string. Defaults to M3's `formatMinorUnits`. */
  formatAmount?: (amount: MinorUnits, currency: CurrencyCode) => string;
}

export const STARTER_CATEGORY = 'Food';
const MAX_CATEGORY_NAME = 40;
const DONE = 'done';
const CATEGORY_LIMIT: Record<Tier, number> = { free: 10, premium: 30 };
const REMINDER_LIMIT: Record<Tier, number> = { free: 1, premium: 5 };

export class OnboardingService {
  private readonly parseAmount: NonNullable<OnboardingDeps['parseAmount']>;
  private readonly formatAmount: NonNullable<OnboardingDeps['formatAmount']>;

  constructor(private readonly deps: OnboardingDeps) {
    this.parseAmount = deps.parseAmount ?? toMinorUnits;
    this.formatAmount = deps.formatAmount ?? formatMinorUnits;
  }

  /** `/start`: resume wherever the user is, or summarise a finished account. */
  async start(userId: UserId): Promise<OnboardingReply> {
    const step = await this.deps.identity.getOnboardingStep(userId);
    if (step === 'done') return this.summaryReply(userId, 'summary');
    if (step === 'categories') await this.ensureStarterCategory(userId);
    return { kind: 'prompt', prompt: await this.promptFor(userId, step) };
  }

  /** Free text or a button press while onboarding (or a stray one afterwards). */
  async answer(userId: UserId, input: OnboardingInput): Promise<OnboardingReply> {
    const current = await this.deps.identity.getOnboardingStep(userId);

    // A button from a step we're no longer on. Timezone is special: the write path
    // decides (identical replay OK, change refused) — this is the "forged callback"
    // path M2's tests call out. Everything else is simply stale.
    if (input.step !== undefined && input.step !== current) {
      if (input.step === 'timezone') {
        return this.guarded(userId, current, async () => {
          await this.deps.identity.setInitialTimezone(userId, input.value);
          return this.start(userId);
        });
      }
      return this.refused(userId, current, 'STALE_ACTION', 'That button is from an earlier step — here is where you are now.');
    }

    if (current === 'done') return this.summaryReply(userId, 'summary');

    return this.guarded(userId, current, () => {
      switch (current) {
        case 'timezone':
          return this.answerTimezone(userId, input.value);
        case 'currency':
          return this.answerCurrency(userId, input.value);
        case 'anchor_date':
          return this.answerAnchorDate(userId, input.value);
        case 'categories':
          return this.answerCategories(userId, input.value);
        case 'reminders':
          return this.answerReminders(userId, input.value);
      }
    });
  }

  // ---- step 1: timezone -----------------------------------------------------------

  private async answerTimezone(userId: UserId, value: string): Promise<OnboardingReply> {
    const canonical = canonicalTimezone(value);
    if (canonical) {
      await this.deps.identity.setInitialTimezone(userId, canonical);
      await this.deps.identity.setOnboardingStep(userId, 'currency');
      return { kind: 'prompt', prompt: await this.promptFor(userId, 'currency') };
    }
    const matches = searchTimezones(value);
    if (matches.length === 0) {
      return {
        kind: 'prompt',
        prompt: {
          step: 'timezone',
          text:
            `I couldn't find a timezone matching "${escapeForPrompt(value)}". ` +
            `Try a city name (e.g. "Auckland" or "London"), or pick one below.`,
          options: curatedTimezoneOptions(),
        },
      };
    }
    return {
      kind: 'prompt',
      prompt: {
        step: 'timezone',
        text: `Did you mean one of these? Tap it, or search again.`,
        options: matches.map((zone) => ({ label: zone, value: zone })),
      },
    };
  }

  // ---- step 2: currency -----------------------------------------------------------

  private async answerCurrency(userId: UserId, value: string): Promise<OnboardingReply> {
    await this.deps.identity.updateSettings(userId, { currencyCode: value.trim().toUpperCase() });
    await this.deps.identity.setOnboardingStep(userId, 'anchor_date');
    return { kind: 'prompt', prompt: await this.promptFor(userId, 'anchor_date') };
  }

  // ---- step 3: budget start date --------------------------------------------------

  private async answerAnchorDate(userId: UserId, value: string): Promise<OnboardingReply> {
    const date = value.trim();
    if (!isLocalDate(date)) {
      throw new RefusalError('INVALID_ARGUMENT', 'Send the date as YYYY-MM-DD (for example 2026-09-01), or tap one of the options.');
    }
    // Hands M4 exactly the shape it expects: a full `LocalDate` anchor from which it
    // derives the monthly start day (`min(day, 28)`), monthly only.
    await this.deps.identity.updateSettings(userId, { periodAnchorDate: date });
    await this.deps.identity.setOnboardingStep(userId, 'categories');
    await this.ensureStarterCategory(userId);
    return { kind: 'prompt', prompt: await this.promptFor(userId, 'categories') };
  }

  // ---- step 4: categories + caps --------------------------------------------------

  private async answerCategories(userId: UserId, raw: string): Promise<OnboardingReply> {
    const value = raw.trim();
    const lower = value.toLowerCase();

    if (lower === DONE) {
      const [categories, budgets] = await Promise.all([
        this.deps.categories.list(userId),
        this.deps.budgets.activeBudgets(userId),
      ]);
      if (categories.length === 0) {
        throw new RefusalError('INVALID_ARGUMENT', 'Add at least one category before moving on — for example "Food 600".');
      }
      const categoryIds = new Set(categories.map((category) => category.id));
      const hasCategoryBudget = budgets.some(
        (budget) => budget.isActive && budget.categoryId !== null && categoryIds.has(budget.categoryId),
      );
      if (!hasCategoryBudget) {
        throw new RefusalError(
          'INVALID_ARGUMENT',
          'Set a monthly budget for at least one category before moving on — for example "Food 600".',
        );
      }
      await this.deps.identity.setOnboardingStep(userId, 'reminders');
      return { kind: 'prompt', prompt: await this.promptFor(userId, 'reminders') };
    }

    if (lower.startsWith('rename ')) {
      const rename = parseRename(value);
      if (!rename) {
        throw new RefusalError('INVALID_ARGUMENT', 'Rename a category with "rename Old name to New name".');
      }
      if (rename.newName.length > MAX_CATEGORY_NAME) {
        throw new RefusalError('INVALID_ARGUMENT', `Category names are limited to ${MAX_CATEGORY_NAME} characters.`);
      }
      const target = await this.findCategory(userId, rename.currentName);
      if (!target) {
        throw new RefusalError(
          'CATEGORY_NOT_FOUND',
          `You don't have a category called "${escapeForPrompt(rename.currentName)}".`,
        );
      }
      await this.deps.categories.rename(userId, target.id, rename.newName);
      return { kind: 'prompt', prompt: await this.promptFor(userId, 'categories') };
    }

    if (lower.startsWith('remove ')) {
      const name = value.slice('remove '.length).trim();
      const target = await this.findCategory(userId, name);
      if (!target) throw new RefusalError('CATEGORY_NOT_FOUND', `You don't have a category called "${escapeForPrompt(name)}".`);
      await this.deps.categories.archive(userId, target.id);
      return { kind: 'prompt', prompt: await this.promptFor(userId, 'categories') };
    }

    const { name, amount } = splitNameAndAmount(value);
    if (name === '') throw new RefusalError('INVALID_ARGUMENT', 'Send a category name, optionally followed by a monthly cap — e.g. "Groceries 500".');
    if (name.length > MAX_CATEGORY_NAME) {
      throw new RefusalError('INVALID_ARGUMENT', `Category names are limited to ${MAX_CATEGORY_NAME} characters.`);
    }

    const settings = await this.deps.identity.getSettings(userId);
    let cap: MinorUnits | null = null;
    if (amount !== null) {
      try {
        cap = this.parseAmount(amount, settings.currencyCode);
      } catch {
        throw new RefusalError('INVALID_ARGUMENT', `"${escapeForPrompt(amount)}" isn't a valid ${settings.currencyCode} amount.`);
      }
      if (cap <= 0n) throw new RefusalError('INVALID_ARGUMENT', 'A cap has to be more than zero.');
    }

    let category = await this.findCategory(userId, name);
    if (!category) {
      // M8 is the gate; M3's `create` re-checks atomically with its own write.
      await this.deps.entitlements.assertAllowed(userId, { kind: 'create_category' });
      category = await this.deps.categories.create(userId, name);
    } else if (cap === null) {
      throw new RefusalError(
        'INVALID_ARGUMENT',
        `You already have "${escapeForPrompt(category.name)}". Send "${escapeForPrompt(category.name)} 500" to give it a cap, or "remove ${escapeForPrompt(category.name)}" to drop it.`,
      );
    }
    if (cap !== null) await this.deps.budgets.setCap(userId, category.id, cap);

    return { kind: 'prompt', prompt: await this.promptFor(userId, 'categories') };
  }

  // ---- step 5: reminder category selection -----------------------------------------

  private async answerReminders(userId: UserId, raw: string): Promise<OnboardingReply> {
    const value = raw.trim();
    const enabled = await this.deps.reminders.enabledCategoryIds(userId);

    if (value.toLowerCase() === DONE) {
      return this.complete(userId);
    }

    const categories = await this.deps.categories.list(userId);
    const target =
      categories.find((c) => c.id === value) ?? categories.find((c) => c.normalizedName === normaliseName(value));
    if (!target) throw new RefusalError('CATEGORY_NOT_FOUND', `You don't have a category called "${escapeForPrompt(value)}".`);

    if (!enabled.includes(target.id)) {
      await this.deps.entitlements.assertAllowed(userId, { kind: 'enable_reminder' });
      await this.deps.reminders.enable(userId, target.id);
    }

    const tier = await this.deps.entitlements.tierOf(userId);
    const now = (await this.deps.reminders.enabledCategoryIds(userId)).length;
    // Limit reached (Free: 1) or every category chosen — nothing left to ask.
    if (now >= REMINDER_LIMIT[tier] || now >= categories.length) return this.complete(userId);
    return { kind: 'prompt', prompt: await this.promptFor(userId, 'reminders') };
  }

  private async complete(userId: UserId): Promise<OnboardingReply> {
    await this.deps.identity.setOnboardingStep(userId, 'done');
    return this.summaryReply(userId, 'complete');
  }

  // ---- prompts --------------------------------------------------------------------

  private async promptFor(userId: UserId, step: OnboardingStep): Promise<OnboardingPrompt> {
    switch (step) {
      case 'timezone':
        return {
          step,
          text:
            "Welcome to Budge Bot! First, which timezone are you in? Tap one below, or type a city name to search " +
            "(e.g. \"Auckland\"). This can't be changed later.",
          options: curatedTimezoneOptions(),
        };
      case 'currency':
        return {
          step,
          text: 'Which currency do you budget in? Tap AUD, or send a 3-letter code (e.g. NZD).',
          options: [{ label: 'AUD', value: 'AUD' }],
        };
      case 'anchor_date': {
        const user = await this.deps.identity.requireUserRecord(userId);
        if (user.timezone === '') {
          throw new RefusalError('ONBOARDING_REQUIRED', 'Choose a timezone before setting your budget start date.');
        }
        const today = localDateAt(this.deps.clock.now(), user.timezone);
        const [year, month] = today.split('-') as [string, string, string];
        const firstOfThisMonth = `${year}-${month}-01`;
        const firstOfNextMonth = addOneMonth(year, month);
        return {
          step,
          text:
            'When does your monthly budget start? Your budget renews on this day every month. ' +
            'Tap an option or send a date as YYYY-MM-DD.',
          options: [
            { label: `Today (${today})`, value: today },
            { label: `1st of this month (${firstOfThisMonth})`, value: firstOfThisMonth },
            { label: `1st of next month (${firstOfNextMonth})`, value: firstOfNextMonth },
          ],
        };
      }
      case 'categories': {
        const [settings, tier, lines] = await Promise.all([
          this.deps.identity.getSettings(userId),
          this.deps.entitlements.tierOf(userId),
          this.categoryLines(userId),
        ]);
        const anchorNote =
          settings.periodAnchorDate && Number(settings.periodAnchorDate.slice(8, 10)) > 28
            ? ' (Months are different lengths, so your cycle will start on the 28th.)'
            : '';
        return {
          step,
          text:
            `Your budget starts on ${settings.periodAnchorDate ?? '?'} and renews monthly.${anchorNote}\n\n` +
            `Now your categories — I've started you off with ${STARTER_CATEGORY}:\n${lines.join('\n')}\n\n` +
            `Add one by sending its name with an optional monthly cap in ${settings.currencyCode}, ` +
            `e.g. "Groceries 500" or just "Fun". Send "${STARTER_CATEGORY} 600" to cap ${STARTER_CATEGORY}, ` +
            `"rename ${STARTER_CATEGORY} to Groceries" to rename it, or "remove ${STARTER_CATEGORY}" to drop it. ` +
            `You can have up to ${CATEGORY_LIMIT[tier]} categories. At least one category must have a monthly budget ` +
            `before you tap Done.`,
          options: [{ label: 'Done', value: DONE }],
        };
      }
      case 'reminders': {
        const [tier, categories, enabled] = await Promise.all([
          this.deps.entitlements.tierOf(userId),
          this.deps.categories.list(userId),
          this.deps.reminders.enabledCategoryIds(userId),
        ]);
        const limit = REMINDER_LIMIT[tier];
        const remaining = categories.filter((c) => !enabled.includes(c.id));
        const chosen = categories.filter((c) => enabled.includes(c.id)).map((c) => c.name);
        const intro =
          chosen.length === 0
            ? `Last step: optionally choose a category for a daily 07:00 reminder, or tap Done to skip. ` +
              (limit === 1 ? 'On the free plan you can pick up to 1.' : `You can pick up to ${limit}.`)
            : `Reminder on: ${chosen.join(', ')}. Pick another (up to ${limit}), or tap Done.`;
        return {
          step,
          text: intro,
          options: [
            ...remaining.map((c) => ({ label: c.name, value: c.id })),
            { label: 'Done', value: DONE },
          ],
        };
      }
      case 'done':
        throw new Error('no prompt for a finished onboarding');
    }
  }

  // ---- summary ---------------------------------------------------------------------

  private async summaryReply(userId: UserId, kind: 'summary' | 'complete'): Promise<OnboardingReply> {
    const summary = await this.summarise(userId);
    const s = summary.settings;
    const anchorDay = s.periodAnchorDate ? Math.min(Number(s.periodAnchorDate.slice(8, 10)), 28) : null;
    const reminderNames = summary.categories.filter((c) => c.reminder).map((c) => c.name);
    const catLine =
      summary.categories.length === 0
        ? 'none yet'
        : summary.categories
            .map((c) => (c.capMinorUnits === null ? c.name : `${c.name} (${this.formatAmount(c.capMinorUnits, s.currencyCode)}/month)`))
            .join(', ');
    const lines = [
      kind === 'complete' ? "You're all set! Here's your setup:" : "You're already set up. Here's your setup:",
      `• Timezone: ${s.timezone} (fixed)`,
      `• Currency: ${s.currencyCode}`,
      `• Budget cycle: monthly, starting on day ${anchorDay ?? '?'} (from ${s.periodAnchorDate ?? '?'})`,
      `• Categories: ${catLine}`,
      `• Daily reminder at ${s.reminderLocalTime}: ${reminderNames.length ? reminderNames.join(', ') : 'none'}`,
      '',
      'Just message me an expense like "coffee 4.50" to log it. /help shows everything else.',
    ];
    return { kind, summary, text: lines.join('\n') };
  }

  async summarise(userId: UserId): Promise<AccountSummary> {
    const [settings, tier, categories, budgets, enabled] = await Promise.all([
      this.deps.identity.getSettings(userId),
      this.deps.entitlements.tierOf(userId),
      this.deps.categories.list(userId),
      this.deps.budgets.activeBudgets(userId),
      this.deps.reminders.enabledCategoryIds(userId),
    ]);
    const capByCategory = new Map<Id, MinorUnits>();
    for (const b of budgets) if (b.categoryId !== null && b.isActive) capByCategory.set(b.categoryId, b.capMinorUnits);
    return {
      settings,
      tier,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        capMinorUnits: capByCategory.get(c.id) ?? null,
        reminder: enabled.includes(c.id),
      })),
    };
  }

  // ---- helpers ---------------------------------------------------------------------

  /** Pre-seed "Food" (round 3: the only starter) — idempotent so a resumed step 4 doesn't duplicate it. */
  private async ensureStarterCategory(userId: UserId): Promise<void> {
    const existing = await this.deps.categories.list(userId, { includeArchived: true });
    if (existing.some((c) => c.normalizedName === normaliseName(STARTER_CATEGORY))) return;
    await this.deps.entitlements.assertAllowed(userId, { kind: 'create_category' });
    await this.deps.categories.create(userId, STARTER_CATEGORY);
  }

  private async findCategory(userId: UserId, name: string): Promise<Category | null> {
    const wanted = normaliseName(name);
    const categories = await this.deps.categories.list(userId);
    return categories.find((c) => c.normalizedName === wanted) ?? null;
  }

  private async categoryLines(userId: UserId): Promise<string[]> {
    const summary = await this.summarise(userId);
    if (summary.categories.length === 0) return ['(none yet)'];
    return summary.categories.map(
      (c) => `• ${c.name}${c.capMinorUnits === null ? ' — no cap' : ` — ${this.formatAmount(c.capMinorUnits, summary.settings.currencyCode)}/month`}`,
    );
  }

  /** Turns a `RefusalError` from any port into a `refused` reply that re-shows the current prompt. */
  private async guarded(
    userId: UserId,
    current: OnboardingStep,
    run: () => Promise<OnboardingReply>,
  ): Promise<OnboardingReply> {
    try {
      return await run();
    } catch (err) {
      if (!RefusalError.is(err)) throw err;
      return this.refused(userId, current, err.code, err.message);
    }
  }

  private async refused(
    userId: UserId,
    current: OnboardingStep,
    code: RefusalCode,
    message: string,
  ): Promise<OnboardingReply> {
    const prompt = current === 'done' ? null : await this.promptFor(userId, current);
    return { kind: 'refused', code, message, prompt };
  }
}

function curatedTimezoneOptions(): OnboardingOption[] {
  return CURATED_AU_TIMEZONES.map((zone) => ({
    label: zone.slice(zone.indexOf('/') + 1).replace(/_/g, ' '),
    value: zone,
  }));
}

/** `"Eating out 300"` -> name `Eating out`, amount `300`; `"Fun"` -> no amount. */
function splitNameAndAmount(value: string): { name: string; amount: string | null } {
  const tokens = value.split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && last !== undefined && /^\$?\d+(?:[.,]\d+)?$/.test(last)) {
    return { name: tokens.slice(0, -1).join(' '), amount: last.replace(/^\$/, '').replace(',', '.') };
  }
  return { name: tokens.join(' '), amount: null };
}

function parseRename(value: string): { currentName: string; newName: string } | null {
  const match = /^rename\s+(.+?)\s+to\s+(.+)$/i.exec(value);
  if (!match) return null;
  const currentName = match[1]?.trim() ?? '';
  const newName = match[2]?.trim() ?? '';
  return currentName === '' || newName === '' ? null : { currentName, newName };
}

/**
 * M3's `normalized_name` rule — case- and whitespace-insensitive. M2 kept its own copy
 * while M3 was a stub; now that M3 owns the rule this delegates, so there is exactly
 * one definition of what makes two category names the same name. Re-exported under
 * M2's original name because `core/identity` already exports it.
 */
export function normaliseName(name: string): string {
  return normalizeCategoryName(name);
}

/**
 * Strip anything that could read as markup or control characters when M7 echoes it.
 * Delegates to `core/shared/text.ts` — one definition for the whole codebase as of
 * M7 4B. Kept under M2's own name so nothing in this module's call sites changed.
 */
function escapeForPrompt(value: string): string {
  return sanitiseDisplayText(value, MAX_CATEGORY_NAME);
}

function addOneMonth(year: string, month: string): string {
  const m = Number(month);
  const y = Number(year);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
