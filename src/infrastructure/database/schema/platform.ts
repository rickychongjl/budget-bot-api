import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appUser } from './identity';
import { parseEvent } from './observability';

/**
 * M7 — Telegram Gateway owns this file.
 *
 * Tables: `inbound_update`, `pending_prompt`.
 *
 * Conventions: see `identity.ts` header. Specifics from M7's plan:
 *   - `primary key (channel, update_id)` — deduplication is a DB constraint, never an
 *     in-memory cache (two retry deliveries can land in different isolates).
 *   - `received_at timestamptz not null default now()`.
 *   - Retention/cleanup for this table is M9's territory, deferred this pass.
 */

/**
 * `inbound_update` — one row per Telegram update the webhook has accepted. The whole
 * table is a deduplication constraint: the handler inserts `on conflict do nothing`
 * and processes the update only when it wrote the row.
 *
 * `update_id` is `text`, not `bigint`, because the column is channel-agnostic — a
 * second adapter's update identity need not be numeric, and M7's page writes it as
 * `text`. Telegram's numeric id is stringified at the parser boundary.
 *
 * There is deliberately **no `user_id`**: dedup happens before the user is resolved,
 * and an update from an unregistered sender must still be recorded so a Telegram
 * retry of it is not processed twice.
 */
export const inboundUpdate = pgTable(
  'inbound_update',
  {
    channel: text('channel').notNull(),
    updateId: text('update_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ name: 'inbound_update_pkey', columns: [t.channel, t.updateId] })],
);

/**
 * `pending_prompt` — "this user owes an answer", the conversation state M6 produces
 * and M7 has to remember between two Worker invocations.
 *
 * Added by M7 (phase-4 plan, finding 1): `TransactionParsingPipeline.parse` returns
 * `confirm`/`clarify` outcomes but persists nothing, while M11's routing ("an answer
 * to an open clarification") and `/cancel` ("abandon current uncommitted
 * conversation") both require the state to survive the invocation.
 *
 *   - `user_id` is the **primary key**, not just a FK: at most one open prompt per
 *     user, so a second question replaces the first rather than queueing behind it.
 *     The write path is an upsert on this key.
 *   - `payload jsonb` holds the serialised `ValidatedCandidate` (kind `confirm`) or
 *     the question (kind `clarify`). M7 never interprets it — it hands it back to M6.
 *   - `parse_event_id` is nullable and `on delete set null`: M9 may retire a
 *     `parse_event` row under retention while a prompt is still open, and losing the
 *     correlation id must not delete the user's conversation.
 *
 * **Onboarding does not use this table.** `OnboardingService` persists its own step in
 * `app_user.onboarding_step` and carries `step` + `options` in every prompt, so a
 * stale or forged callback is already detectable without a second source of truth.
 *
 * Cleared on: an answer, `/cancel`, or a later free-text message that supersedes it.
 */
export const pendingPrompt = pgTable(
  'pending_prompt',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    parseEventId: uuid('parse_event_id').references(() => parseEvent.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [check('pending_prompt_kind_check', sql`${t.kind} in ('confirm', 'clarify')`)],
);

export type InboundUpdateRow = typeof inboundUpdate.$inferSelect;
export type PendingPromptRow = typeof pendingPrompt.$inferSelect;
