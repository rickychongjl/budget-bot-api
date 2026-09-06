/**
 * Barrel export for the split schema — imported by `drizzle.config.ts` and by every
 * repository. Split per-module (M1 §2/§4, master plan §4) so Phase 1/2 agents each
 * touch only their own file plus this one line, instead of fighting over one
 * `schema.ts`. This is the single highest-leverage structural decision in M1.
 *
 * Table ownership:
 *   identity.ts       M2  app_user, channel_connection
 *   category.ts       M3  category
 *   budget.ts         M4  budget, budget_period
 *   transaction.ts    M3  transaction
 *   allowance.ts      M5  daily_allowance_send
 *   entitlement.ts    M8  entitlement, usage_counter
 *   observability.ts  M9  parse_event               (built in M6's PR)
 *   platform.ts       M7  inbound_update
 *
 * M6 additionally needs `merchant_category_mapping`; it is not in M1's file list, so
 * the M6 agent adds `./merchant` here alongside its `parsing/` work. See build-log.
 */
export * from './identity';
export * from './category';
export * from './budget';
export * from './transaction';
export * from './allowance';
export * from './entitlement';
export * from './observability';
export * from './platform';
