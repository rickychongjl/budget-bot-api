/**
 * M7 — Telegram Gateway (Phase 4, the integrator). The module's public surface.
 *
 * The only module that knows Telegram exists. It implements `MessageSender`
 * (`core/shared/messaging.ts`) against the Telegram Bot API and owns
 * `infrastructure/database/schema/platform.ts` (`inbound_update`, `pending_prompt`).
 *
 * Landed in stage 4A (outbound delivery + composition root):
 *   telegram-api-client.ts      TelegramApiClient — the only caller of the Bot API
 *   telegram-message-sender.ts  TelegramMessageSender — the `MessageSender` M5 calls
 *
 * Landed in stage 4B (the inbound spine):
 *   webhook-handler.ts   secret-token check -> dedupe -> 200 -> `ctx.waitUntil`
 *   update-parser.ts     raw Telegram JSON -> `TelegramEvent`, private chats only
 *   dispatcher.ts        M11's routing order; every branch ends in one reply
 *   command-router.ts    the catalogue that also feeds `/help` and `setMyCommands`
 *   commands/            `/help`, `/cancel`, `/export`, and the billing quartet
 *   render.ts            plain-text rendering, refusal copy, keyboards, pagination
 *   gateway-repository.ts  the port; `DrizzleGatewayRepository` implements it
 *
 * Still to land: the nine product commands (4C) and the free-text path into M6 (4D).
 * The dispatcher's `freeText` dependency is the seam 4D fills; routing does not change.
 *
 * Wiring (composition root, `src/index.ts`):
 *   const telegramApi = new TelegramApiClient({ token: env.TELEGRAM_BOT_TOKEN, logger });
 *   const sender = new TelegramMessageSender(telegramApi);
 *   const webhook = new TelegramWebhookHandler({ dispatcher, gateway, clock, logger, webhookSecret });
 */
export { TelegramApiClient } from './telegram-api-client';
export type { TelegramApiClientOptions, TelegramCallOutcome } from './telegram-api-client';

export { TelegramMessageSender, classify } from './telegram-message-sender';

export { TelegramWebhookHandler } from './webhook-handler';
export type { BackgroundWork, WebhookHandlerDeps } from './webhook-handler';

export { TelegramDispatcher } from './dispatcher';
export type {
  CallbackAcknowledger,
  DispatcherDeps,
  FreeTextHandler,
  IdentityCollaborator,
} from './dispatcher';

export { CommandRouter, parseCommand } from './command-router';
export type {
  CommandContext,
  CommandHandler,
  CommandServices,
  ParsedCommand,
} from './command-router';

export { createCatalogue, UNKNOWN_COMMAND } from './commands/catalogue';

export { parseUpdate } from './update-parser';
export type { TelegramEvent, TelegramSender } from './update-parser';

export type {
  GatewayRepository,
  PendingPrompt,
  PendingPromptKind,
  SetPendingPromptInput,
} from './gateway-repository';

export {
  MAX_INLINE_OPTIONS,
  TELEGRAM_MAX_MESSAGE,
  paginate,
  refusalText,
  renderAccountSummary,
  renderOnboardingReply,
  renderRefusal,
} from './render';
