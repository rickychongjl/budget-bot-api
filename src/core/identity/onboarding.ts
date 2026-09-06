import type { BudgetService } from '../ports/budget-service';
import type { Clock } from '../ports/clock';
import type { CurrencyCode, Id, LocalDate, MinorUnits, Tier, UserId } from '../ports/common';
import type { EntitlementService } from '../ports/entitlement-service';
import type { IdentityService, UserSettings } from '../ports/identity-service';
import type { LedgerService } from '../ports/ledger-service';
import { IdentityError } from './errors';
import { hasCompletedCoreOnboarding } from './identity-service';
import { CURATED_AU_TIMEZONES, searchTimezones, type TimezoneOption } from './timezones';
import { localDateAt, validateCurrencyCode, validateLocalDate } from './validation';

/**
 * The 5-step `/start` onboarding state machine (M2 "Onboarding", round 3):
 *
 *   1. timezone     → `IdentityService.setInitialTimezone` (set once, ever)
 *   2. currency     → `IdentityService.updateSettings({ currencyCode })`
 *   3. anchor_date  → `IdentityService.updateSettings({ periodAnchorDate })`
 *   4. categories   → draft list ("Food" pre-seeded), handed to M3 (`createCategory`)
 *                     + M4 (`setCap`) on confirm, each gated by M8 (`assertAllowed`)
 *   5. reminders    → selection handed to M5 via `ReminderSelectionPort`, gated by M8
 *
 * Channel-agnostic: the gateway (M7, Phase 4) turns `OnboardingPrompt` into text and
 * buttons, turns replies/callbacks into `OnboardingInput`, and persists
 * `OnboardingState` between turns (`encodeOnboardingState` / `decodeOnboardingState`
 * — the state carries a `bigint` cap so it is not plain JSON). This module owns no
 * conversation-state table.
 *
 * The service is stateless: `apply(state, input)` returns the next state and prompt;
 * on a refusal it throws an `IdentityError` and the caller keeps its previous state.
 * The one exception is a partial hand-off failure in steps 4/5, which throws
 * `OnboardingHandoffError` carrying the progress made so a retry doesn't recreate
 * categories M3 already has.
 */

export type OnboardingStep =
  | 'timezone'
  | 'currency'
  | 'anchor_date'
  | 'categories'
  | 'reminders'
  | 'complete';

export interface DraftCategory {
  name: string;
  capMinorUnits: MinorUnits | null;
  /** Set once M3 has created it — a retry after a partial hand-off skips it. */
  categoryId: Id | null;
  /** Set once M4 has the cap (only meaningful when `capMinorUnits !== null`). */
  capCommitted: boolean;
  /** Step 5 selection. */
  reminder: boolean;
  /** Set once M5 has the selection. */
  reminderCommitted: boolean;
}

export interface OnboardingState {
  userId: UserId;
  step: OnboardingStep;
  categories: readonly DraftCategory[];
}

export type OnboardingInput =
  | { type: 'search_timezone'; query: string }
  | { type: 'choose_timezone'; timezone: string }
  /** Omit `currencyCode` to accept the default shown in the prompt (AUD). */
  | { type: 'choose_currency'; currencyCode?: CurrencyCode }
  | { type: 'choose_anchor_date'; date: LocalDate }
  | { type: 'add_category'; name: string; capMinorUnits?: MinorUnits | null }
  | { type: 'update_category'; name: string; newName?: string; capMinorUnits?: MinorUnits | null }
  | { type: 'remove_category'; name: string }
  | { type: 'confirm_categories' }
  | { type: 'select_reminder'; name: string; selected: boolean }
  | { type: 'confirm_reminders' };

export type OnboardingPrompt =
  | {
      step: 'timezone';
      suggestions: readonly TimezoneOption[];
      /** Present only in reply to `search_timezone`. */
      searchResults?: readonly TimezoneOption[];
    }
  | { step: 'currency'; defaultCurrencyCode: CurrencyCode }
  | { step: 'anchor_date'; suggestedDate: LocalDate }
  | { step: 'categories'; tier: Tier; limit: number; categories: readonly DraftCategory[] }
  | { step: 'reminders'; tier: Tier; limit: number; categories: readonly DraftCategory[] }
  | { step: 'complete'; settings: UserSettings; categories: readonly DraftCategory[] }
  /** A returning user re-sending `/start`: their settings, not a new account. */
  | { step: 'summary'; settings: UserSettings };

export interface OnboardingOutcome {
  state: OnboardingState;
  prompt: OnboardingPrompt;
}

/**
 * Where a reminder selection is recorded. M5 owns scheduling but neither M5's nor
 * M3's port exposes "enable the reminder for this category" yet, and where the flag
 * lives (category row? budget row?) is unspecified — so this is an M2-defined seam
 * the integrator adapts to whichever module lands it. See build-log.
 */
export interface ReminderSelectionPort {
  enableReminder(userId: UserId, categoryId: Id): Promise<void>;
}

/**
 * M8's agreed tier table (M8 "Agreed tier limits", 5 Sep). Duplicated here only to
 * bound the *draft* list before anything is handed off — while the user is still
 * editing, M8's `assertAllowed` would count zero categories in the DB and admit
 * everything. M8 stays authoritative: `assertAllowed` runs before every hand-off call.
 */
export const ONBOARDING_TIER_LIMITS: Readonly<
  Record<Tier, { readonly categories: number; readonly reminderCategories: number }>
> = {
  free: { categories: 10, reminderCategories: 1 },
  premium: { categories: 30, reminderCategories: 5 },
};

/** The one pre-seeded starter (round 3: Rent/Mortgage and Utilities dropped). */
export const STARTER_CATEGORY_NAME = 'Food';

export const MAX_CATEGORY_NAME_LENGTH = 40;

export class OnboardingHandoffError extends IdentityError {
  override readonly name: string = 'OnboardingHandoffError';

  constructor(
    cause: unknown,
    /** Progress made before the failure — persist this and retry with it. */
    readonly state: OnboardingState,
  ) {
    super(
      cause instanceof IdentityError ? cause.code : 'DELIVERY_FAILED',
      cause instanceof Error ? cause.message : String(cause),
    );
    this.cause = cause;
  }
}

export interface OnboardingServiceDeps {
  identity: IdentityService;
  ledger: Pick<LedgerService, 'createCategory'>;
  budgets: Pick<BudgetService, 'setCap'>;
  entitlements: Pick<EntitlementService, 'tierOf' | 'assertAllowed'>;
  reminders: ReminderSelectionPort;
  clock: Clock;
}

export class OnboardingService {
  readonly #identity: IdentityService;
  readonly #ledger: Pick<LedgerService, 'createCategory'>;
  readonly #budgets: Pick<BudgetService, 'setCap'>;
  readonly #entitlements: Pick<EntitlementService, 'tierOf' | 'assertAllowed'>;
  readonly #reminders: ReminderSelectionPort;
  readonly #clock: Clock;

  constructor(deps: OnboardingServiceDeps) {
    this.#identity = deps.identity;
    this.#ledger = deps.ledger;
    this.#budgets = deps.budgets;
    this.#entitlements = deps.entitlements;
    this.#reminders = deps.reminders;
    this.#clock = deps.clock;
  }

  /**
   * `/start`. A user whose core settings are already in place gets a summary — never
   * a new account, never a re-run of step 1. Otherwise resume: from `saved` if the
   * gateway still holds an in-flight state for this user, else from the first step
   * the stored settings show as incomplete.
   */
  async begin(userId: UserId, saved?: OnboardingState | null): Promise<OnboardingOutcome> {
    const settings = await this.#identity.getSettings(userId);

    if (saved && saved.userId === userId && saved.step !== 'complete') {
      const state = reconcile(saved, settings);
      return { state, prompt: await this.#promptFor(state, settings) };
    }

    if (hasCompletedCoreOnboarding(settings)) {
      return {
        state: { userId, step: 'complete', categories: [] },
        prompt: { step: 'summary', settings },
      };
    }

    const state: OnboardingState = {
      userId,
      step: settings.timezone === '' ? 'timezone' : 'currency',
      categories: [],
    };
    return { state, prompt: await this.#promptFor(state, settings) };
  }

  async apply(state: OnboardingState, input: OnboardingInput): Promise<OnboardingOutcome> {
    switch (state.step) {
      case 'timezone':
        return this.#timezoneStep(state, input);
      case 'currency':
        return this.#currencyStep(state, input);
      case 'anchor_date':
        return this.#anchorDateStep(state, input);
      case 'categories':
        return this.#categoriesStep(state, input);
      case 'reminders':
        return this.#remindersStep(state, input);
      case 'complete':
        throw stale(state.step, input.type);
    }
  }

  // ── step 1 ─────────────────────────────────────────────────────────────────────

  async #timezoneStep(state: OnboardingState, input: OnboardingInput): Promise<OnboardingOutcome> {
    if (input.type === 'search_timezone') {
      return {
        state,
        prompt: {
          step: 'timezone',
          suggestions: CURATED_AU_TIMEZONES,
          searchResults: searchTimezones(input.query),
        },
      };
    }
    if (input.type !== 'choose_timezone') throw stale(state.step, input.type);

    // Set once, ever — a forged callback on an already-onboarded user is refused by
    // the write path with TIMEZONE_IMMUTABLE, not by anything in this state machine.
    await this.#identity.setInitialTimezone(state.userId, input.timezone);
    const next: OnboardingState = { ...state, step: 'currency' };
    return { state: next, prompt: await this.#promptFor(next) };
  }

  // ── step 2 ─────────────────────────────────────────────────────────────────────

  async #currencyStep(state: OnboardingState, input: OnboardingInput): Promise<OnboardingOutcome> {
    if (input.type !== 'choose_currency') throw stale(state.step, input.type);

    let settings = await this.#identity.getSettings(state.userId);
    if (input.currencyCode !== undefined) {
      const code = validateCurrencyCode(input.currencyCode);
      settings = await this.#identity.updateSettings(state.userId, { currencyCode: code });
    }
    const next: OnboardingState = { ...state, step: 'anchor_date' };
    return { state: next, prompt: await this.#promptFor(next, settings) };
  }

  // ── step 3 ─────────────────────────────────────────────────────────────────────

  async #anchorDateStep(
    state: OnboardingState,
    input: OnboardingInput,
  ): Promise<OnboardingOutcome> {
    if (input.type !== 'choose_anchor_date') throw stale(state.step, input.type);

    const anchor = validateLocalDate(input.date);
    await this.#identity.updateSettings(state.userId, { periodAnchorDate: anchor });

    const next: OnboardingState = {
      ...state,
      step: 'categories',
      categories: state.categories.length > 0 ? state.categories : [draft(STARTER_CATEGORY_NAME)],
    };
    return { state: next, prompt: await this.#promptFor(next) };
  }

  // ── step 4 ─────────────────────────────────────────────────────────────────────

  async #categoriesStep(
    state: OnboardingState,
    input: OnboardingInput,
  ): Promise<OnboardingOutcome> {
    const tier = await this.#entitlements.tierOf(state.userId);
    const limit = ONBOARDING_TIER_LIMITS[tier].categories;

    switch (input.type) {
      case 'add_category': {
        const name = validateCategoryName(input.name);
        if (findDraft(state.categories, name)) {
          throw new IdentityError('INVALID_ARGUMENT', `you already have a category called ${name}`);
        }
        if (state.categories.length >= limit) {
          throw new IdentityError(
            'CATEGORY_LIMIT',
            `the ${tier} tier allows ${limit} categories; remove one to add ${name}`,
          );
        }
        const next: OnboardingState = {
          ...state,
          categories: [...state.categories, draft(name, validateCap(input.capMinorUnits ?? null))],
        };
        return { state: next, prompt: { step: 'categories', tier, limit, categories: next.categories } };
      }

      case 'update_category': {
        const existing = requireDraft(state.categories, input.name);
        if (existing.categoryId !== null) {
          throw new IdentityError(
            'STALE_ACTION',
            `${existing.name} has already been created; edit it with /categories after onboarding`,
          );
        }
        let updated = existing;
        if (input.newName !== undefined) {
          const newName = validateCategoryName(input.newName);
          const clash = findDraft(state.categories, newName);
          if (clash && clash !== existing) {
            throw new IdentityError('INVALID_ARGUMENT', `you already have a category called ${newName}`);
          }
          updated = { ...updated, name: newName };
        }
        if (input.capMinorUnits !== undefined) {
          updated = { ...updated, capMinorUnits: validateCap(input.capMinorUnits), capCommitted: false };
        }
        const next: OnboardingState = {
          ...state,
          categories: state.categories.map((c) => (c === existing ? updated : c)),
        };
        return { state: next, prompt: { step: 'categories', tier, limit, categories: next.categories } };
      }

      case 'remove_category': {
        const existing = requireDraft(state.categories, input.name);
        if (existing.categoryId !== null) {
          throw new IdentityError(
            'STALE_ACTION',
            `${existing.name} has already been created; archive it with /categories after onboarding`,
          );
        }
        const next: OnboardingState = {
          ...state,
          categories: state.categories.filter((c) => c !== existing),
        };
        return { state: next, prompt: { step: 'categories', tier, limit, categories: next.categories } };
      }

      case 'confirm_categories': {
        const committed = await this.#handoffCategories(state);
        if (committed.categories.length === 0) {
          // Nothing to pick a reminder for — step 5 would be an empty menu.
          return this.#complete(committed);
        }
        const next: OnboardingState = { ...committed, step: 'reminders' };
        return { state: next, prompt: await this.#promptFor(next) };
      }

      default:
        throw stale(state.step, input.type);
    }
  }

  /**
   * Hand each draft to M3 (+ M4 for a cap), M8 first. Progress is recorded per item
   * so a failure mid-way throws `OnboardingHandoffError` with the partial state; a
   * retry from that state skips what's already committed.
   */
  async #handoffCategories(state: OnboardingState): Promise<OnboardingState> {
    const categories = [...state.categories];
    for (let i = 0; i < categories.length; i++) {
      const item = categories[i];
      if (!item) continue;
      try {
        let current = item;
        if (current.categoryId === null) {
          await this.#entitlements.assertAllowed(state.userId, { kind: 'create_category' });
          const created = await this.#ledger.createCategory(state.userId, current.name);
          current = { ...current, categoryId: created.id };
          categories[i] = current;
        }
        if (current.capMinorUnits !== null && !current.capCommitted && current.categoryId) {
          await this.#budgets.setCap(state.userId, current.categoryId, current.capMinorUnits);
          categories[i] = { ...current, capCommitted: true };
        }
      } catch (error) {
        throw new OnboardingHandoffError(error, { ...state, categories });
      }
    }
    return { ...state, categories };
  }

  // ── step 5 ─────────────────────────────────────────────────────────────────────

  async #remindersStep(state: OnboardingState, input: OnboardingInput): Promise<OnboardingOutcome> {
    const tier = await this.#entitlements.tierOf(state.userId);
    const limit = ONBOARDING_TIER_LIMITS[tier].reminderCategories;

    switch (input.type) {
      case 'select_reminder': {
        const existing = requireDraft(state.categories, input.name);
        if (existing.reminderCommitted) {
          throw new IdentityError(
            'STALE_ACTION',
            `the reminder for ${existing.name} is already set; change it with /remind after onboarding`,
          );
        }
        const selectedCount = state.categories.filter((c) => c.reminder && c !== existing).length;
        if (input.selected && selectedCount >= limit) {
          throw new IdentityError(
            'REMINDER_CATEGORY_LIMIT',
            `the ${tier} tier allows a daily reminder on ${limit} ${limit === 1 ? 'category' : 'categories'}`,
          );
        }
        const next: OnboardingState = {
          ...state,
          categories: state.categories.map((c) =>
            c === existing ? { ...c, reminder: input.selected } : c,
          ),
        };
        return { state: next, prompt: { step: 'reminders', tier, limit, categories: next.categories } };
      }

      case 'confirm_reminders': {
        const categories = [...state.categories];
        for (let i = 0; i < categories.length; i++) {
          const item = categories[i];
          if (!item || !item.reminder || item.reminderCommitted || item.categoryId === null) continue;
          try {
            await this.#entitlements.assertAllowed(state.userId, { kind: 'enable_reminder' });
            await this.#reminders.enableReminder(state.userId, item.categoryId);
            categories[i] = { ...item, reminderCommitted: true };
          } catch (error) {
            throw new OnboardingHandoffError(error, { ...state, categories });
          }
        }
        return this.#complete({ ...state, categories });
      }

      default:
        throw stale(state.step, input.type);
    }
  }

  // ── shared ─────────────────────────────────────────────────────────────────────

  async #complete(state: OnboardingState): Promise<OnboardingOutcome> {
    const next: OnboardingState = { ...state, step: 'complete' };
    const settings = await this.#identity.getSettings(state.userId);
    return { state: next, prompt: { step: 'complete', settings, categories: next.categories } };
  }

  /** Re-render the prompt for the current step (e.g. after `/start` mid-flow). */
  async #promptFor(state: OnboardingState, settings?: UserSettings): Promise<OnboardingPrompt> {
    switch (state.step) {
      case 'timezone':
        return { step: 'timezone', suggestions: CURATED_AU_TIMEZONES };
      case 'currency': {
        const s = settings ?? (await this.#identity.getSettings(state.userId));
        return { step: 'currency', defaultCurrencyCode: s.currencyCode };
      }
      case 'anchor_date': {
        const s = settings ?? (await this.#identity.getSettings(state.userId));
        return { step: 'anchor_date', suggestedDate: localDateAt(this.#clock.now(), s.timezone) };
      }
      case 'categories': {
        const tier = await this.#entitlements.tierOf(state.userId);
        return {
          step: 'categories',
          tier,
          limit: ONBOARDING_TIER_LIMITS[tier].categories,
          categories: state.categories,
        };
      }
      case 'reminders': {
        const tier = await this.#entitlements.tierOf(state.userId);
        return {
          step: 'reminders',
          tier,
          limit: ONBOARDING_TIER_LIMITS[tier].reminderCategories,
          categories: state.categories,
        };
      }
      case 'complete': {
        const s = settings ?? (await this.#identity.getSettings(state.userId));
        return { step: 'complete', settings: s, categories: state.categories };
      }
    }
  }
}

/**
 * A saved state can lag the DB (the gateway persisted step 1's state, then the
 * timezone write committed and the process died). Never resume at a step the stored
 * settings prove is done — re-asking step 1 would hit TIMEZONE_IMMUTABLE.
 */
function reconcile(saved: OnboardingState, settings: UserSettings): OnboardingState {
  if (saved.step === 'timezone' && settings.timezone !== '') {
    return { ...saved, step: 'currency' };
  }
  if ((saved.step === 'currency' || saved.step === 'anchor_date') && settings.periodAnchorDate !== null) {
    return {
      ...saved,
      step: 'categories',
      categories: saved.categories.length > 0 ? saved.categories : [draft(STARTER_CATEGORY_NAME)],
    };
  }
  return saved;
}

function draft(name: string, capMinorUnits: MinorUnits | null = null): DraftCategory {
  return {
    name,
    capMinorUnits,
    categoryId: null,
    capCommitted: false,
    reminder: false,
    reminderCommitted: false,
  };
}

export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function validateCategoryName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new IdentityError('INVALID_ARGUMENT', 'category name must be text');
  }
  const name = normalizeCategoryName(raw);
  if (name === '') throw new IdentityError('INVALID_ARGUMENT', 'category name cannot be empty');
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new IdentityError(
      'INVALID_ARGUMENT',
      `category name must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer`,
    );
  }
  return name;
}

function validateCap(cap: MinorUnits | null): MinorUnits | null {
  if (cap === null) return null;
  if (typeof cap !== 'bigint' || cap <= 0n) {
    throw new IdentityError('INVALID_ARGUMENT', 'a budget cap must be a positive amount');
  }
  return cap;
}

function findDraft(categories: readonly DraftCategory[], name: string): DraftCategory | undefined {
  const key = normalizeCategoryName(name).toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === key);
}

function requireDraft(categories: readonly DraftCategory[], name: string): DraftCategory {
  const found = findDraft(categories, name);
  if (!found) throw new IdentityError('CATEGORY_NOT_FOUND', `no category called ${name}`);
  return found;
}

function stale(step: OnboardingStep, inputType: OnboardingInput['type']): IdentityError {
  return new IdentityError('STALE_ACTION', `${inputType} is not valid at onboarding step ${step}`);
}

// ── persistence helpers ───────────────────────────────────────────────────────────

interface EncodedDraftCategory extends Omit<DraftCategory, 'capMinorUnits'> {
  capMinorUnits: string | null;
}

interface EncodedState extends Omit<OnboardingState, 'categories'> {
  v: 1;
  categories: EncodedDraftCategory[];
}

const STEPS: readonly OnboardingStep[] = [
  'timezone',
  'currency',
  'anchor_date',
  'categories',
  'reminders',
  'complete',
];

/** JSON with the `bigint` cap as a decimal string. */
export function encodeOnboardingState(state: OnboardingState): string {
  const encoded: EncodedState = {
    v: 1,
    userId: state.userId,
    step: state.step,
    categories: state.categories.map((c) => ({
      ...c,
      capMinorUnits: c.capMinorUnits === null ? null : c.capMinorUnits.toString(),
    })),
  };
  return JSON.stringify(encoded);
}

/** Inverse of `encodeOnboardingState`; throws `INVALID_ARGUMENT` on anything malformed. */
export function decodeOnboardingState(json: string): OnboardingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new IdentityError('INVALID_ARGUMENT', 'onboarding state is not valid JSON');
  }
  const bad = (): IdentityError =>
    new IdentityError('INVALID_ARGUMENT', 'onboarding state has an unexpected shape');

  if (typeof parsed !== 'object' || parsed === null) throw bad();
  const obj = parsed as Record<string, unknown>;
  if (obj['v'] !== 1 || typeof obj['userId'] !== 'string') throw bad();
  if (!STEPS.includes(obj['step'] as OnboardingStep)) throw bad();
  if (!Array.isArray(obj['categories'])) throw bad();

  const categories: DraftCategory[] = obj['categories'].map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw bad();
    const c = raw as Record<string, unknown>;
    if (typeof c['name'] !== 'string') throw bad();
    const cap = c['capMinorUnits'];
    if (cap !== null && (typeof cap !== 'string' || !/^\d+$/.test(cap))) throw bad();
    const categoryId = c['categoryId'];
    if (categoryId !== null && typeof categoryId !== 'string') throw bad();
    return {
      name: c['name'],
      capMinorUnits: cap === null ? null : BigInt(cap as string),
      categoryId: categoryId as Id | null,
      capCommitted: c['capCommitted'] === true,
      reminder: c['reminder'] === true,
      reminderCommitted: c['reminderCommitted'] === true,
    };
  });

  return { userId: obj['userId'], step: obj['step'] as OnboardingStep, categories };
}
