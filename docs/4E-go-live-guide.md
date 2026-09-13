# Stage 4E — Go-Live Setup Guide

Companion to `docs/M7-phase-4-plan.md`'s "Stage 4E" section and master plan §5.7.
This is the click-by-click version of that checklist — the plan doc says *what* and
*why*, this says *where to click*.

**Reminder before you start:** master plan §5.7 confirms a single environment.
Production *is* the only environment. There's no staging bot to rehearse against —
the checks in steps 14–15 are the only smoke test this pass gets.

**Never paste a real secret value into a chat with me or anyone else.** Everywhere
below that asks for a token/key/connection string, type or paste it straight into
your own terminal or the provider's own web form.

---

## Accounts checklist

- [ ] Telegram account (to talk to @BotFather)
- [X] Neon account (neon.tech)
- [ ] Cloudflare account (dash.cloudflare.com)
- [X] OpenAI account with billing enabled (platform.openai.com)

---

## Step 1 — Create the Telegram bot

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`, follow the prompts (display name, then a unique `...bot` username).
3. BotFather replies with a token that looks like `123456789:AA...`. **Save it** —
   you'll paste it into Wrangler in Step 9, nowhere else.

This is the only bot token you will ever need for this project — no separate test bot.

---

## Step 2 — Create the Neon database

1. Sign up / log in at neon.tech, create a new project. Pick the **Sydney**
   (`ap-southeast-2`) region if offered, to match the docs' assumption.
2. On the project's **Connection Details** panel, copy the **direct** (non-pooled)
   connection string — the one *without* `-pooler` in the hostname. Use the direct
   one because Cloudflare Hyperdrive (Step 7) does its own pooling in front of it;
   stacking two poolers is the thing to avoid.
3. Save that connection string — you'll use it twice: once to create the Hyperdrive
   binding (Step 7), once as the `DATABASE_URL` Wrangler secret (Step 9).

---

## Step 3 — Create the OpenAI API key

1. Log in at platform.openai.com → **API keys** → **Create new secret key**.
2. Confirm billing is enabled on the account (Settings → Billing) — M6's parser makes
   real, paid calls once live.
3. Save the key (`sk-...`). OpenAI only shows it once.

---

## Step 4 — Set up Cloudflare and find your Workers subdomain

1. Sign up / log in at dash.cloudflare.com.
2. Go to **Workers & Pages**. If this is a new account, Cloudflare will ask you to
   pick a `*.workers.dev` subdomain (e.g. `ricky-dev`) — this becomes part of your
   Worker's public URL: `https://budge-bot-api.<your-subdomain>.workers.dev`.
3. Note your **Account ID** too (right-hand sidebar of the Workers & Pages overview
   page) — needed later only if you wire up GitHub Actions auto-deploy (Step 16).

---

## Step 5 — Generate your own two secrets

`TELEGRAM_WEBHOOK_SECRET` and `INTERNAL_DISPATCH_SECRET` aren't issued by any
provider — you invent them. Any long random string works. In PowerShell:

```powershell
# Run this twice, once for each secret, and save the two outputs separately.
-join ((48..57)+(97..122)|Get-Random -Count 40|%{[char]$_})
```

---

## Step 6 — Install and log in with Wrangler

From the repo root:

```powershell
npx wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account. (The repo
already has `wrangler` as a devDependency, so no separate install is needed.)

---

## Step 7 — Create the Hyperdrive binding

```powershell
npx wrangler hyperdrive create budge-bot-prod --connection-string "<your Neon direct connection string from Step 2>"
```

This prints an `id`. Open `wrangler.toml` and paste it in place of
`REPLACE_WITH_HYPERDRIVE_ID`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<paste the real id here>"
```

---

## Step 8 — Point `WORKER_BASE_URL` at your real subdomain

Still in `wrangler.toml`, replace the placeholder with your actual subdomain from
Step 4:

```toml
[vars]
WORKER_BASE_URL = "https://budge-bot-api.<your-subdomain>.workers.dev"
```

This matters before the first cron tick: the scheduler dispatches to this exact URL.

---

## Step 9 — Set the five Wrangler secrets

Run each of these from the repo root; Wrangler prompts you to paste the value (not
echoed to the terminal, not written to shell history):

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put INTERNAL_DISPATCH_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put DATABASE_URL
```

Use the Neon direct connection string from Step 2 for `DATABASE_URL`, the BotFather
token from Step 1 for `TELEGRAM_BOT_TOKEN`, the OpenAI key from Step 3, and your two
invented values from Step 5 for the other two.

(Also copy `.dev.vars.example` → `.dev.vars` with the same five values, if you want
`npm run dev` to work locally against the same accounts. `.dev.vars` is gitignored.)

---

## Step 10 — Run the production migrations

Migrations are forward-only and must run before the first deploy. In PowerShell,
set `DATABASE_URL` for just this command:

```powershell
$env:DATABASE_URL = "<your Neon direct connection string>"
npm run db:migrate
$env:DATABASE_URL = $null
```

This applies every committed migration under
`src/infrastructure/database/migrations/` (0000 through the current one) to your new
Neon branch.

---

## Step 11 — Deploy the Worker

```powershell
npm run deploy
```

This runs `wrangler deploy`. Confirm it reports success and shows your Worker's URL —
it should match what you put in `WORKER_BASE_URL` (Step 8).

---

## Step 12 — Register commands and set the webhook

This calls the endpoint built alongside this guide
(`POST /internal/register-commands` — see `docs/build-log.md`, "M7 stage 4E"): it
registers Telegram's `/` command menu from the code's own command catalogue and
points Telegram's webhook at your deployment, in one call.

```powershell
curl -X POST "https://budge-bot-api.<your-subdomain>.workers.dev/internal/register-commands" `
  -H "X-Internal-Dispatch-Secret: <your INTERNAL_DISPATCH_SECRET from Step 5>"
```

Expect `{"ok":true,"commandsRegistered":N}`. A `401` means the header value doesn't
match the secret you set in Step 9. A `502` means Telegram rejected one of the two
calls — the response body names which (`setMyCommands` / `setWebhook`) and why.

Rerun this any time the command catalogue changes — it's idempotent.

---

## Step 13 — Say hello

In Telegram, open a chat with your bot (search its username from Step 1) and send
`/start`. You should get the first onboarding prompt within a couple of seconds. Walk
through onboarding once, end to end, on your own account.

---

## Step 14 — Prove the cron works before trusting it

The scheduler fires every 15 minutes but only acts on users who are actually due —
don't wait for that. Test it directly against your own account:

1. Find your own `userId`: open Neon's **SQL Editor** for your project and run
   `select id from app_user order by created_at desc limit 1;` (assuming you're the
   only user so far).
2. Call the send-allowance route directly:

```powershell
curl -X POST "https://budge-bot-api.<your-subdomain>.workers.dev/internal/send-allowance" `
  -H "X-Internal-Dispatch-Secret: <your INTERNAL_DISPATCH_SECRET>" `
  -H "Content-Type: application/json" `
  -d '{"userId":"<your userId from step 1>"}'
```

3. Watch your own Telegram chat for the message. This is M5's own open question #1 —
   first real delivery is against production, with no staging to rehearse on first.

---

## Step 15 (optional, do it soon) — Wire up CI/CD

Both GitHub Actions workflows already exist and currently skip cleanly. Turning them
on:

**Per-PR integration tests** (`ci.yml`) — repo **Settings → Secrets and variables →
Actions**:
- Variable `NEON_PROJECT_ID` = your Neon project's id (Neon dashboard → Settings).
- Secret `NEON_API_KEY` = a Neon API key (Neon dashboard → Account → API Keys).

**Auto-deploy on merge to `main`** (`deploy.yml`) — same settings page:
- Variable `DEPLOY_ENABLED` = `true`.
- Secret `CLOUDFLARE_API_TOKEN` — create one at Cloudflare dashboard → **My
  Profile → API Tokens** → "Edit Cloudflare Workers" template.
- Secret `CLOUDFLARE_ACCOUNT_ID` — from Step 4.
- Secret `DATABASE_URL` — same Neon direct connection string as Step 2/9 (used to run
  migrations before each deploy).

Do this whenever you're ready to stop deploying by hand; it's independent of the
steps above.

---

## Step 16 — Close the loop in the docs

Once everything above is confirmed working:

1. Update `docs/M11-telegram-commands-contracts.md`'s command catalogue to match
   what `/internal/register-commands` actually registered.
2. Append a short entry to `docs/build-log.md` noting the go-live date and that
   stages 4E's manual checklist passed (mirrors the "Verification" sections already
   in that file).

---

## Quick reference — what goes where

| Value | Where it lives |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_DISPATCH_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL` | `wrangler secret put` (production) **and** local `.dev.vars` (dev) — never in a committed file |
| Hyperdrive id, `WORKER_BASE_URL`, cron schedule | `wrangler.toml` — committed, not secret |
| `NEON_PROJECT_ID`, `NEON_API_KEY` | GitHub repo variable / secret — gates CI's per-PR integration tests |
| `DEPLOY_ENABLED`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL` | GitHub repo variable / secrets — gates auto-deploy on merge to `main` |
