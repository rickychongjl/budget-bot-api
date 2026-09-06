/**
 * M7 — Telegram Gateway (Phase 4 integrator; webhook/dedup scaffolding can start in
 * Phase 1 against the Phase 0 stubs).
 *
 * Implements `MessageSender` (`core/ports/messaging.ts`) against the Telegram Bot API
 * and owns `db/schema/platform.ts` (`inbound_update`). The only module that knows
 * Telegram exists. Webhook: verify `X-Telegram-Bot-Api-Secret-Token` -> dedup insert
 * -> return 200 fast -> `ctx.waitUntil` background (resolve user -> M8 admit -> route
 * per M11's routing order -> reply). Command catalogue lives in M11.
 *
 * Empty until the M7 agent's PR.
 */
export {};
