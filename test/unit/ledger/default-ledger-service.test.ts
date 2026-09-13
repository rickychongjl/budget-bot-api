import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryLedgerRepository } from '../../support/in-memory-ledger-repository';
import { candidate, createHarness, OTHER_USER, sydneyNoon, USER, type Harness } from './harness';

/**
 * M3's "Tests to write": record atomicity, `deleteLast` picking by `created_at`,
 * refund/income netting, `history` scoping, and the backdating floor.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function budgeted(name: string, cap = 60_000n) {
  const category = await h.categories.create(USER, name);
  await h.budgets.setCap(USER, category.id, cap);
  return category;
}

describe('record', () => {
  it('stores the candidate and attaches the period covering its date', async () => {
    const food = await budgeted('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));

    expect(tx).toMatchObject({
      userId: USER,
      categoryId: food.id,
      direction: 'expense',
      amountMinorUnits: 8240n,
      currencyCode: 'AUD',
      occurredOn: '2026-09-10',
      status: 'confirmed',
      rawText: 'woolies 82.40',
      parseRoute: 'mechanical',
    });
    const period = h.store.periods.find((p) => p.id === tx.budgetPeriodId);
    expect(period).toMatchObject({ periodKey: '2026-09', periodStart: '2026-09-05', periodEnd: '2026-10-04' });
  });

  /** M3's invariant: a confirmed transaction whose category has an active budget has a period. */
  it('materialises the period lazily, exactly once, across several transactions', async () => {
    const food = await budgeted('Food');
    const first = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredOn: '2026-09-06', occurredAt: sydneyNoon('2026-09-06') }),
    );
    const second = await h.ledger.record(USER, candidate({ categoryId: food.id, occurredOn: '2026-09-10' }));

    expect(second.budgetPeriodId).toBe(first.budgetPeriodId);
    expect(h.store.periods).toHaveLength(1);
  });

  it('records against an uncapped category with a null period', async () => {
    const gifts = await h.categories.create(USER, 'Gifts');
    const tx = await h.ledger.record(USER, candidate({ categoryId: gifts.id }));
    expect(tx.budgetPeriodId).toBeNull();
    expect(h.store.periods).toHaveLength(0);
  });

  /**
   * M3 checklist 2a: `occurred_on` is derived from `occurred_at` and the timezone,
   * once, at write time — the candidate's own copy is not what gets stored.
   */
  it('derives occurred_on from occurred_at in the user"s timezone', async () => {
    const food = await budgeted('Food');
    // 2026-09-10 23:30 in Sydney is 13:30Z the same day.
    const tx = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredAt: Date.parse('2026-09-10T13:30:00Z'), occurredOn: '2026-09-01' }),
    );
    expect(tx.occurredOn).toBe('2026-09-10');
  });

  it('a late-evening Sydney entry does not slip into the next UTC day', async () => {
    const food = await budgeted('Food');
    // 22:00Z on the 9th is already 08:00 on the 10th in Sydney.
    const tx = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredAt: Date.parse('2026-09-09T22:00:00Z') }),
    );
    expect(tx.occurredOn).toBe('2026-09-10');
  });

  it('buckets a backdated entry into the period that owns its date, not today"s', async () => {
    // The cap has to have governed August for August to have a period (M4, 12 Sep):
    // set it while August is the current cycle, then come back to today.
    h.clock.set('2026-08-01T02:00:00Z');
    const food = await budgeted('Food');
    h.clock.set('2026-09-10T02:00:00Z');
    const august = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredOn: '2026-08-20', occurredAt: sydneyNoon('2026-08-20') }),
    );
    const september = await h.ledger.record(USER, candidate({ categoryId: food.id }));

    expect(august.budgetPeriodId).not.toBe(september.budgetPeriodId);
    expect(h.store.periods.find((p) => p.id === august.budgetPeriodId)?.periodKey).toBe('2026-08');
  });

  it('records a backdated entry into a cycle before the budget existed with no period — uncapped then', async () => {
    // The August case (Ricky, 11–12 Sep): cap set in September, dinner backdated to
    // August. M4 used to open August at September's cap; now August had no cap, so the
    // entry is recorded like any uncapped expense and never counts against a cap.
    const food = await budgeted('Food'); // today is 10 Sep: September's row only
    const august = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredOn: '2026-08-20', occurredAt: sydneyNoon('2026-08-20') }),
    );
    expect(august.budgetPeriodId).toBeNull();
    expect(h.store.periods).toHaveLength(0);
  });

  /** Confirmed round 3: the floor is the account creation date. */
  it('rejects a date before the account existed and accepts the creation date itself', async () => {
    const food = await budgeted('Food');
    h.settings.accountCreatedOn = '2026-09-05';

    await expect(
      h.ledger.record(
        USER,
        candidate({ categoryId: food.id, occurredOn: '2026-09-04', occurredAt: sydneyNoon('2026-09-04') }),
      ),
    ).rejects.toThrow(/2026-09-05/);

    await expect(
      h.ledger.record(
        USER,
        candidate({ categoryId: food.id, occurredOn: '2026-09-05', occurredAt: sydneyNoon('2026-09-05') }),
      ),
    ).resolves.toMatchObject({ occurredOn: '2026-09-05' });
  });

  it('rejects a non-positive amount and a foreign currency', async () => {
    const food = await budgeted('Food');
    await expect(
      h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 0n })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      h.ledger.record(USER, candidate({ categoryId: food.id, currencyCode: 'USD' })),
    ).rejects.toThrow(/AUD/);
    expect(h.store.transactions).toHaveLength(0);
  });

  /** Step 2c: a category is created only when the user confirmed it, never invented here. */
  it('refuses to invent a category from newCategoryName', async () => {
    await expect(
      h.ledger.record(USER, candidate({ categoryId: null, newCategoryName: 'Coffee' })),
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
    expect(h.store.categories).toHaveLength(0);
  });

  it('refuses a category belonging to somebody else', async () => {
    const food = await budgeted('Food');
    await expect(h.ledger.record(OTHER_USER, candidate({ categoryId: food.id }))).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });

  /**
   * M3's atomicity test: a failure between period resolution and the insert must leave
   * no orphaned row — not the ledger row, and not the `budget_period` that was
   * materialised for it moments earlier.
   */
  it('leaves no orphaned period when the insert fails mid-transaction', async () => {
    const food = await budgeted('Food');
    // Fail exactly between step b (period resolution) and step d (the insert).
    const boom = vi
      .spyOn(InMemoryLedgerRepository.prototype, 'insertTransaction')
      .mockRejectedValueOnce(new Error('insert exploded'));

    await expect(h.ledger.record(USER, candidate({ categoryId: food.id }))).rejects.toThrow('insert exploded');

    expect(h.store.transactions).toHaveLength(0);
    // The period the failed record materialised is gone too — no row survives that a
    // later budget query would find attached to nothing.
    expect(h.store.periods).toHaveLength(0);
    boom.mockRestore();

    // And the next attempt still works, materialising the period cleanly.
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));
    expect(tx.budgetPeriodId).not.toBeNull();
    expect(h.store.periods).toHaveLength(1);
  });

  it('tells M5 to recalculate the day it touched', async () => {
    const food = await budgeted('Food');
    await h.ledger.record(USER, candidate({ categoryId: food.id }));
    expect(h.allowance.changed).toEqual([{ userId: USER, localDate: '2026-09-10' }]);
  });

  it('does not fail the user"s write when M5 is unavailable', async () => {
    const food = await budgeted('Food');
    h.allowance.failOnLedgerChange = true;
    await expect(h.ledger.record(USER, candidate({ categoryId: food.id }))).resolves.toMatchObject({
      status: 'confirmed',
    });
  });
});

describe('spendInPeriod / spentOn — netting', () => {
  it('nets refunds out and ignores income, in the same period', async () => {
    const food = await budgeted('Food');
    const expense = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, direction: 'expense', amountMinorUnits: 10_000n }),
    );
    await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, direction: 'refund', amountMinorUnits: 2_500n }),
    );
    await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, direction: 'income', amountMinorUnits: 500_000n }),
    );

    const periodId = expense.budgetPeriodId as string;
    expect(await h.ledger.spendInPeriod(USER, periodId)).toBe(7_500n);
    expect(await h.ledger.spentOn(USER, '2026-09-10')).toBe(7_500n);
  });

  it('honours the upTo cut-off', async () => {
    const food = await budgeted('Food');
    const early = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredOn: '2026-09-06', occurredAt: sydneyNoon('2026-09-06'), amountMinorUnits: 1_000n }),
    );
    await h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 9_000n }));

    const periodId = early.budgetPeriodId as string;
    expect(await h.ledger.spendInPeriod(USER, periodId, '2026-09-06')).toBe(1_000n);
    expect(await h.ledger.spendInPeriod(USER, periodId)).toBe(10_000n);
  });

  it('excludes soft-deleted rows and other users', async () => {
    const food = await budgeted('Food');
    const kept = await h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 3_000n }));
    const removed = await h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 4_000n }));
    await h.ledger.softDelete(USER, removed.id);

    expect(await h.ledger.spendInPeriod(USER, kept.budgetPeriodId as string)).toBe(3_000n);
    expect(await h.ledger.spendInPeriod(OTHER_USER, kept.budgetPeriodId as string)).toBe(0n);
  });
});

describe('correct', () => {
  it('re-buckets the transaction when the date moves to another period', async () => {
    h.clock.set('2026-08-01T02:00:00Z');
    const food = await budgeted('Food');
    h.clock.set('2026-09-10T02:00:00Z');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));

    const corrected = await h.ledger.correct(USER, tx.id, { occurredOn: '2026-08-20' });

    expect(corrected.occurredOn).toBe('2026-08-20');
    expect(corrected.budgetPeriodId).not.toBe(tx.budgetPeriodId);
    expect(h.store.periods.find((p) => p.id === corrected.budgetPeriodId)?.periodKey).toBe('2026-08');
  });

  it('moves the period when the category changes', async () => {
    const food = await budgeted('Food');
    const transport = await budgeted('Transport', 20_000n);
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));

    const corrected = await h.ledger.correct(USER, tx.id, { categoryId: transport.id });

    const period = h.store.periods.find((p) => p.id === corrected.budgetPeriodId);
    const transportBudget = (await h.budgets.activeBudgets(USER)).find((b) => b.categoryId === transport.id);
    expect(period?.budgetId).toBe(transportBudget?.id);
  });

  it('applies the same validation as record', async () => {
    const food = await budgeted('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));
    await expect(h.ledger.correct(USER, tx.id, { amountMinorUnits: 0n })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(h.ledger.correct(USER, tx.id, { occurredOn: '2026-12-25' })).rejects.toThrow(/future/);
  });

  it('recalculates both the old and the new day', async () => {
    const food = await budgeted('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));
    h.allowance.changed.length = 0;

    await h.ledger.correct(USER, tx.id, { occurredOn: '2026-09-08' });

    expect(h.allowance.changed.map((c) => c.localDate)).toEqual(['2026-09-10', '2026-09-08']);
  });

  it('is RESOURCE_NOT_FOUND for another user"s transaction', async () => {
    const food = await budgeted('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));
    await expect(h.ledger.correct(OTHER_USER, tx.id, { note: 'x' } as never)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  // M6 open question 2, closed M7 stage 4D: `parse_event.was_corrected` is only
  // honest if `correct()` actually tells M6 when a parsed transaction is fixed.
  describe('the M6 correction callback', () => {
    it('reports a correction on a transaction that came from a parse', async () => {
      const food = await budgeted('Food');
      const tx = await h.ledger.record(USER, candidate({ categoryId: food.id, parseEventId: 'pe-1' }));

      await h.ledger.correct(USER, tx.id, { note: 'actually lunch' });

      expect(h.correction.corrected).toEqual(['pe-1']);
    });

    it('says nothing for a transaction with no parse event — a 4C-style direct write', async () => {
      const food = await budgeted('Food');
      const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));

      await h.ledger.correct(USER, tx.id, { note: 'actually lunch' });

      expect(h.correction.corrected).toEqual([]);
    });

    it('does not fail the user"s correction when M6 is unavailable', async () => {
      const food = await budgeted('Food');
      const tx = await h.ledger.record(USER, candidate({ categoryId: food.id, parseEventId: 'pe-2' }));
      h.correction.failOnCorrection = true;

      await expect(h.ledger.correct(USER, tx.id, { note: 'actually lunch' })).resolves.toMatchObject({
        note: 'actually lunch',
      });
    });
  });
});

describe('softDelete / deleteLast', () => {
  it('keeps the row and stamps it, rather than removing it', async () => {
    const food = await budgeted('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));

    await h.ledger.softDelete(USER, tx.id);

    expect(h.store.transactions[0]).toMatchObject({ status: 'deleted', deletedAt: h.clock.now() });
    expect(await h.ledger.history(USER, { limit: 10 })).toMatchObject({ items: [] });
  });

  /**
   * M3's test: `deleteLast` picks by `created_at` — "the one I just typed" — even when
   * a backdated entry has a later `created_at` but an earlier `occurred_on`.
   */
  it('picks the most recent action, not the most recent date', async () => {
    const food = await budgeted('Food');
    const today = await h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 1_000n }));

    h.clock.advance(60_000);
    const backdated = await h.ledger.record(
      USER,
      candidate({
        categoryId: food.id,
        occurredOn: '2026-09-06',
        occurredAt: sydneyNoon('2026-09-06'),
        amountMinorUnits: 2_000n,
      }),
    );

    const deleted = await h.ledger.deleteLast(USER);

    expect(deleted?.id).toBe(backdated.id);
    expect(deleted?.occurredOn).toBe('2026-09-06');
    expect((await h.ledger.history(USER, { limit: 10 })).items.map((t) => t.id)).toEqual([today.id]);
  });

  it('and the other way round: a later occurred_on with an earlier created_at is not picked', async () => {
    const food = await budgeted('Food');
    h.clock.set('2026-09-08T02:00:00Z');
    const laterDate = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredOn: '2026-09-08', occurredAt: sydneyNoon('2026-09-08') }),
    );
    h.clock.set('2026-09-10T02:00:00Z');
    const laterAction = await h.ledger.record(
      USER,
      candidate({ categoryId: food.id, occurredOn: '2026-09-07', occurredAt: sydneyNoon('2026-09-07') }),
    );

    expect((await h.ledger.deleteLast(USER))?.id).toBe(laterAction.id);
    expect((await h.ledger.history(USER, { limit: 10 })).items.map((t) => t.id)).toEqual([laterDate.id]);
  });

  it('is null when there is nothing to delete', async () => {
    expect(await h.ledger.deleteLast(USER)).toBeNull();
  });

  it('never reaches another user"s rows', async () => {
    const food = await budgeted('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id }));
    expect(await h.ledger.deleteLast(OTHER_USER)).toBeNull();
    await expect(h.ledger.softDelete(OTHER_USER, tx.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(h.store.transactions[0]?.status).toBe('confirmed');
  });
});

describe('history', () => {
  it('pages newest-first and stops with a null cursor', async () => {
    const food = await budgeted('Food');
    const dates = ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];
    for (const date of dates) {
      h.clock.advance(60_000);
      await h.ledger.record(USER, candidate({ categoryId: food.id, occurredOn: date, occurredAt: sydneyNoon(date) }));
    }

    const first = await h.ledger.history(USER, { limit: 2 });
    expect(first.items.map((t) => t.occurredOn)).toEqual(['2026-09-10', '2026-09-09']);
    expect(first.nextCursor).not.toBeNull();

    const second = await h.ledger.history(USER, { limit: 2, cursor: first.nextCursor as string });
    expect(second.items.map((t) => t.occurredOn)).toEqual(['2026-09-08', '2026-09-07']);

    const third = await h.ledger.history(USER, { limit: 2, cursor: second.nextCursor as string });
    expect(third.items.map((t) => t.occurredOn)).toEqual(['2026-09-06']);
    expect(third.nextCursor).toBeNull();
  });

  it('separates same-day rows by when they were entered', async () => {
    const food = await budgeted('Food');
    const first = await h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 100n }));
    h.clock.advance(60_000);
    const second = await h.ledger.record(USER, candidate({ categoryId: food.id, amountMinorUnits: 200n }));

    const page = await h.ledger.history(USER, { limit: 10 });
    expect(page.items.map((t) => t.id)).toEqual([second.id, first.id]);
  });

  /** M3's invariant: no code path can return another user's rows. */
  it('never returns another user"s rows', async () => {
    const food = await budgeted('Food');
    await h.ledger.record(USER, candidate({ categoryId: food.id }));
    expect(await h.ledger.history(OTHER_USER, { limit: 10 })).toEqual({ items: [], nextCursor: null });
  });

  it('rejects a malformed cursor rather than silently returning page one', async () => {
    await expect(h.ledger.history(USER, { limit: 2, cursor: 'garbage' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('exportCsv', () => {
  /** Deferred this pass (round 5, Story 7) — the signature stays, the body refuses. */
  it('refuses with NOT_YET_AVAILABLE so M7 can stub /export against it', async () => {
    await expect(h.ledger.exportCsv(USER)).rejects.toMatchObject({ code: 'NOT_YET_AVAILABLE' });
  });
});
