import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Id, Instant } from '../../../core/shared/common';
import { parseEvent } from '../schema/observability';
import type {
  ParseEventCorrectionHook,
  ParseEventInput,
  ParseEventRepository,
} from '../../../parsing/parse-event-repository';

/**
 * The Drizzle implementation of M9's `parse_event` port (CLAUDE.md: concrete
 * Drizzle repositories live under `infrastructure/database/repositories/`).
 *
 * It also implements `ParseEventCorrectionHook` so M3 can flip `was_corrected`
 * without holding the whole pipeline.
 */
type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export class DrizzleParseEventRepository implements ParseEventRepository, ParseEventCorrectionHook {
  constructor(private readonly db: Db) {}

  async record(event: ParseEventInput, now: Instant): Promise<Id> {
    const rows = await this.db
      .insert(parseEvent)
      .values({
        userId: event.userId,
        route: event.route,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        latencyMs: event.latencyMs,
        neededClarification: event.neededClarification,
        wasCorrected: false,
        createdAt: new Date(now),
      })
      .returning({ id: parseEvent.id });
    const row = rows[0];
    if (row === undefined) throw new Error('parse_event insert returned no row');
    return row.id;
  }

  async markCorrected(parseEventId: Id): Promise<void> {
    await this.db.update(parseEvent).set({ wasCorrected: true }).where(eq(parseEvent.id, parseEventId));
  }

  onTransactionCorrected(parseEventId: Id): Promise<void> {
    return this.markCorrected(parseEventId);
  }
}
