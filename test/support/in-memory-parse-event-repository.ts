import type { Id, Instant } from '../../src/core/shared/common';
import type { ParseEventInput, ParseEventRepository } from '../../src/parsing/parse-event-repository';
import { fakeId } from './fake-id';

export interface RecordedParseEvent extends ParseEventInput {
  id: Id;
  createdAt: Instant;
  wasCorrected: boolean;
}

/**
 * A test adapter for M9's `parse_event` port. Keeping every row in memory is what
 * lets the unit and eval suites assert M9's invariants directly: exactly one event
 * per parse, and no message text anywhere in its values.
 */
export class InMemoryParseEventRepository implements ParseEventRepository {
  readonly events: RecordedParseEvent[] = [];

  async record(event: ParseEventInput, now: Instant): Promise<Id> {
    const id = fakeId('pe');
    this.events.push({ ...event, id, createdAt: now, wasCorrected: false });
    return id;
  }

  async markCorrected(parseEventId: Id): Promise<void> {
    const e = this.events.find((x) => x.id === parseEventId);
    if (e !== undefined) e.wasCorrected = true;
  }
}
