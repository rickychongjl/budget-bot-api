/**
 * The only logging surface domain code should use (M9's binding rules).
 *
 * A log line is an event name plus flat primitive fields. Strings are capped and
 * scanned so that the two ways secrets/PII usually leak — a raw message body pasted
 * into a field, or an object serialised wholesale — are structurally awkward here:
 *   - fields are `string | number | boolean | null` only (no objects, so no request
 *     bodies, no `Error` objects with response payloads attached);
 *   - string values are truncated to `MAX_FIELD_LENGTH`;
 *   - a value that looks like a Telegram bot token is redacted defensively.
 * This is deliberately a tiny helper, not a logging framework — M9 revisits
 * observability properly before public beta.
 *
 * What must never appear in a field, in any module: bot tokens, webhook secrets,
 * channel identifiers (Telegram user/chat ids), raw message text, API keys.
 */
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

const MAX_FIELD_LENGTH = 200;
/** `123456789:AAF...` — the shape of a Telegram bot token. */
const BOT_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g;
/** OpenAI-style secret keys. */
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

export function sanitizeLogValue(value: LogValue): LogValue {
  if (typeof value !== 'string') return value;
  const redacted = value.replace(BOT_TOKEN_PATTERN, '[redacted]').replace(API_KEY_PATTERN, '[redacted]');
  return redacted.length > MAX_FIELD_LENGTH ? `${redacted.slice(0, MAX_FIELD_LENGTH)}…` : redacted;
}

export function formatLogLine(level: LogLevel, event: string, fields: LogFields = {}): string {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(sanitizeLogValue(value))}`);
  return `[${level}] ${event}${parts.length > 0 ? ' ' + parts.join(' ') : ''}`;
}

/** Writes to the Worker's console (Workers Logs picks it up via `[observability]`). */
export class ConsoleLogger implements Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void {
    const line = formatLogLine(level, event, fields);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

/** For tests and for callers that have nothing to say. */
export class NoopLogger implements Logger {
  log(): void {
    /* intentionally empty */
  }
}
