import { describe, expect, it } from 'vitest';
import { formatLogLine, sanitizeLogValue } from '../../src/observability/log';

describe('observability/log (M9 logging rules)', () => {
  it('redacts anything shaped like a bot token or API key', () => {
    expect(sanitizeLogValue('token 123456789:AAFxyz_abcdefghijklmnopqrstuvwxyz0123 leaked')).toBe('token [redacted] leaked');
    expect(sanitizeLogValue('key sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe('key [redacted]');
  });

  it('truncates long strings so a pasted message body cannot ride along', () => {
    const long = 'a'.repeat(1000);
    expect((sanitizeLogValue(long) as string).length).toBeLessThanOrEqual(201);
  });

  it('formats flat primitive fields only', () => {
    expect(formatLogLine('warn', 'llm_parse_api_error', { errorClass: 'APIError', status: 500, retry: true, model: null })).toBe(
      '[warn] llm_parse_api_error errorClass="APIError" status=500 retry=true model=null',
    );
  });
});
