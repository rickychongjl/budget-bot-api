import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Id, Instant, UserId } from '../core/ports/common';
import type { ParseRoute } from '../core/ports/ledger-service';
import { parseEvent } from '../db/schema/observability';

/**
 * M9's `parse_event`, written by M6 on every parse (M6 checklist step 5).
 *
 * The input type is the privacy rule made structural: there is no field for text,
 * a merchant, a category name, or a channel identifier. `userId` is the internal
 * uuid (nullable so the row survives account deletion via `on delete set null`).
 */
export interface ParseEventInput {
  userId: UserId | null;
  route: ParseRoute;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  neededClarification: boolean;
}

export interface IParseEventRepository {
  /** Returns the new row's id so a later correction can be attributed to it. */
  record(event: ParseEventInput, now: Instant): Promise<Id>;
  markCorrected(parseEventId: Id): Promise<void>;
}

/**
 * The cross-module callback M3's `correct()` calls when the user fixes a
 * transaction (M9: "`was_corrected` is set later by M3 … the only honest measure of
 * parser accuracy"). M3 does not exist yet; this is the seam it wires into.
 *
 * Attribution: every `ParseOutcome` carries `parseEventId`. Whoever persists the
 * transaction ↔ parse-event link (see M6 build-log, open question) passes it here.
 */
export interface ParseEventCorrectionHook {
  onTransactionCorrected(parseEventId: Id): Promise<void>;
}

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export class DrizzleParseEventRepository implements IParseEventRepository, ParseEventCorrectionHook {
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
