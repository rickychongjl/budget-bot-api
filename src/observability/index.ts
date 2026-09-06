/**
 * M9 — Observability, Privacy & Retention (stub by design this pass).
 *
 * The fixed pieces — `db/schema/observability.ts` (`parse_event`) and the logging
 * rules — are built inside M6's PR. Binding now, expensive to retrofit:
 *   - The LLM prompt carries only message text + category names + currency.
 *   - `parse_event` holds NO message text — routes/tokens/latencies/booleans only.
 *   - No log line anywhere contains a bot token, webhook secret, channel identifier,
 *     or raw message content. A stack trace with a request body is a defect.
 *   - Data stays in Australia (Neon Sydney).
 *
 * `log.ts` is the minimal structured-logging helper that makes those rules the path
 * of least resistance (flat primitive fields only, truncated, token-redacted).
 *
 * Metrics, dashboards, retention/cleanup jobs: deferred to before public beta.
 */
export * from './log';
