import { Hono } from 'hono';
import { createCatalogue } from './channels/telegram/commands/catalogue';
import { TelegramDispatcher } from './channels/telegram/dispatcher';
import type { GatewayRepository } from './channels/telegram/gateway-repository';
import { TelegramApiClient } from './channels/telegram/telegram-api-client';
import { TelegramMessageSender } from './channels/telegram/telegram-message-sender';
import { TelegramWebhookHandler } from './channels/telegram/webhook-handler';
import { DefaultAllowanceService } from './core/allowance/default-allowance-service';
import { DefaultReminderSelectionService } from './core/allowance/default-reminder-selection-service';
import { createReminderCapacityReader } from './core/allowance/index';
import { DefaultBudgetService } from './core/budgets/default-budget-service';
import { createEntitlementService } from './core/entitlements/default-entitlement-service';
import { DefaultIdentityService } from './core/identity/default-identity-service';
import { OnboardingService } from './core/identity/onboarding';
import { DefaultCategoryService } from './core/ledger/default-category-service';
import { DefaultLedgerService } from './core/ledger/default-ledger-service';
import { SystemClock } from './core/shared/clock';
import type { DueUser } from './core/allowance/allowance-service';
import type { Clock } from './core/shared/clock';
import type { UserId } from './core/shared/common';
import type { MessageSender } from './core/shared/messaging';
import { createDatabase } from './infrastructure/database/client';
import { DrizzleAllowanceRepository } from './infrastructure/database/repositories/drizzle-allowance-repository';
import { DrizzleBudgetRepository } from './infrastructure/database/repositories/drizzle-budget-repository';
import { DrizzleEntitlementRepository } from './infrastructure/database/repositories/drizzle-entitlement-repository';
import { DrizzleIdentityRepository } from './infrastructure/database/repositories/drizzle-identity-repository';
import { DrizzleGatewayRepository } from './infrastructure/database/repositories/drizzle-gateway-repository';
import { DrizzleLedgerRepository } from './infrastructure/database/repositories/drizzle-ledger-repository';
import type { DatabaseExecutor } from './infrastructure/database/repositories/drizzle-ledger-repository';
import { ConsoleLogger } from './observability/log';
import type { Logger } from './observability/log';

/**
 * Worker entrypoint and **composition root** (M1 §2, CLAUDE.md "Telegram and
 * application entry points"). This is the one file permitted to import both `core/`
 * and `infrastructure/`, and its whole job is to connect them: read bindings, create
 * the database client, construct repositories and adapters, construct core services,
 * register routes and the scheduled handler, then delegate.
 *
 * It parses no Telegram commands, enforces no policy and runs no Drizzle query itself.
 *
 * Single environment this pass: production only (master plan §5.7).
 */
export interface Env {
  /** Neon Postgres (Sydney) via Hyperdrive — see `wrangler.toml`. */
  HYPERDRIVE: Hyperdrive;

  /**
   * The Worker's own public origin, e.g. `https://budge-bot-api.example.workers.dev`.
   * A `[vars]` entry, not a secret. The cron fan-out needs it because a `scheduled`
   * invocation has no inbound request to derive an origin from, and the fan-out must
   * be a real subrequest (see `scheduled` below).
   */
  WORKER_BASE_URL: string;

  // Wrangler secrets (`wrangler secret put <NAME>`), never in `wrangler.toml`:
  TELEGRAM_BOT_TOKEN: string;
  /**
   * Where `/paysupport` sends someone with a payment problem. A secret rather than a
   * `[vars]` entry only because the value is a personal address and this repository is
   * public — it is shown to users, so it is not sensitive in the usual sense.
   */
  SUPPORT_CONTACT: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTERNAL_DISPATCH_SECRET: string;
  OPENAI_API_KEY: string;
  DATABASE_URL: string;
}

/**
 * Everything the application is made of, wired together. Built per invocation:
 * `env.HYPERDRIVE.connectionString` is only valid inside a request/cron context, and
 * a Worker isolate can outlive any single one of them.
 */
export interface Services {
  identity: DefaultIdentityService;
  onboarding: OnboardingService;
  entitlements: ReturnType<typeof createEntitlementService<DatabaseExecutor>>;
  budgets: DefaultBudgetService<DatabaseExecutor>;
  ledger: DefaultLedgerService<DatabaseExecutor>;
  categories: DefaultCategoryService<DatabaseExecutor>;
  allowance: DefaultAllowanceService<DatabaseExecutor>;
  reminders: DefaultReminderSelectionService<DatabaseExecutor>;
  sender: MessageSender;
  /** M7's own tables — `inbound_update` dedupe and `pending_prompt`. */
  gateway: GatewayRepository;
  /** The webhook, fully wired. `index.ts` only hands it the raw request. */
  telegramWebhook: TelegramWebhookHandler;
}

export interface CreateServicesOptions {
  clock?: Clock;
  logger?: Logger;
  /** Test seam for outbound HTTP, mirroring `OpenAiLlmParser`'s. */
  fetch?: typeof fetch;
}

/** How a request or a cron tick obtains its services. Overridden in tests. */
export type ServicesFactory = (env: Env) => Services;

/**
 * The wiring each module's own `index.ts` header prescribes, in dependency order.
 *
 * Three cycles are unavoidable and are broken the same way M5's test harness breaks
 * them — with a closure that reads the finished service later, never a half-built
 * object handed out early:
 *
 *   - M2 needs M3 (`history`, to decide whether an account has any transactions) and
 *     M3 needs M2 (`settingsOf`).
 *   - M5 needs M3 (`spendInPeriod`/`spentOn`) and M3 needs M5 (`AllowanceNotifier`).
 *   - M5 needs M4 (`ensurePeriod`) and M4 needs M5 (`BudgetAllowanceNotifier`, so a
 *     cap change re-prices today's figure).
 */
export function createServices(env: Env, options: CreateServicesOptions = {}): Services {
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? new ConsoleLogger();
  const db = createDatabase(env.HYPERDRIVE.connectionString);

  const identityRepository = new DrizzleIdentityRepository(db);
  const ledgerRepository = new DrizzleLedgerRepository(db);
  const budgetRepository = new DrizzleBudgetRepository(db);
  const allowanceRepository = new DrizzleAllowanceRepository(db);
  const entitlementRepository = new DrizzleEntitlementRepository(db);
  const gatewayRepository = new DrizzleGatewayRepository(db);

  const telegramApi = new TelegramApiClient({
    token: env.TELEGRAM_BOT_TOKEN,
    logger,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const sender = new TelegramMessageSender(telegramApi);

  // --- M2, first, because almost everything reads settings through it ------------
  const identity = new DefaultIdentityService({
    repo: identityRepository,
    clock,
    // Cycle 1: resolved after `ledger` exists, below.
    ledger: { history: (userId, page) => ledger.history(userId, page) },
  });
  const settingsOf = (userId: UserId) => identity.getSettings(userId);

  // --- M8, whose capacity numbers are supplied by the modules that own the rows ---
  // Master plan §2 rule 2: M8 never reads another module's table. Both readers take
  // M8's executor so "count, then write" happens inside one transaction.
  const entitlements = createEntitlementService<DatabaseExecutor>({
    repository: entitlementRepository,
    capacity: {
      countActiveCategories: ledgerRepository.capacity.countActiveCategories,
      countReminderCategories: createReminderCapacityReader(allowanceRepository),
    },
    timezoneOf: (userId) => identity.getSettings(userId).then((s) => s.timezone),
    clock,
  });

  // --- M4 -----------------------------------------------------------------------
  const budgets: DefaultBudgetService<DatabaseExecutor> = new DefaultBudgetService({
    repository: budgetRepository,
    settingsOf,
    clock,
    // Cycle 3: M5 needs M4 (`ensurePeriod`) and M4 needs M5 (`capChanged`). Resolved
    // after `allowance` exists, below.
    allowance: { capChanged: (userId, categoryId) => allowance.capChanged(userId, categoryId) },
  });

  // --- M5 -----------------------------------------------------------------------
  // The explicit annotations on `allowance` and `ledger` are load-bearing: each is
  // referenced inside the other's initializer, and without them TypeScript cannot
  // infer either type (TS7022/TS7023).
  const allowance: DefaultAllowanceService<DatabaseExecutor> = new DefaultAllowanceService({
    repository: allowanceRepository,
    budgets,
    // Cycle 2: resolved after `ledger` exists, below.
    ledger: {
      spendInPeriod: (userId, budgetPeriodId, upTo) =>
        upTo === undefined
          ? ledger.spendInPeriod(userId, budgetPeriodId)
          : ledger.spendInPeriod(userId, budgetPeriodId, upTo),
      spentOn: (userId, localDate, categoryId) =>
        categoryId === undefined
          ? ledger.spentOn(userId, localDate)
          : ledger.spentOn(userId, localDate, categoryId),
    },
    settingsOf,
    connections: identity,
    sender,
    clock,
  });

  const reminders = new DefaultReminderSelectionService({
    repository: allowanceRepository,
    budgets,
    entitlements,
  });

  // --- M3 -----------------------------------------------------------------------
  // `allowance` goes to *both* services. On the ledger it is a documented no-op
  // (`available_today` is derived, not stored); on the category service it is not —
  // `categoryArchived` clears `reminder_enabled` and retires the day's pending row.
  // Omit it there and `/remind` lists a category that can never fire.
  const ledger: DefaultLedgerService<DatabaseExecutor> = new DefaultLedgerService({
    repository: ledgerRepository,
    periods: budgets,
    settingsOf,
    clock,
    allowance,
  });

  const categories = new DefaultCategoryService({
    repository: ledgerRepository,
    entitlements,
    budgets,
    settingsOf,
    clock,
    allowance,
  });

  // --- M2's onboarding machine, last: it drives every other module ---------------
  const onboarding = new OnboardingService({
    identity,
    entitlements,
    categories,
    budgets,
    reminders,
    clock,
  });

  // --- M7's inbound half (stage 4B) ----------------------------------------------
  // Built last: the dispatcher is the one thing that needs every other service.
  const telegramWebhook = new TelegramWebhookHandler({
    dispatcher: new TelegramDispatcher({
      identity,
      entitlements,
      onboarding,
      // Stage 4C's nine product commands call these; the dispatcher itself does not.
      categories,
      budgets,
      ledger,
      allowance,
      reminders,
      gateway: gatewayRepository,
      router: createCatalogue(),
      sender,
      callbacks: {
        answerCallbackQuery: async (callbackQueryId) => {
          await telegramApi.answerCallbackQuery(callbackQueryId);
        },
      },
      clock,
      logger,
      supportContact: env.SUPPORT_CONTACT,
      // `freeText` arrives in stage 4D with the parsing pipeline; until then the
      // dispatcher answers those two branches with an honest "not yet".
    }),
    gateway: gatewayRepository,
    clock,
    logger,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  });

  return {
    identity,
    onboarding,
    entitlements,
    budgets,
    ledger,
    categories,
    allowance,
    reminders,
    sender,
    gateway: gatewayRepository,
    telegramWebhook,
  };
}

/**
 * The route table. `makeServices` is a parameter rather than a direct call so tests
 * can drive the real routing and guards without a database — the same seam stages
 * 4B–4D use for the webhook.
 */
export function createApp(makeServices: ServicesFactory = createServices): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  /** Liveness probe. Touches nothing — it must answer while Postgres is down. */
  routes.get('/health', (c) => c.json({ status: 'ok', service: 'budge-bot-api' }));

  /**
   * The Telegram webhook. Everything about it — the secret-token check, dedupe,
   * returning 200 before the work happens — lives in the handler; this route exists
   * only to hand over the raw request and the execution context.
   */
  routes.post('/telegram/webhook', async (c) => {
    return makeServices(c.env).telegramWebhook.handle(c.req.raw, c.executionCtx);
  });

  /**
   * One user's bundled 07:00 reminder (M7's handover item 3). Never routed publicly:
   * the cron fan-out calls it once per due user so each send gets its own invocation,
   * and therefore its own 10ms CPU budget on the Workers Free plan.
   */
  routes.post('/internal/send-allowance', async (c) => {
    if (
      !isAuthorisedDispatch(
        c.req.header('X-Internal-Dispatch-Secret'),
        c.env.INTERNAL_DISPATCH_SECRET,
      )
    ) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: { userId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    if (typeof body.userId !== 'string' || body.userId === '') {
      return c.json({ error: 'invalid_body' }, 400);
    }

    const outcome = await makeServices(c.env).allowance.computeAndSend(body.userId);
    return c.json(outcome);
  });

  return routes;
}

const app = createApp();

/**
 * Constant-time comparison, so a wrong secret cannot be recovered a byte at a time.
 * Length is compared first and leaks only the length, which is not the secret.
 */
function isAuthorisedDispatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** The Workers Free subrequest ceiling — M5's `findDue` limit is sized to match. */
export const MAX_DUE_USERS_PER_TICK = 50;

/**
 * The daily-allowance fan-out (M7's handover item 4), replacing M1's hello-world.
 *
 * `controller.scheduledTime` rather than `Date.now()`: a delayed invocation must still
 * resolve the window it was *scheduled* for, or a user whose 07:00 slot has already
 * slipped past the due window is skipped for the day.
 *
 * One subrequest per due user, deliberately — not one invocation doing all the work.
 * Every send then gets its own CPU budget, and one user's failure cannot take the
 * rest of the tick down with it (`allSettled`).
 */
export async function runScheduled(
  controller: ScheduledController,
  env: Env,
  services: Pick<Services, 'allowance'>,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const due = await services.allowance.findDue(controller.scheduledTime, MAX_DUE_USERS_PER_TICK);
  if (due.length === 0) return;

  const failed = await dispatchDueUsers(due, env, fetchFn);
  console.log(
    `[cron] allowance fan-out scheduledTime=${new Date(controller.scheduledTime).toISOString()} ` +
      `due=${due.length} dispatchFailures=${failed}`,
  );
}

/**
 * One subrequest per due user. `allSettled`, so one user's failed dispatch cannot
 * abandon the rest of the tick — and a dispatch that fails here is not lost: M5 leaves
 * the row `pending`, so the next 15-minute tick inside the due window retries it.
 * Returns the number that failed to dispatch.
 */
export async function dispatchDueUsers(
  due: readonly DueUser[],
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const results = await Promise.allSettled(
    due.map((user) =>
      fetchFn(`${env.WORKER_BASE_URL}/internal/send-allowance`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Internal-Dispatch-Secret': env.INTERNAL_DISPATCH_SECRET,
        },
        body: JSON.stringify({ userId: user.userId }),
      }),
    ),
  );
  return results.filter((r) => r.status === 'rejected').length;
}

export default {
  fetch: app.fetch,

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runScheduled(controller, env, createServices(env)));
  },
} satisfies ExportedHandler<Env>;

export { app };
