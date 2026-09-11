/**
 * A recording fake `fetch` for the Telegram Bot API, following the repo's established
 * way of stubbing outbound HTTP: inject a `fetch`, record what it was handed, script
 * what comes back (see `OpenAiLlmParser`'s seam and `test/unit/llm-parser.test.ts`).
 * There is no mocking framework in this repo and this does not introduce one.
 *
 * It records the full request URL on purpose, so a test can assert that the bot token
 * — which lives in that URL — never escapes into a log line, an error or an outcome.
 */

export interface RecordedCall {
  /** Bot API method name, parsed out of the URL path. */
  method: string;
  url: string;
  payload: Record<string, unknown>;
}

/** Telegram's error envelope. `retryAfter` becomes `parameters.retry_after`. */
export function telegramError(
  status: number,
  description = 'Forbidden: bot was blocked by the user',
  retryAfter?: number,
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: status,
      description,
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export function telegramOk(result: unknown = { message_id: 1 }): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export class FakeTelegramApi {
  readonly calls: RecordedCall[] = [];

  /** Consumed in order; once exhausted every further call succeeds. */
  private readonly scripted: (Response | (() => Response) | Error)[] = [];

  constructor(...scripted: (Response | (() => Response) | Error)[]) {
    this.scripted = [...scripted];
  }

  script(...responses: (Response | (() => Response) | Error)[]): this {
    this.scripted.push(...responses);
    return this;
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** The only call made — throws if that assumption does not hold. */
  get only(): RecordedCall {
    if (this.calls.length !== 1) {
      throw new Error(`expected exactly one Bot API call, got ${this.calls.length}`);
    }
    return this.calls[0]!;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push({
      method: url.slice(url.lastIndexOf('/') + 1),
      url,
      payload: init?.body === undefined ? {} : JSON.parse(String(init.body)),
    });

    const next = this.scripted.shift();
    if (next === undefined) return telegramOk();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
}
