import { describe, expect, it } from 'vitest';
import type { DueUser, SendOutcome } from '../../../src/core/allowance/allowance-service';
import type { Env, Services } from '../../../src/index';
import { MAX_DUE_USERS_PER_TICK, createApp, dispatchDueUsers, runScheduled } from '../../../src/index';

/**
 * The Worker's own surface: route guards and the cron fan-out. Not the services behind
 * them — every one of those has its own suite, and standing a real database up here
 * would prove nothing this file is about.
 *
 * `createApp` takes a services factory and `runScheduled` takes the services, which is
 * what lets the real Hono routing, the real constant-time secret check and the real
 * fan-out run against stubs. That seam is also what stages 4B–4D will test the webhook
 * through.
 */

const SECRET = 'dispatch-secret-value';

const ENV: Env = {
  HYPERDRIVE: { connectionString: 'postgres://unused' } as Hyperdrive,
  WORKER_BASE_URL: 'https://budge-bot-api.test',
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
  INTERNAL_DISPATCH_SECRET: SECRET,
  OPENAI_API_KEY: 'sk-test',
  DATABASE_URL: 'postgres://unused',
  SUPPORT_CONTACT: 'support@example.test',
};

const SENT: SendOutcome = { status: 'sent', categoryCount: 2 };

/** Records what the route asked for, so the test can assert the handler's own work. */
function stubServices(outcome: SendOutcome = SENT) {
  const computeAndSendCalls: string[] = [];
  const services = {
    allowance: {
      computeAndSend: async (userId: string) => {
        computeAndSendCalls.push(userId);
        return outcome;
      },
    },
  } as unknown as Services;
  return { services, computeAndSendCalls };
}

function post(body: unknown, secret?: string): Request {
  return new Request('https://budge-bot-api.test/internal/send-allowance', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { 'X-Internal-Dispatch-Secret': secret }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('/health', () => {
  it('answers without building any services, so it survives Postgres being down', async () => {
    let built = 0;
    const app = createApp(() => {
      built += 1;
      return {} as Services;
    });

    const response = await app.fetch(new Request('https://budge-bot-api.test/health'), ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'budge-bot-api' });
    expect(built).toBe(0);
  });
});

describe('POST /internal/send-allowance', () => {
  it('refuses a missing secret with 401 and never builds services', async () => {
    let built = 0;
    const app = createApp(() => {
      built += 1;
      return {} as Services;
    });

    const response = await app.fetch(post({ userId: 'user-1' }), ENV);

    expect(response.status).toBe(401);
    expect(built).toBe(0);
  });

  it('refuses a wrong secret of the same length with 401', async () => {
    const { services, computeAndSendCalls } = stubServices();
    const app = createApp(() => services);

    // Same length as SECRET, so only the constant-time comparison can reject it.
    const wrong = 'dispatch-secret-VALUE';
    expect(wrong).toHaveLength(SECRET.length);

    const response = await app.fetch(post({ userId: 'user-1' }, wrong), ENV);

    expect(response.status).toBe(401);
    expect(computeAndSendCalls).toEqual([]);
  });

  it('refuses a wrong secret of a different length with 401', async () => {
    const { services } = stubServices();
    const app = createApp(() => services);

    const response = await app.fetch(post({ userId: 'user-1' }, 'short'), ENV);

    expect(response.status).toBe(401);
  });

  it('rejects an unparseable body and a missing userId with 400, after auth', async () => {
    const { services, computeAndSendCalls } = stubServices();
    const app = createApp(() => services);

    expect((await app.fetch(post('not json', SECRET), ENV)).status).toBe(400);
    expect((await app.fetch(post({}, SECRET), ENV)).status).toBe(400);
    expect((await app.fetch(post({ userId: 42 }, SECRET), ENV)).status).toBe(400);
    expect((await app.fetch(post({ userId: '' }, SECRET), ENV)).status).toBe(400);
    expect(computeAndSendCalls).toEqual([]);
  });

  it('with a valid secret, sends that one user and returns M5’s outcome verbatim', async () => {
    const { services, computeAndSendCalls } = stubServices();
    const app = createApp(() => services);

    const response = await app.fetch(post({ userId: 'user-7' }, SECRET), ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SENT);
    // One user per invocation is the point — that is what gives each send its own
    // CPU budget.
    expect(computeAndSendCalls).toEqual(['user-7']);
  });

  it('passes a retryable outcome through unchanged rather than reinterpreting it', async () => {
    const pending: SendOutcome = {
      status: 'pending',
      retryable: true,
      retryAfterSeconds: 30,
      categoryCount: 1,
    };
    const { services } = stubServices(pending);
    const app = createApp(() => services);

    const response = await app.fetch(post({ userId: 'user-7' }, SECRET), ENV);

    expect(await response.json()).toEqual(pending);
  });
});

describe('the cron fan-out', () => {
  const CONTROLLER = {
    cron: '*/15 * * * *',
    scheduledTime: Date.parse('2026-09-11T21:00:00Z'),
    noRetry: () => undefined,
  } as unknown as ScheduledController;

  function allowanceStub(due: readonly DueUser[]) {
    const findDueArgs: { now: number; limit: number }[] = [];
    const services = {
      allowance: {
        findDue: async (now: number, limit: number) => {
          findDueArgs.push({ now, limit });
          return due;
        },
      },
    } as unknown as Services;
    return { services, findDueArgs };
  }

  it('asks findDue for the scheduled time, not the wall clock, capped at the subrequest ceiling', async () => {
    const { services, findDueArgs } = allowanceStub([]);

    await runScheduled(CONTROLLER, ENV, services, async () => new Response(''));

    // A delayed invocation must still resolve the window it was scheduled for,
    // otherwise a user whose 07:00 slot has slipped past is skipped for the day.
    expect(findDueArgs).toEqual([
      { now: Date.parse('2026-09-11T21:00:00Z'), limit: MAX_DUE_USERS_PER_TICK },
    ]);
    expect(MAX_DUE_USERS_PER_TICK).toBe(50);
  });

  it('issues no subrequest when nobody is due', async () => {
    const { services } = allowanceStub([]);
    const calls: string[] = [];

    await runScheduled(CONTROLLER, ENV, services, async (input) => {
      calls.push(String(input));
      return new Response('');
    });

    expect(calls).toEqual([]);
  });

  it('posts one authorised subrequest per due user', async () => {
    const due: DueUser[] = [
      { userId: 'user-1', localDate: '2026-09-12' },
      { userId: 'user-2', localDate: '2026-09-12' },
    ];
    const requests: { url: string; secret: string | null; body: unknown }[] = [];

    const failures = await dispatchDueUsers(due, ENV, async (input, init) => {
      requests.push({
        url: String(input),
        secret: new Headers(init?.headers).get('X-Internal-Dispatch-Secret'),
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{}', { status: 200 });
    });

    expect(failures).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe('https://budge-bot-api.test/internal/send-allowance');
    expect(requests[0]!.secret).toBe(SECRET);
    expect(requests.map((r) => r.body)).toEqual([{ userId: 'user-1' }, { userId: 'user-2' }]);
  });

  it('one failed dispatch does not abandon the rest of the tick', async () => {
    const due: DueUser[] = [
      { userId: 'user-1', localDate: '2026-09-12' },
      { userId: 'user-2', localDate: '2026-09-12' },
      { userId: 'user-3', localDate: '2026-09-12' },
    ];
    const reached: string[] = [];

    const failures = await dispatchDueUsers(due, ENV, async (_input, init) => {
      const { userId } = JSON.parse(String(init?.body)) as { userId: string };
      if (userId === 'user-2') throw new TypeError('network down');
      reached.push(userId);
      return new Response('{}', { status: 200 });
    });

    // The failed one is not lost: M5 leaves its row `pending`, so the next tick
    // inside the due window retries it.
    expect(failures).toBe(1);
    expect(reached).toEqual(['user-1', 'user-3']);
  });
});
