import { afterEach, describe, expect, it } from 'vitest';
import { TelegramApiClient } from '../../../src/channels/telegram/telegram-api-client';

/**
 * Regression for a real production failure (M7 stage 4E go-live): every call failed
 * with `TypeError: Illegal invocation` once deployed, despite passing every unit test
 * that injects a fake `fetch`. Cause: `fetch` is a branded built-in on the Workers
 * runtime — storing the bare reference on a private field and later invoking it as
 * `this.#fetch(...)` is a *method* call, which sets `this` to the class instance
 * rather than the global scope `fetch` requires, and the runtime rejects that receiver.
 * A fake `fetch` in a test double never notices, because nothing but the real runtime
 * checks the receiver — which is exactly why this shipped without a failing test.
 */
describe('TelegramApiClient — the real global fetch, unmocked', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('invokes the default fetch with the receiver the runtime requires, not the client instance', async () => {
    const calls: { thisArg: unknown }[] = [];
    // Mimics the Workers runtime's own brand check on `fetch`.
    globalThis.fetch = function (this: unknown) {
      calls.push({ thisArg: this });
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    } as typeof fetch;

    // No `fetch` option — this is the production path every stage-4B–4E unit test skips
    // by always injecting a fake.
    const client = new TelegramApiClient({ token: 'token' });

    const outcome = await client.sendMessage('123', 'hi');

    expect(outcome).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});
