import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M9 checklist 2: "a lightweight logging lint/review step … confirming no PR
 * introduces a log line with message text, bot tokens, webhook secrets, or
 * Telegram identifiers." This is the lightweight version: a source scan that
 * fails when code outside the logging helper writes to `console` directly, or
 * interpolates a secret binding into a string. Deliberately crude — a real
 * reviewer still reads the diff — but it makes the easy mistakes loud.
 */
const SRC = join(__dirname, '..', '..', 'src');
const ALLOWED_CONSOLE = new Set(['observability/log.ts', 'index.ts']);
const SECRET_BINDINGS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'INTERNAL_DISPATCH_SECRET', 'OPENAI_API_KEY', 'DATABASE_URL'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('M9 logging rules — source scan', () => {
  const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

  it('only the logging helper and the Worker entrypoint write to console', () => {
    const offenders = files.filter((f) => !ALLOWED_CONSOLE.has(f.rel) && /\bconsole\.(log|warn|error|info|debug)\(/.test(f.text));
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it('no secret binding is interpolated into a string or passed to a logger', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const name of SECRET_BINDINGS) {
        if (new RegExp(`\\$\\{[^}]*\\b${name}\\b[^}]*\\}`).test(f.text)) offenders.push(`${f.rel}: \${…${name}…}`);
        if (new RegExp(`log\\([^)]*\\b${name}\\b`).test(f.text)) offenders.push(`${f.rel}: log(…${name}…)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the parse_event schema has no text-bearing column', () => {
    const schema = files.find((f) => f.rel === 'infrastructure/database/schema/observability.ts')!.text;
    const columns = [...schema.matchAll(/^\s+(\w+):\s+(\w+)\(/gm)].map((m) => ({ name: m[1]!, type: m[2]! }));
    expect(columns.map((c) => c.name).sort()).toEqual(
      ['createdAt', 'id', 'inputTokens', 'latencyMs', 'model', 'neededClarification', 'outputTokens', 'route', 'userId', 'wasCorrected'],
    );
    expect(columns.filter((c) => c.type === 'text').map((c) => c.name).sort()).toEqual(['model', 'route']);
  });
});
