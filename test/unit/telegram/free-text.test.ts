import { beforeEach, describe, expect, it } from 'vitest';
import { APOLOGY } from '../../../src/channels/telegram/dispatcher';
import { DROPPED_REPLY, MAPPING_DECLINED_REPLY } from '../../../src/channels/telegram/free-text';
import { refusalText } from '../../../src/channels/telegram/render';
import type { Id } from '../../../src/core/shared/common';
import { LlmParseError } from '../../../src/parsing/llm-parser';
import { llmResult } from '../../support/scripted-llm-parser';
import { USER, createHarness, reply, replyMessage, tap } from './harness';
import type { Harness } from './harness';

/**
 * Stage 4D end to end, driven through the dispatcher.
 *
 * Nothing here calls the handler directly. A handler in isolation cannot show the two
 * things most likely to break this path — that a message actually routes to it past
 * admission, onboarding and the command table, and that a press of one of its own
 * buttons comes back to the right method — and both are exactly what 4D adds.
 *
 * M6 is real: the normaliser, the mechanical extractors, the validator and the
 * confidence policy are the production classes, and so are M3, M4 and M5 behind them.
 * Only the model is scripted. Every figure below is therefore computed, not fixed: the
 * clock is 12:00 on 11 Sep in Sydney and the anchor is the 5th, so a $600 Food cap
 * over the 24 days left in the 5 Sep – 4 Oct cycle is $25 a day.
 */

let h: Harness;
let food: Id;

beforeEach(async () => {
  h = createHarness();
  food = await h.seedCategory(USER, 'Food', { cap: 60000n });
});

/** A mapping this user confirmed some time before today. */
function rememberWoolies(): void {
  h.mappings.seed({
    userId: USER,
    normalizedMerchant: 'woolies',
    displayMerchant: 'Woolworths',
    categoryId: food,
    source: 'user_confirmed',
  });
}

const CONFIDENT_WOOLIES = llmResult({
  intent: 'expense',
  amount: 12.5,
  currency: 'AUD',
  merchant: 'Woolworths',
  category: 'Food',
  confidence: 0.96,
});

const UNSURE_BUNNINGS = llmResult({
  intent: 'expense',
  amount: 89.5,
  currency: 'AUD',
  merchant: 'Bunnings',
  category: 'Food',
  confidence: 0.7,
});

describe('the mapping route', () => {
  it('records a remembered merchant with no model call, and says what is left today', async () => {
    rememberWoolies();

    const message = await replyMessage(h, 'woolies 12.50');

    expect(message.text).toBe(
      'Recorded $12.50 at Woolworths under Food.\nYou can spend $12.50 on Food today to stay on budget.',
    );
    // The whole point of merchant memory: a remembered merchant costs nothing.
    expect(h.llm.calls).toHaveLength(0);
    expect(message.replyMarkup).toBeUndefined();
    expect(h.gateway.has(USER)).toBe(false);
  });

  it('records income without an allowance line, because income offsets no cap', async () => {
    const message = await replyMessage(h, '+2500 salary');

    expect(message.text).toContain('Recorded $2500 income');
    expect(message.text).not.toContain('You can spend');
    expect(h.store.transactions).toHaveLength(1);
    expect(h.store.transactions[0]!.direction).toBe('income');
  });
});

describe('the LLM route', () => {
  it('records a confident parse and offers to remember the merchant', async () => {
    h.llm.enqueue(CONFIDENT_WOOLIES);

    const message = await replyMessage(h, 'woolies 12.50');

    expect(message.text).toBe(
      'Recorded $12.50 at Woolworths under Food.\n' +
        'You can spend $12.50 on Food today to stay on budget.\n\n' +
        'Always categorise Woolworths as Food?',
    );
    // One message, keyboard included — M11's "one reply per input step".
    expect(h.sender.callCount).toBe(1);
    expect(message.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'map:yes' },
          { text: 'No', callback_data: 'map:no' },
        ],
      ],
    });
    // The offer is open; nothing is remembered until it is answered.
    expect(h.mappings.saves).toHaveLength(0);
  });

  it('remembers the merchant on yes, and the next identical message skips the model', async () => {
    h.llm.enqueue(CONFIDENT_WOOLIES);
    await replyMessage(h, 'woolies 12.50');

    const confirmation = await tap(h, 'map:yes');

    expect(confirmation.text).toBe('Got it — Woolworths goes under Food from now on.');
    expect(h.mappings.saves).toHaveLength(1);
    expect(h.mappings.saves[0]).toMatchObject({ normalizedMerchant: 'woolies', source: 'user_confirmed' });
    expect(h.gateway.has(USER)).toBe(false);

    await replyMessage(h, 'woolies 12.50');

    // Still one model call in total — the second message took the mapping route.
    expect(h.llm.calls).toHaveLength(1);
    expect(h.store.transactions).toHaveLength(2);
  });

  it('remembers nothing on no, and the entry stays recorded', async () => {
    h.llm.enqueue(CONFIDENT_WOOLIES);
    await replyMessage(h, 'woolies 12.50');

    const answer = await tap(h, 'map:no');

    expect(answer.text).toBe(MAPPING_DECLINED_REPLY);
    expect(h.mappings.saves).toHaveLength(0);
    expect(h.store.transactions).toHaveLength(1);
    expect(h.gateway.has(USER)).toBe(false);
  });

  it('answers the outage honestly instead of recording a guess', async () => {
    h.llm.enqueue(new LlmParseError('api_error', 'upstream down'));

    const message = await replyMessage(h, 'something unusual 40');

    expect(message.text).toContain("I couldn't work that one out just now");
    expect(h.store.transactions).toHaveLength(0);
    // The question is open, so the next message is read as an answer to it.
    expect(h.gateway.has(USER)).toBe(true);
  });
});

describe('the confirm prompt', () => {
  beforeEach(async () => {
    h.llm.enqueue(UNSURE_BUNNINGS);
  });

  it('asks before recording and remembers what it asked about', async () => {
    const message = await replyMessage(h, 'bunnings 89.50');

    expect(message.text).toContain('Should I record $89.50 at Bunnings under Food?');
    expect(message.replyMarkup).toMatchObject({
      inline_keyboard: [[{ callback_data: 'pc:yes' }, { callback_data: 'pc:no' }]],
    });
    expect(h.store.transactions).toHaveLength(0);
    expect(await h.gateway.findPendingPrompt(USER)).toMatchObject({ kind: 'confirm' });
  });

  it('records exactly one transaction on yes, then asks about the merchant', async () => {
    await replyMessage(h, 'bunnings 89.50');

    const message = await tap(h, 'pc:yes');

    expect(h.store.transactions).toHaveLength(1);
    expect(h.store.transactions[0]!.amountMinorUnits).toBe(8950n);
    expect(message.text).toContain('Recorded $89.50 at Bunnings under Food.');
    // The confirm row is gone; what replaced it is the merchant question, which is
    // the next thing this conversation is waiting on.
    expect(message.text).toContain('Always categorise Bunnings as Food?');
    expect(await h.gateway.findPendingPrompt(USER)).toMatchObject({ kind: 'mapping' });
  });

  it('records nothing on no, and closes the question', async () => {
    await replyMessage(h, 'bunnings 89.50');

    const message = await tap(h, 'pc:no');

    expect(message.text).toBe(DROPPED_REPLY);
    expect(h.store.transactions).toHaveLength(0);
    expect(h.gateway.has(USER)).toBe(false);
  });

  it.each([
    ['yes', true],
    ['Yes.', true],
    ['yep', true],
    ['no', false],
    ['nope', false],
  ])('reads a typed %s the same way as the button', async (text, records) => {
    await replyMessage(h, 'bunnings 89.50');

    await reply(h, text);

    expect(h.store.transactions).toHaveLength(records ? 1 : 0);
  });

  it('supersedes the question when the next message is plainly not an answer', async () => {
    rememberWoolies();
    await replyMessage(h, 'bunnings 89.50');

    const message = await replyMessage(h, 'woolies 12.50');

    // Someone typing a second expense wants that expense logged, not read as an
    // answer about the first one.
    expect(message.text).toContain('Recorded $12.50 at Woolworths under Food.');
    expect(h.store.transactions).toHaveLength(1);
    expect(h.store.transactions[0]!.amountMinorUnits).toBe(1250n);
    expect(h.gateway.has(USER)).toBe(false);
  });
});

describe('the clarify prompt', () => {
  it('asks, remembers the message it asked about, and records once answered', async () => {
    rememberWoolies();
    h.llm.enqueue(llmResult({ intent: 'expense', merchant: 'Woolworths', category: 'Food', confidence: 0.9 }));

    const question = await replyMessage(h, 'woolies');

    expect(question.text).toBe('How much was it?');
    expect(await h.gateway.findPendingPrompt(USER)).toMatchObject({ kind: 'clarify' });

    const answer = await replyMessage(h, '12.50');

    // "12.50" on its own names no merchant. Only an answer merged with the message
    // that prompted it can come back with Woolworths.
    expect(answer.text).toContain('Recorded $12.50 at Woolworths under Food.');
    expect(h.gateway.has(USER)).toBe(false);
  });
});

describe('/cancel says something true for each kind of question', () => {
  it('drops a confirm without recording', async () => {
    h.llm.enqueue(UNSURE_BUNNINGS);
    await replyMessage(h, 'bunnings 89.50');

    expect(await reply(h, '/cancel')).toBe(DROPPED_REPLY);
    expect(h.store.transactions).toHaveLength(0);
  });

  it('drops a clarify without recording', async () => {
    h.llm.enqueue(new LlmParseError('api_error', 'down'));
    await replyMessage(h, 'something unusual 40');

    expect(await reply(h, '/cancel')).toBe(DROPPED_REPLY);
    expect(h.store.transactions).toHaveLength(0);
  });

  it('does not claim a mapping question was an unrecorded entry', async () => {
    h.llm.enqueue(CONFIDENT_WOOLIES);
    await replyMessage(h, 'woolies 12.50');

    const message = await reply(h, '/cancel');

    // The entry was recorded before the question was asked. "Nothing was recorded"
    // here would send someone to /delete to fix something that is not broken.
    expect(message).toBe("OK, I won't remember that one. The entry itself is still recorded.");
    expect(h.store.transactions).toHaveLength(1);
    expect(h.mappings.saves).toHaveLength(0);
  });
});

describe('a press with nothing behind it', () => {
  it('answers a confirm button with no open question as stale', async () => {
    const message = await tap(h, 'pc:yes');

    expect(message.text).toBe(refusalText('STALE_ACTION'));
    expect(h.store.transactions).toHaveLength(0);
  });

  it('answers a mapping button with no open question as stale', async () => {
    expect((await tap(h, 'map:yes')).text).toBe(refusalText('STALE_ACTION'));
    expect(h.mappings.saves).toHaveLength(0);
  });

  it('clears a row whose payload no longer decodes rather than throwing', async () => {
    // A prompt written by an older deploy, or a hand-edited row. The user sees the
    // same thing they see for a button they have already used.
    await h.gateway.setPendingPrompt({
      userId: USER,
      kind: 'confirm',
      payload: { shape: 'from an older deploy' },
      now: h.clock.now(),
    });

    const message = await tap(h, 'pc:yes');

    expect(message.text).toBe(refusalText('STALE_ACTION'));
    expect(h.gateway.has(USER)).toBe(false);
  });

  it('answers a typed reply to an undecodable row as stale too', async () => {
    await h.gateway.setPendingPrompt({
      userId: USER,
      kind: 'clarify',
      payload: 'not even an object',
      now: h.clock.now(),
    });

    expect(await reply(h, 'groceries')).toBe(refusalText('STALE_ACTION'));
    expect(h.gateway.has(USER)).toBe(false);
  });
});

describe('when something genuinely breaks', () => {
  it('apologises once and leaves the open question exactly where it was', async () => {
    h.llm.enqueue(new LlmParseError('api_error', 'down'));
    await replyMessage(h, 'something unusual 40');
    const before = await h.gateway.findPendingPrompt(USER);

    // Not an `LlmParseError`: the pipeline rethrows anything it does not recognise,
    // which is how a real bug reaches the dispatcher.
    h.llm.enqueue(() => {
      throw new Error('boom');
    });
    const message = await reply(h, 'at the corner shop');

    expect(message).toBe(APOLOGY);
    expect(h.sender.callCount).toBe(1);
    // The question survives, so the answer is not lost with the failure.
    expect(await h.gateway.findPendingPrompt(USER)).toEqual(before);
    expect(h.store.transactions).toHaveLength(0);
  });
});

describe("M9's invariant holds on this path too", () => {
  it('writes no message text into any parse_event, on any route', async () => {
    rememberWoolies();
    h.llm.enqueue(CONFIDENT_WOOLIES, new LlmParseError('api_error', 'down'));

    await replyMessage(h, 'woolies 12.50');
    await replyMessage(h, 'coffee at the corner place 6');
    await replyMessage(h, 'something unusual 40');

    expect(h.parseEvents.events.length).toBeGreaterThanOrEqual(3);
    const written = JSON.stringify(h.parseEvents.events.map((event) => Object.values(event)));
    for (const fragment of ['woolies', 'Woolworths', '12.50', 'coffee', 'corner', 'unusual']) {
      expect(written).not.toContain(fragment);
    }
  });
});
