/**
 * Persisted progress for the resumable `/start` flow.
 *
 * This belongs to M2's core model. Database schemas and repository adapters may use
 * these values, but core code must never import them from the Drizzle schema.
 */
export const ONBOARDING_STEPS = [
  'timezone',
  'currency',
  'anchor_date',
  'categories',
  'reminders',
  'done',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
