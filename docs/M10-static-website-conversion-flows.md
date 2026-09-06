# M10 — Static Website & Conversion Flows

**Phase:** independent track, run any time — separate repo, separate deployable, no runtime dependency on the Worker
**Notion status:** Partially done. Live at `budge-bot-site.pages.dev`. Information architecture and conversion flows are built and deployed; two follow-ups remain (below).
**One-line scope:** The public marketing website that explains the bot and directs visitors into the Telegram journey. Static only — no product, no dashboard, no payment processing.

---

## Depends on
Nothing from `budge-bot-api` at build time — it's a fully separate Astro/Cloudflare Pages repo. At runtime it depends only on the bot's `t.me` deep link existing.

## Depended on by
Nothing in the backend. This is the one module whose agent can run completely independently of every other phase.

---

## Owns
- The entire public site: landing, pricing, FAQ, privacy, about, terms, support, 404
- Telegram deep-link CTAs and attribution start-parameters
- The "other channel interest" capture (measurement only, no product behind it)

## Does not own
- Anything behind the Telegram bot — that's the whole rest of the system.
- Payment processing of any kind — Telegram Stars checkout happens inside Telegram, never on the website.

---

## Outstanding follow-ups (do these — this is most of what's left)
1. **Add the real Telegram bot link.** Replace the placeholder with the actual `t.me/<bot_username>` link, once M1/M7 have a deployed bot username to point to.
2. **Wire the support link to actually open Telegram and run `/support`** (or whatever M11 finalizes as the support-reachable command — currently `/paysupport` and general support are separate in M11's catalogue; confirm which one the site should deep-link to), rather than just linking to the bot's chat.

## Non-goals (already correctly out of scope on the live site — don't add these)
- No customer budgeting dashboard, expense entry, or budget management on the website.
- No full account-registration system — identity is the Telegram account.
- No payment handling of any kind on the website, and no Telegram Premium checkout through Stripe or any external processor. Telegram's own rules require Stars checkout to happen inside the bot for digital goods sold inside it — routing a Telegram user to an external checkout is a compliance risk, not a shortcut.

## Page map (already built)
| Route | Job |
|---|---|
| `/` | Landing — problem, daily-allowance solution, how it works, trust, Telegram CTA |
| `/pricing` | Free vs. Telegram Premium, Stars checkout path stated clearly |
| `/faq` | Product, data, limits, channels, pricing, cancellation, support |
| `/privacy` | What's collected, why, providers, retention, deletion, contact |
| `/about` | Product purpose, founder/company context |
| `/terms` | Service, acceptable use, billing, disclaimers, termination |
| `/support` | Contact details + Stars payment/cancellation help |
| `/404` | Back to landing/bot CTAs |

## Channel entry flows (already built, verify against follow-up #1)
- Telegram CTA opens a `t.me` deep link with an attribution start-parameter (`?start=website_landing`, `?start=website_pricing`) — no personal data in it.
- A single low-prominence "other channel" CTA captures an email/click only. Wording must stay honest — "Not on Telegram? Tell us what you use" is fine; "coming soon" is not, since nothing's been committed to. It must never sit beside a price or imply a product exists.

## Pricing-page rules (already built)
- Free: A$0. Telegram Premium: exact Stars amount + a clearly labelled *approximate* A$ reference — **do not publish a final A$ approximation until live AU purchase costs are checked** (this is the same Stars-price deferral M8 is waiting on; the site shouldn't get ahead of it).
- Keep prices/limits in one shared site config so landing/pricing/FAQ/metadata can't drift from each other.

## Privacy/security requirements (already built, keep enforcing on future edits)
- No bot tokens, webhook secrets, or backend credentials in static-site code, ever.
- No Telegram IDs, expense descriptions, or personal data in analytics URLs; prefer aggregate event names (`telegram_cta_clicked`, `other_channel_interest`, `pricing_viewed`).
- Keep the published privacy page's wording matched to what the system *actually* does — this is a standing obligation every time the backend's data handling changes, not a one-time write.

---

## Task checklist (remaining work)
1. Replace the placeholder Telegram link with the real `t.me/<bot_username>` link once available.
2. Make the support link on the site open Telegram directly into the intended support command, not just the bot's chat.
3. Re-check: no Stars A$ approximation is published beyond "approximate, subject to change" until M8's pricing decision lands.
4. Spot-check the privacy page against what M9's rules actually guarantee (Sydney-region data, no message text retained, etc.) — it should already be consistent, but re-verify after any backend change.

## Tests to write
- All internal links resolve; the Telegram CTA reaches the correct bot with the correct start-parameter.
- No Telegram Premium CTA points anywhere but Telegram's own checkout.
- The other-channel CTA text can't be read as promising availability (a copy review, not just a functional test).
- Pricing is consistent across `/`, `/pricing`, and `/faq`.
- Analytics events carry no personal or financial information.

## Related
- Notion: [M10 — Static Website & Conversion Flows](https://app.notion.com/p/3ccef5e61bdd819d97a8f14f07c76065)
- No dependency on any other module's build order.
