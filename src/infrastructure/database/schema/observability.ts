import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appUser } from './identity';

/**
 * M9 — Observability, Privacy & Retention owns this file.
 * Built as part of M6's PR this pass (M9 is otherwise a deliberate stub).
 *
 * Tables: `parse_event`.
 *
 * Conventions: see `identity.ts` header. Specifics from M9/M6's plans:
 *   - `user_id` -> `app_user(id) on delete set null` — this is the ONE row that
 *     survives account deletion (test that the FK actually nulls, M9 checklist —
 *     see `test/integration/parse-event-fk.test.ts`).
 *   - `route text check (route in ('command','mechanical','mapping','llm'))`.
 *   - Holds routes, token counts, latencies, booleans ONLY. No message text, ever,
 *     under any route. That is what makes `user_id` safely nullable. There is no
 *     text column here on purpose — do not add one.
 *   - `was_corrected` is written later by M3's `correct` — a cross-module callback
 *     (`ParseEventCorrectionHook` in `src/parsing/parse-event-repository.ts`).
 *   - Index `(created_at)`.
 *
 * MERGE ORDER (M6 build-log, Open questions): `appUser` is M2's table. This import
 * resolves only once M2's PR (which fills `identity.ts`) has merged — until then
 * `npm run typecheck` reports exactly one TS2305 on this line. Nothing at runtime
 * touches the reference outside `drizzle-kit generate`, so the unit/eval suites are
 * unaffected. Generate this table's migration AFTER rebasing on M2 so it sorts after
 * `app_user`'s.
 */
export const parseEvent = pgTable(
  'parse_event',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').references(() => appUser.id, { onDelete: 'set null' }),
    route: text('route').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    neededClarification: boolean('needed_clarification').notNull().default(false),
    wasCorrected: boolean('was_corrected').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('parse_event_route_check', sql`${t.route} in ('command','mechanical','mapping','llm')`),
    index('parse_event_created').on(t.createdAt),
  ],
);

export type ParseEventRow = typeof parseEvent.$inferSelect;
export type NewParseEventRow = typeof parseEvent.$inferInsert;
