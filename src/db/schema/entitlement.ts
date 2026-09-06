/**
 * M8 — Entitlements & Limits owns this file.
 *
 * Tables: `entitlement`, `usage_counter`.
 *
 * Conventions: see `identity.ts` header. Specifics from M8's plan:
 *   - `entitlement`: `tier in ('free','premium')`, `source in ('telegram_stars','manual')`,
 *     `status in ('active','expired','cancelled','refunded')`;
 *     `create unique index entitlement_one_active on entitlement (user_id) where status = 'active'`.
 *   - `usage_counter`: keyed by `(user_id, message_id)` where `message_id` is M7's stable
 *     logical message identity — a Telegram redelivery is the same message, admitted once.
 *     Index `(user_id, admitted_at)` for the rolling 120-min window; `(user_id, local_date)`
 *     for the Free daily cap. Not the original entries/llm_calls metrics shape.
 *   - Billing (Stars checkout / renewal / refund) is Phase 2 — not this pass.
 */
export {};
