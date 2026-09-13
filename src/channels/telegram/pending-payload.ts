import { z } from 'zod';
import type { ValidatedCandidate } from '../../core/ledger/ledger-service';
import type { Id } from '../../core/shared/common';
import type { ClarifyReason, MappingProposal } from '../../parsing/types';
import type { PendingPromptKind } from './gateway-repository';

/**
 * What goes in `pending_prompt.payload`, and how it survives the round trip through
 * a jsonb column.
 *
 * Two reasons this is a file rather than a `JSON.stringify` call at the call site:
 *
 *   1. **`ValidatedCandidate.amountMinorUnits` is a `bigint`.** `JSON.stringify`
 *      throws on one ("Do not know how to serialize a BigInt"), and a `confirm`
 *      prompt exists precisely to carry a candidate. The codec writes it as decimal
 *      text and reads it back as a `bigint`; nothing upstream or downstream sees a
 *      number, so no amount ever passes through a float.
 *   2. **The row outlives the code that wrote it.** A prompt written before a deploy
 *      is answered after it, and a payload shape that has since changed must not take
 *      the dispatcher down. `decodePendingPayload` returns `null` for anything it
 *      cannot fully validate, and the caller's contract is to clear the row and
 *      answer `STALE_ACTION` — the same thing the user sees for a button that has
 *      already been used.
 *
 * The shapes themselves are M6's. M7 stores and returns them; it does not interpret
 * a candidate's fields or decide what a reason means.
 */

// ---- the three payloads ----------------------------------------------------------

/**
 * M6 parsed the message but was not confident enough to record it. Everything
 * `recordConfirmed(context, candidate, parseEventId, mappingProposal)` needs is here:
 * lose any one field and a "yes" cannot be honoured. `categoryName` is carried so the
 * question can be re-read without a second category lookup.
 */
export interface ConfirmPayload {
  kind: 'confirm';
  candidate: ValidatedCandidate;
  parseEventId: Id;
  categoryName: string | null;
  mappingProposal: MappingProposal | null;
}

/**
 * M6 asked a targeted question and the next message is the answer.
 *
 * `original` is the message that prompted the question, because `answerClarification`
 * needs it — for most reasons the answer extends the original rather than replacing
 * it. **This is the first time this table holds message text**, which is a retention
 * fact rather than a new class of data: the same text lands in `transaction.raw_text`
 * the moment the entry records, and the row is cleared on an answer, on `/cancel`, or
 * when a later message supersedes it. An abandoned prompt, though, lives until the
 * user's next message — flagged for M9's retention pass.
 */
export interface ClarifyPayload {
  kind: 'clarify';
  original: string;
  reason: ClarifyReason;
  question: string;
  parseEventId: Id;
}

/**
 * The transaction is already recorded; what is open is "Always categorise X as Y?".
 * The proposal is the whole answer — `confirmMerchantMapping` takes it verbatim —
 * and it lives here rather than in the button because four fields do not fit
 * Telegram's 64-byte `callback_data`, and because M11 requires a typed "yes" to find
 * the same proposal the button would have.
 */
export interface MappingPayload {
  kind: 'mapping';
  proposal: MappingProposal;
}

export type PendingPayload = ConfirmPayload | ClarifyPayload | MappingPayload;

// ---- schemas ---------------------------------------------------------------------

/** `bigint` ⇄ decimal text. The only representation of money that crosses this column. */
const minorUnitsSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => BigInt(value));

const directionSchema = z.enum(['expense', 'income', 'refund']);
const routeSchema = z.enum(['command', 'mechanical', 'mapping', 'llm']);

/**
 * Every `ClarifyReason`, listed so a stored reason can be validated rather than cast.
 *
 * `satisfies` catches a typo here; `UnlistedClarifyReason` catches the other
 * direction — a reason added to M6's union and forgotten here resolves to something
 * other than `never` and fails `npm run typecheck`.
 */
const CLARIFY_REASONS = [
  'multiple_amounts',
  'no_amount',
  'invalid_amount',
  'foreign_currency',
  'ambiguous_date',
  'invalid_date',
  'missing_category',
  'unknown_category',
  'ambiguous_intent',
  'correction_intent',
  'multi_category_merchant',
  'low_confidence',
  'model_asked',
  'llm_unavailable',
] as const satisfies readonly ClarifyReason[];

export type UnlistedClarifyReason = Exclude<ClarifyReason, (typeof CLARIFY_REASONS)[number]> extends never
  ? never
  : ['a ClarifyReason is missing from CLARIFY_REASONS', Exclude<ClarifyReason, (typeof CLARIFY_REASONS)[number]>];

const proposalSchema = z.object({
  normalizedMerchant: z.string(),
  displayMerchant: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
});

const candidateSchema = z.object({
  direction: directionSchema,
  amountMinorUnits: minorUnitsSchema,
  currencyCode: z.string(),
  occurredAt: z.number(),
  occurredOn: z.string(),
  categoryId: z.string().nullable(),
  newCategoryName: z.string().optional(),
  merchantDisplay: z.string().optional(),
  normalizedMerchant: z.string().optional(),
  note: z.string().optional(),
  rawText: z.string(),
  parseRoute: routeSchema,
  parseConfidence: z.number().optional(),
});

const confirmSchema = z.object({
  kind: z.literal('confirm'),
  candidate: candidateSchema,
  parseEventId: z.string(),
  categoryName: z.string().nullable(),
  mappingProposal: proposalSchema.nullable(),
});

const clarifySchema = z.object({
  kind: z.literal('clarify'),
  original: z.string(),
  reason: z.enum(CLARIFY_REASONS),
  question: z.string(),
  parseEventId: z.string(),
});

const mappingSchema = z.object({
  kind: z.literal('mapping'),
  proposal: proposalSchema,
});

// ---- codec -----------------------------------------------------------------------

/**
 * A JSON-safe view of the payload, ready for the jsonb column. Optional candidate
 * fields are omitted rather than written as `null`: `exactOptionalPropertyTypes` is on,
 * and a round trip that turned an absent merchant into an explicit null would change
 * the candidate M3 is later handed.
 */
export function encodePendingPayload(payload: PendingPayload): unknown {
  if (payload.kind !== 'confirm') return payload;

  const c = payload.candidate;
  return {
    kind: 'confirm',
    parseEventId: payload.parseEventId,
    categoryName: payload.categoryName,
    mappingProposal: payload.mappingProposal,
    candidate: {
      direction: c.direction,
      amountMinorUnits: c.amountMinorUnits.toString(),
      currencyCode: c.currencyCode,
      occurredAt: c.occurredAt,
      occurredOn: c.occurredOn,
      categoryId: c.categoryId,
      ...optional('newCategoryName', c.newCategoryName),
      ...optional('merchantDisplay', c.merchantDisplay),
      ...optional('normalizedMerchant', c.normalizedMerchant),
      ...optional('note', c.note),
      rawText: c.rawText,
      parseRoute: c.parseRoute,
      ...optional('parseConfidence', c.parseConfidence),
    },
  };
}

/**
 * `null` for anything that is not exactly the payload this row's `kind` promises —
 * a shape from an older deploy, a hand-edited row, a `kind` that disagrees with its
 * own payload. The caller clears the row and answers `STALE_ACTION`; it never throws,
 * because a prompt is not worth an apology in place of an answer.
 */
export function decodePendingPayload(kind: PendingPromptKind, raw: unknown): PendingPayload | null {
  switch (kind) {
    case 'confirm': {
      const parsed = confirmSchema.safeParse(raw);
      if (!parsed.success) return null;
      const { candidate, ...rest } = parsed.data;
      return { ...rest, candidate: toCandidate(candidate) };
    }
    case 'clarify': {
      const parsed = clarifySchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    }
    case 'mapping': {
      const parsed = mappingSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    }
  }
}

/** Rebuilds the candidate with absent optionals genuinely absent. */
function toCandidate(parsed: z.infer<typeof candidateSchema>): ValidatedCandidate {
  return {
    direction: parsed.direction,
    amountMinorUnits: parsed.amountMinorUnits,
    currencyCode: parsed.currencyCode,
    occurredAt: parsed.occurredAt,
    occurredOn: parsed.occurredOn,
    categoryId: parsed.categoryId,
    ...optional('newCategoryName', parsed.newCategoryName),
    ...optional('merchantDisplay', parsed.merchantDisplay),
    ...optional('normalizedMerchant', parsed.normalizedMerchant),
    ...optional('note', parsed.note),
    rawText: parsed.rawText,
    parseRoute: parsed.parseRoute,
    ...optional('parseConfidence', parsed.parseConfidence),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
