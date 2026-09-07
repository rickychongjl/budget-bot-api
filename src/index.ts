import { Hono } from 'hono';
import { SystemClock } from './core/shared/clock';

/**
 * Worker entrypoint — `fetch` + `scheduled` handlers and the binding surface (M1 §2).
 *
 * Single environment this pass: production only (master plan §5.7). Everything the
 * Worker needs is either a Wrangler secret or the Hyperdrive binding — nothing here
 * is committed with a value.
 */
export interface Env {
  /** Neon Postgres (Sydney) via Hyperdrive — see `wrangler.toml`. */
  HYPERDRIVE: Hyperdrive;

  // Wrangler secrets (`wrangler secret put <NAME>`), never in `wrangler.toml`:
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTERNAL_DISPATCH_SECRET: string;
  OPENAI_API_KEY: string;
  DATABASE_URL: string;
}

const app = new Hono<{ Bindings: Env }>();

/** Liveness probe. Real routes (webhook, internal dispatch) arrive with M7 / M5. */
app.get('/health', (c) => c.json({ status: 'ok', service: 'budge-bot-api' }));

export default {
  fetch: app.fetch,

  /**
   * M1 hello-world cron — proves the Cron Trigger wiring works in production before
   * M5's scheduler depends on it (M1 definition of done). There is no staging Worker
   * to try it on first, so this first deploy is handled carefully.
   *
   * M5 replaces this body with the due-user query + self-dispatching fan-out to
   * `/internal/send-allowance`.
   */
  async scheduled(controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    const clock = new SystemClock();
    console.log(
      `[cron] tick cron="${controller.cron}" ` +
        `scheduledTime=${new Date(controller.scheduledTime).toISOString()} ` +
        `observedAt=${new Date(clock.now()).toISOString()}`,
    );
  },
} satisfies ExportedHandler<Env>;
