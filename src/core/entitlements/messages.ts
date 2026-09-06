import type { Tier } from '../ports/common';
import type { CapacityCounts } from './entitlement-service';

/**
 * User-facing refusal text — the exact recovery messaging from
 * `docs/M8-entitlements-limits.md` ("Implementation defaults"). M7 renders these
 * verbatim; keep them in one place so the wording can't drift between call sites.
 */

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function windowLabel(windowMinutes: number): string {
  return windowMinutes % 60 === 0 ? plural(windowMinutes / 60, 'hour') : plural(windowMinutes, 'minute');
}

function tierLabel(tier: Tier): string {
  return tier === 'free' ? 'Free' : 'Premium';
}

/** "You've reached 20 messages in 2 hours. Try again in {minutes} minutes." */
export function fairUseRefusal(maxMessages: number, windowMinutes: number, minutes: number): string {
  return `You've reached ${maxMessages} messages in ${windowLabel(windowMinutes)}. Try again in ${plural(minutes, 'minute')}.`;
}

/** "You've used your 5 messages today. Your limit resets at {local reset time}." */
export function dailyRefusal(dailyLimit: number, resetLabel: string): string {
  return `You've used your ${dailyLimit} messages today. Your limit resets at ${resetLabel}.`;
}

/**
 * Both exhausted: lead with whichever clears later and explain the other
 * (M8: "return the later eligibility time and explain both").
 */
export function combinedRefusal(args: {
  later: 'daily' | 'fairUse';
  dailyLimit: number;
  resetLabel: string;
  maxMessages: number;
  windowMinutes: number;
  minutes: number;
}): string {
  const daily = dailyRefusal(args.dailyLimit, args.resetLabel);
  const fair = fairUseRefusal(args.maxMessages, args.windowMinutes, args.minutes);
  return args.later === 'daily'
    ? `${daily} You've also reached ${args.maxMessages} messages in ${windowLabel(args.windowMinutes)}, so the daily reset is the earliest you can send again.`
    : `${fair} You've also used your ${args.dailyLimit} messages today, which resets earlier, at ${args.resetLabel}.`;
}

export function categoryLimitRefusal(tier: Tier, limit: number, premiumLimit: number): string {
  const base = `You've reached the ${tierLabel(tier)} limit of ${plural(limit, 'category', 'categories')}. Archive one you're not using first`;
  return tier === 'free' ? `${base}, or upgrade to Premium for up to ${premiumLimit}.` : `${base}.`;
}

export function reminderLimitRefusal(tier: Tier, limit: number, premiumLimit: number): string {
  const base = `You can have reminders on ${plural(limit, 'category', 'categories')} on ${tierLabel(tier)}. Turn a reminder off first`;
  return tier === 'free' ? `${base}, or upgrade to Premium for up to ${premiumLimit}.` : `${base}.`;
}

/** What must be removed before a downgrade can complete. Empty when nothing must. */
export function downgradeCleanup(
  current: CapacityCounts,
  limits: CapacityCounts,
  mustRemove: CapacityCounts,
): string {
  const steps: string[] = [];
  if (mustRemove.categories > 0) {
    steps.push(
      `archive ${plural(mustRemove.categories, 'category', 'categories')} (you have ${current.categories}, Free allows ${limits.categories})`,
    );
  }
  if (mustRemove.reminderCategories > 0) {
    steps.push(
      `turn off reminders on ${plural(mustRemove.reminderCategories, 'category', 'categories')} (you have ${current.reminderCategories} with reminders, Free allows ${limits.reminderCategories})`,
    );
  }
  return steps.length === 0 ? '' : `Before switching to Free, ${steps.join(' and ')}.`;
}

export const ALREADY_FREE = "You're already on the Free plan — there's nothing to downgrade.";
