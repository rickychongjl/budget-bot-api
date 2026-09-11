import type { BudgetAllowanceNotifier, BudgetPeriod } from '../budgets';
import type { AllowanceNotifier } from '../ledger';
import type { Clock } from '../shared/clock';
import type { Channel, Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';
import { addLocalDays, daysInclusive, localDateAt } from '../shared/local-date';
import type { ChannelConnection, MessageSender } from '../shared/messaging';
import type { AllowanceRepository, AllowanceSend, ReminderCategory } from './allowance-repository';
import type { AllowanceView, DailyAllowanceService, DueUser, SendOutcome } from './allowance-service';
import type {
  AllowanceBudgetReader,
  AllowanceSettingsReader,
  AllowanceSpendReader,
} from './collaborators';
import { computeDailyTarget } from './daily-target';
import { renderBundledReminder } from './messages';

/**
 * How long after a user's reminder time they stay due.
 *
 * M5's plan describes a 15-minute tick matching `reminder_local_time` exactly. A strict
 * equality window is too brittle in practice: Cloudflare cron fires "approximately" on
 * schedule and a tick can be dropped entirely, and there is no staging Worker to notice
 * that on (master plan §5.7). A 60-minute catch-up bound absorbs drift and a few missed
 * ticks, gives the 3-attempt retry budget room to play out, and still never delivers a
 * "morning reminder" at 3pm to someone who onboarded that afternoon.
 *
 * Once-only is guaranteed by "no sent/skipped row for today" plus the unique index, not
 * by the width of this window — widening it can never cause a double send.
 */
export const DUE_WINDOW_MINUTES = 60;

/** Retryable failures (429/5xx) get this many attempts before the bundle is `failed`. */
export const MAX_SEND_ATTEMPTS = 3;

const TELEGRAM: Channel = 'telegram';

/** M2's read/deactivate surface, narrowed to what the 403 path needs. */
export interface AllowanceConnectionDirectory {
  findActiveConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null>;
  deactivateConnection(userId: UserId, channel: Channel): Promise<void>;
}

export interface AllowanceServiceDeps<X> {
  repository: AllowanceRepository<X>;
  budgets: AllowanceBudgetReader;
  ledger: AllowanceSpendReader;
  settingsOf: AllowanceSettingsReader;
  connections: AllowanceConnectionDirectory;
  sender: MessageSender;
  clock: Clock;
}

/** A computed target plus the row it was persisted as — the dispatch path needs both. */
interface ComputedTarget {
  view: AllowanceView;
  send: AllowanceSend;
}

/**
 * M5 — Daily Allowance & Scheduler.
 *
 * The one decision the rest of this class exists to protect: **`daily_target` is written
 * once per `(user, category, date)` and never recomputed from today's spend.** If it
 * were recomputed live from current spend, overspending at lunch would immediately
 * spread across the remaining days, `available_today` would quietly stay positive, and
 * the user would never see they had gone over. Persisting means today has a fixed
 * budget: going over is visible today as a negative number, and the correction arrives
 * tomorrow from a genuinely smaller remaining balance.
 *
 * So `availableToday` reads an existing row's target rather than recomputing it, and
 * `insertSend` returns the conflict *winner* rather than the value this invocation
 * calculated — two concurrent first-reads of the day agree on one number.
 *
 * The single exception is `capChanged` (Ricky, 11 Sep): a cap set mid-cycle is meant
 * to give the user more — or less — to spend *today*, not from tomorrow. That rewrite
 * still takes spend only to the end of yesterday, so it cannot reintroduce the failure
 * above: the trigger is the cap moving, never the day's own spend, and recomputing
 * twice on one day gives the same number both times.
 *
 * Delivery is bundled: one message per user per day covering every reminder-eligible
 * category, and every row in that bundle shares the send's outcome.
 */
export class DefaultAllowanceService<X>
  implements DailyAllowanceService, AllowanceNotifier, BudgetAllowanceNotifier
{
  private readonly repository: AllowanceRepository<X>;
  private readonly budgets: AllowanceBudgetReader;
  private readonly ledger: AllowanceSpendReader;
  private readonly settingsOf: AllowanceSettingsReader;
  private readonly connections: AllowanceConnectionDirectory;
  private readonly sender: MessageSender;
  private readonly clock: Clock;

  constructor(deps: AllowanceServiceDeps<X>) {
    this.repository = deps.repository;
    this.budgets = deps.budgets;
    this.ledger = deps.ledger;
    this.settingsOf = deps.settingsOf;
    this.connections = deps.connections;
    this.sender = deps.sender;
    this.clock = deps.clock;
  }

  async findDue(now: Instant, limit: number): Promise<readonly DueUser[]> {
    const rows = await this.repository.findDueUsers(
      { now, windowMinutes: DUE_WINDOW_MINUTES },
      limit,
    );
    return rows.map((r) => ({ userId: r.userId, localDate: r.localDate }));
  }

  async availableToday(userId: UserId, categoryId?: Id): Promise<readonly AllowanceView[]> {
    const { today } = await this.context(userId);
    const budgeted = await this.budgetedCategories(userId);
    const wanted =
      categoryId === undefined ? budgeted : budgeted.filter((c) => c.categoryId === categoryId);

    const computed = await this.computeAll(userId, wanted, today);
    return computed.map((c) => c.view);
  }

  async computeAndSend(userId: UserId): Promise<SendOutcome> {
    const { today, currencyCode } = await this.context(userId);

    // Step 1 — gather reminder-eligible categories and ensure each has a row for today.
    const candidates = (await this.budgetedCategories(userId)).filter((c) => c.reminderEnabled);
    const computed = await this.computeAll(userId, candidates, today);

    // Only rows this day has not already resolved. A row that is already `sent`,
    // `skipped` or `failed` is terminal, so a second dispatch for the same local date —
    // a duplicated subrequest, a retried tick — sends nothing rather than a second
    // message. The due scan filters these out too; this is the guarantee, not the
    // optimisation, because "once-only" must not depend on the caller getting it right.
    const outstanding = computed.filter((c) => c.send.deliveryStatus === 'pending');

    // Step 2 — revalidate immediately before building the message. The due scan and the
    // compute loop above both cost round trips, and an archive or a budget removal can
    // commit inside that window. This is a *fresh* read, not a reuse of step 1's: M3's
    // plan is explicit that invalidating a queue entry alone is not sufficient.
    const surviving = await this.revalidate(userId, outstanding);

    // A dropped category is never coming back for this date, so retire its row now
    // rather than leaving it `pending`. Left pending it would keep the user due, and
    // every remaining tick in the window would spend a subrequest re-dropping it.
    const survivingIds = new Set(surviving.map((s) => s.send.id));
    await this.retire(
      outstanding.filter((c) => !survivingIds.has(c.send.id)),
      'skipped',
    );

    // Step 3 — nothing survived. Send nothing. Never recreate a dropped category from
    // what step 1 cached.
    if (surviving.length === 0) {
      return { status: 'skipped', categoryCount: 0 };
    }

    const connection = await this.connections.findActiveConnection(userId, TELEGRAM);
    if (!connection) {
      // No active connection is the same terminal state as a block: nothing to retry to.
      await this.retire(surviving, 'skipped');
      return { status: 'skipped', categoryCount: 0 };
    }

    // Step 4 — one message, one send, one shared outcome for every row in the bundle.
    const text = renderBundledReminder(
      surviving.map((s) => s.view),
      currencyCode,
    );
    const ids = surviving.map((s) => s.send.id);
    const result = await this.sender.send(connection, { text });
    const now = this.clock.now();

    switch (result.status) {
      case 'sent':
        await this.repository.markSends(ids, 'sent', now);
        return { status: 'sent', categoryCount: surviving.length };

      case 'skipped': {
        // 403 — the user blocked the bot. Stop trying and deactivate the connection;
        // M2's `register` re-activates it if they come back with /start.
        await this.repository.markSends(ids, 'skipped', now);
        await this.connections.deactivateConnection(userId, TELEGRAM);
        return { status: 'skipped', categoryCount: surviving.length };
      }

      case 'retryable': {
        const attempts = await this.repository.incrementAttempts(ids);
        if (attempts >= MAX_SEND_ATTEMPTS) {
          await this.repository.markSends(ids, 'failed', now);
          return { status: 'failed', categoryCount: surviving.length };
        }
        // Left `pending` on purpose — the next tick inside the due window retries. Never
        // sleep inside the invocation; the Workers Free plan has 10ms of CPU.
        return {
          status: 'pending',
          retryable: true,
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
          categoryCount: surviving.length,
        };
      }

      case 'permanent':
        // 400 — a bug in the message we built. Retrying it would fail identically.
        await this.repository.markSends(ids, 'failed', now);
        return { status: 'failed', categoryCount: surviving.length };
    }
  }

  /**
   * M3 calls this after every ledger write commits. **Deliberately a no-op.**
   *
   * `available_today` is derived on every read (`dailyTarget - spentToday`) and never
   * stored — only `daily_target` is persisted, and that is frozen for the date by
   * design. So there is no cached value here to invalidate: the next `availableToday`
   * already sees the new spend. M6's pipeline calls `availableToday` directly after a
   * categorised expense because it needs the figure for the confirmation reply, and
   * that is the single real trigger (closes M6's open question 4 — the two paths were
   * doing one job twice, at two round trips per logged expense).
   *
   * Kept on the contract rather than removed so M3's shipped code does not move in an
   * M5 PR, and so the seam is already there if `available_today` ever becomes a cached
   * column.
   */
  async ledgerChanged(_userId: UserId, _localDate: LocalDate): Promise<void> {
    // Intentionally empty — see above.
  }

  /**
   * M3 calls this when a category is archived. A removed category gets no further
   * scheduled reminders: clear the flag so it stops being selected, and retire today's
   * pending row so an in-flight bundle cannot pick it up. Dispatch revalidates
   * independently regardless — this is belt, that is braces.
   */
  async categoryArchived(userId: UserId, categoryId: Id): Promise<void> {
    await this.repository.setReminderEnabled(userId, categoryId, false);

    const { today } = await this.context(userId);
    const send = await this.repository.findSend(userId, categoryId, today);
    if (send?.deliveryStatus === 'pending') {
      await this.repository.markSends([send.id], 'skipped', this.clock.now());
    }
  }

  /**
   * M4 calls this after `setCap` has moved the standing budget and the current cycle's
   * snapshot. Re-prices today's persisted target from the new cap so the change is
   * spendable today — regardless of delivery state, and without a second send: a row
   * the 07:00 bundle already delivered keeps `sent` and its `sent_at`, and only the
   * number moves. `/today` then shows the new figure; the morning message is history.
   *
   * No row for today means nothing to rewrite — the day's first read computes from the
   * new snapshot anyway. No active budget means the category was uncapped in the same
   * breath, and its row is left for M5's usual eligibility revalidation to retire.
   */
  async capChanged(userId: UserId, categoryId: Id): Promise<void> {
    const { today } = await this.context(userId);
    const send = await this.repository.findSend(userId, categoryId, today);
    if (!send) return;

    const budgets = await this.budgets.activeBudgets(userId);
    const budget = budgets.find((b) => b.categoryId === categoryId);
    if (!budget) return;

    // `ensurePeriod` is a read here: the row's `budget_period_id` proves the period
    // already exists, and `setCap` has just rewritten its cap. Going through M4 rather
    // than reading the snapshot ourselves keeps the table M4's (master plan §2, rule 2).
    const period = await this.budgets.ensurePeriod(userId, budget.id, today);
    const dailyTarget = await this.targetFor(userId, period, today);
    await this.repository.updateTarget(userId, categoryId, today, dailyTarget);
  }

  // ---------------------------------------------------------------- internals

  private async context(
    userId: UserId,
  ): Promise<{ today: LocalDate; timezone: string; currencyCode: string }> {
    const settings = await this.settingsOf(userId);
    return {
      today: localDateAt(this.clock.now(), settings.timezone),
      timezone: settings.timezone,
      currencyCode: settings.currencyCode,
    };
  }

  /** Non-archived categories that have an active budget — the only ones with a figure. */
  private async budgetedCategories(userId: UserId): Promise<readonly ReminderCategory[]> {
    const [categories, budgets] = await Promise.all([
      this.repository.listCategories(userId),
      this.budgets.activeBudgets(userId),
    ]);
    const budgeted = new Set(budgets.map((b) => b.categoryId).filter((id): id is Id => id !== null));
    return categories.filter((c) => !c.isArchived && budgeted.has(c.categoryId));
  }

  private async computeAll(
    userId: UserId,
    categories: readonly ReminderCategory[],
    today: LocalDate,
  ): Promise<readonly ComputedTarget[]> {
    if (categories.length === 0) return [];
    const budgets = await this.budgets.activeBudgets(userId);
    const out: ComputedTarget[] = [];
    // Sequential on purpose: each iteration is several subrequests, and the Workers Free
    // plan caps an invocation at 50. A user has at most 5 reminder categories.
    for (const category of categories) {
      const budget = budgets.find((b) => b.categoryId === category.categoryId);
      if (!budget) continue;
      out.push(await this.computeFor(userId, category, budget.id, today));
    }
    return out;
  }

  private async computeFor(
    userId: UserId,
    category: ReminderCategory,
    budgetId: Id,
    today: LocalDate,
  ): Promise<ComputedTarget> {
    const period = await this.budgets.ensurePeriod(userId, budgetId, today);
    const daysLeft = daysInclusive(today, period.periodEnd);

    let send = await this.repository.findSend(userId, category.categoryId, today);
    if (!send) {
      const dailyTarget = await this.targetFor(userId, period, today);
      // A category with no reminder is `not_applicable`: its row exists so `/today` has a
      // stable figure, but it will never be delivered and must not enter the retry index.
      send = await this.repository.insertSend({
        userId,
        categoryId: category.categoryId,
        localDate: today,
        dailyTargetMinorUnits: dailyTarget,
        budgetPeriodId: period.id,
        deliveryStatus: category.reminderEnabled ? 'pending' : 'not_applicable',
      });
    }

    // `send.dailyTargetMinorUnits`, never the value computed just above: on a conflict
    // the row that won the race is authoritative, so concurrent first-reads agree.
    const spentToday = await this.ledger.spentOn(userId, today, category.categoryId);
    return {
      send,
      view: {
        categoryId: category.categoryId,
        categoryName: category.name,
        dailyTarget: send.dailyTargetMinorUnits,
        spentToday,
        availableToday: send.dailyTargetMinorUnits - spentToday,
        periodEnd: period.periodEnd,
        daysLeft,
      },
    };
  }

  /**
   * The formula, fed from the period's frozen cap and spend **to the end of yesterday**
   * — today's own spend must not shrink today's target, otherwise a morning coffee
   * would quietly lower the number it is measured against. The one place the inputs
   * are assembled, so a first-of-the-day compute and a `capChanged` re-price cannot
   * disagree about what goes in.
   */
  private async targetFor(userId: UserId, period: BudgetPeriod, today: LocalDate): Promise<MinorUnits> {
    const spentBefore = await this.ledger.spendInPeriod(userId, period.id, addLocalDays(today, -1));
    return computeDailyTarget({
      remaining: period.capMinorUnits - spentBefore,
      daysLeft: daysInclusive(today, period.periodEnd),
    });
  }

  /** Drop any category that stopped being eligible while step 1 was running. */
  private async revalidate(
    userId: UserId,
    computed: readonly ComputedTarget[],
  ): Promise<readonly ComputedTarget[]> {
    if (computed.length === 0) return [];
    const stillEligible = new Set(
      (await this.budgetedCategories(userId))
        .filter((c) => c.reminderEnabled)
        .map((c) => c.categoryId),
    );
    return computed.filter((c) => stillEligible.has(c.view.categoryId));
  }

  /** Retire rows this invocation opened, leaving already-terminal ones alone. */
  private async retire(
    computed: readonly ComputedTarget[],
    status: 'skipped' | 'failed',
  ): Promise<void> {
    const ids = computed.filter((c) => c.send.deliveryStatus === 'pending').map((c) => c.send.id);
    if (ids.length > 0) await this.repository.markSends(ids, status, this.clock.now());
  }
}
