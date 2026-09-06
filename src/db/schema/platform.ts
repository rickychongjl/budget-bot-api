/**
 * M7 — Telegram Gateway owns this file.
 *
 * Tables: `inbound_update`.
 *
 * Conventions: see `identity.ts` header. Specifics from M7's plan:
 *   - `primary key (channel, update_id)` — deduplication is a DB constraint, never an
 *     in-memory cache (two retry deliveries can land in different isolates).
 *   - `received_at timestamptz not null default now()`.
 *   - Retention/cleanup for this table is M9's territory, deferred this pass.
 */
export {};
