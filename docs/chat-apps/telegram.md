# Telegram runbook: connect a Telegram bot to your relay

This takes a relay you already run ([SELF-HOST.md](../SELF-HOST.md) §1–5) and makes it a Telegram bot. When you are
done, people start a chat with your bot, bind it to their agent with `/setup`, and drive the agent from Telegram, in
a DM or in a group. LINE and Discord have their own runbooks: [line.md](line.md), [discord.md](discord.md).

Written so a person or a coding agent can follow it top to bottom. Every step says **where** (the BotFather command
or the repo command), **set** (the value), **why** (what breaks without it) and **check** (how you know it worked).
Steps marked **[human]** happen in Telegram with @BotFather and need a person's Telegram account; steps marked
**[script]** run from the repo. An agent doing this should stop at each **[human]** step, ask the person to do it,
and continue with the check.

Throughout, `https://<your relay>` is your relay's public URL (no trailing slash) and `@your_bot` is your bot's
username. The maintainer's deployment, can2cup.com, is a worked example: github.com/ccqqder/can2cup-deploy.

BotFather commands were checked against Telegram's documentation on 2026-09-14 (Bot API 10.3). BotFather also has
a Mini App (`https://t.me/botfather?startapp`) with the same settings behind buttons; either works.

## Prerequisites

- A deployed relay: `curl -s https://<your relay>/` answers `{"ok":true,"service":"can2cup-relay",…}`.
- A clone of this repo with `npm install` and `npm run build` done (`commands` reads `dist/relay/commands.js`), and
  `npx wrangler login` done for the Cloudflare account that owns the relay.
- A Telegram account.
- Your own `/terms` note and privacy page. The relay serves `relay-assets/operator/terms-note.html` inside `/terms`
  and `relay-assets/privacy/index.html` at `/privacy/`. Both are the operator's words: rewrite them to name you and
  say what you keep.
- A directory outside the repo for credentials the scripts read (for example `~/can2cup-env`). Set
  `CAN2CUP_ENV_DIR` to it. The script looks for `.env.telegram` there (the repo root if unset).
- Before step C3, edit `NAME`, `SHORT` and `DESCRIPTION` at the top of `scripts/telegram-app.mjs`: they are the
  maintainer's bot profile and `describe` writes them to yours.

## Part A: the Telegram side [human]

### A1. Create the bot [human]

- **Where:** a chat with [@BotFather](https://t.me/botfather) → `/newbot`.
- **Set:** a display name, then a username that ends in `bot` (5–32 characters, Latin letters, digits, underscores).
  It must not suggest it is Telegram or someone else's bot.
- **Copy:** the token BotFather prints (`123456789:AA…`). It is the bot: never put it in a file in the repo.
- **Why:** the token is how the relay replies, pushes and looks up names; the username builds `t.me/your_bot?start=…`
  deep links.
- **Check:** `https://t.me/your_bot` opens your bot.
- Docs: [Bot features: BotFather](https://core.telegram.org/bots/features).

### A2. Group settings: privacy mode stays on [human]

- **Where:** @BotFather → `/setprivacy` → your bot; `/setjoingroups` → your bot.
- **Set:** privacy mode **Enabled** (the default); joining groups **Enabled** (the default).
- **Why:** with privacy mode on, in a group the bot receives only commands meant for it, messages that mention it and
  replies to its own messages. That is all the console reads, and it keeps the bot out of the rest of the group's
  conversation (Telegram's bot terms restrict collecting more than the service needs). With joining groups off, no
  one can add the bot to a group and `/room` has nowhere to live.
- **Check:** after Part C, `node scripts/telegram-app.mjs show` prints `"can_join_groups": true` and
  `"can_read_all_group_messages": false`.

### A3. Privacy policy link [human]

- **Where:** @BotFather → your bot's settings → the privacy policy entry (in the BotFather Mini App: the bot →
  **Privacy Policy**).
- **Set:** `https://<your relay>/privacy/`
- **Why:** a bot that publishes no policy of its own is bound by Telegram's
  [Standard Privacy Policy for Bots and Mini Apps](https://telegram.org/privacy-tpa); yours, once set, takes
  precedence and is the one that describes what the relay actually keeps.
- **Check:** the bot's profile in Telegram shows the privacy policy link.

## Part B: the relay side [script]

### B1. A webhook secret [script]

- **Run:** `node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"`
- **Set:** keep the output (32 characters of `A-Za-z0-9_-`).
- **Why:** Telegram sends this value in the `X-Telegram-Bot-Api-Secret-Token` header of every update; the relay
  refuses any request without it. Telegram allows 1–256 characters of `A-Za-z0-9_-`; the relay's script requires at
  least 16. The **same** value goes into the wrangler secret (B2) and into `setWebhook` (C1).
- **Check:** the value matches `^[A-Za-z0-9_-]{16,256}$`.

### B2. Secrets, var and deploy [script, values pasted by the human]

- **Run:**

  ```bash
  npx wrangler secret put TELEGRAM_BOT_TOKEN        # paste the BotFather token
  npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # paste the B1 value
  ```

- **Set** in `[vars]` of `wrangler.toml` (the file in this repo carries the maintainer's value: replace it):
  `TELEGRAM_BOT_USERNAME = "your_bot"` (without the `@`).
- **Run:** `npx wrangler deploy`
- **Why:** without the secret the webhook answers 404; without the token the relay hears but cannot answer; without
  the username, links print without a bot to open and the relay recognises itself only by the token's id.
  An agent should let the person paste the values and never echo them.
- **Check:** `curl -s https://<your relay>/` shows `"telegramBot":"your_bot"`, and a request without the header is
  refused as a bad secret, not as a missing bot:

  ```bash
  curl -s -X POST https://<your relay>/telegram/webhook -d '{}'
  # {"error":"bad secret"}                                              → ready
  # {"error":"no Telegram bot on this relay (TELEGRAM_WEBHOOK_SECRET unset)"} → B2 not applied
  ```

## Part C: point Telegram at the relay [script]

Put the values the script reads in `$CAN2CUP_ENV_DIR/.env.telegram`:

```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_WEBHOOK_SECRET=<the B1 value>
TELEGRAM_BOT_USERNAME=your_bot
```

### C1. Webhook [script]

- **Run:** `node scripts/telegram-app.mjs app --relay https://<your relay>` (add `--drop-pending` to discard updates
  Telegram queued before the webhook worked).
- **Set (by the script, `setWebhook`):** URL `https://<your relay>/telegram/webhook`, `secret_token` from
  `.env.telegram`, `allowed_updates` `message`, `callback_query`, `my_chat_member`, `max_connections` 20.
- **Why:** this is the only path from Telegram to the relay. `allowed_updates` keeps everything else from being
  delivered at all; `my_chat_member` is how the relay learns it was added to or removed from a group, or blocked.
- **Check:** it prints `setWebhook → true` and the `getWebhookInfo` result with your URL and no `last_error_message`.
- Docs: [setWebhook](https://core.telegram.org/bots/api#setwebhook).

### C2. Command menu [script]

- **Run:** `npm run build && node scripts/telegram-app.mjs commands`
- **Set:** the command menu from `src/relay/commands.ts`, in English by default and in Chinese for people whose
  Telegram is set to Chinese.
- **Why:** the `/` menu is how people discover commands. Rerun after any change to `commands.ts`.
- **Check:** it prints `registered N commands: /…`; typing `/` in the bot's chat shows them.

### C3. Profile text [script]

- **Run:** `node scripts/telegram-app.mjs describe --relay https://<your relay>` (after editing the text, see
  Prerequisites).
- **Set:** name, short description (≤ 120 characters, the profile page) and description (≤ 512 characters, the empty
  chat before `/start`); the description links `<your relay>/guide`.
- **Why:** it is what a person sees before pressing Start. You can instead set these by hand with BotFather
  (`/setname`, `/setabouttext`, `/setdescription`) and skip this step.
- **Check:** it prints the lengths it set; open the bot in a fresh chat to see the description.

## Part D: verify end to end

1. **Config check [script]:** `node scripts/telegram-app.mjs show` prints `getMe` (`can_join_groups: true`,
   `can_read_all_group_messages: false`), the webhook (your URL, `pending_update_count` 0, no `last_error_message`),
   the profile text and the command list.
2. **DM [human]:** open `https://t.me/your_bot`, press **Start**, send `/help`. The console answers.
3. **Bind [human + agent]:** `/setup` and follow it on a computer with the can2cup client; `/status` then shows the
   agent.
4. **Group [human]:** add the bot to a test group and send `/status` (or `/status@your_bot`).
5. **Production path without a phone [script]:** forge an update as a real person; the relay answers in the real chat:

   ```bash
   node scripts/telegram-app.mjs say "/status" --relay https://<your relay> --user <your numeric Telegram id>
   node scripts/telegram-app.mjs tap "<callback data>" --relay https://<your relay> --user <id> [--chat <group id>]
   ```

   `--user` defaults to `TELEGRAM_TEST_USER_ID` in `.env.telegram`. The script refuses to forge `/unbind`,
   `/forgetme`, `/erase` or `/link` without `--force`, because those change the real person's data.
6. **Without Telegram (development) [script]:** against a local relay:

   ```bash
   cp .dev.vars.example .dev.vars   # fill RELAY_SIGNING_KEY as the file says
   npm run dev:relay                # terminal 1
   RELAY=http://127.0.0.1:8787 BRIDGE_KEY=devbridge npm run check:telegram   # terminal 2
   ```

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `getWebhookInfo` shows `last_error_message` `Wrong response from the webhook: 401 Unauthorized`, `pending_update_count` grows | the secret in `.env.telegram` (sent by `setWebhook`) differs from the wrangler secret | put the same value in both, `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, rerun `app` |
| `last_error_message` mentions 404 | `TELEGRAM_WEBHOOK_SECRET` not set on the deployed relay, or a wrong `--relay` URL | B2, then `app` again |
| `app` fails: `TELEGRAM_WEBHOOK_SECRET required (16–256 chars …)` | missing or too short in `.env.telegram` | B1 |
| `setWebhook` refuses the URL | not `https`, or a port Telegram does not allow (443, 80, 88, 8443) | use the relay's public HTTPS URL |
| The bot ignores ordinary messages in a group | privacy mode, by design | use a `/command`, mention `@your_bot`, or reply to the bot |
| `/pause@other_bot` does nothing | a command addressed to another bot is ignored | use `@your_bot` or no suffix |
| The bot cannot be added to groups | joining groups disabled | `/setjoingroups` → Enable |
| The bot hears but never answers; `wrangler tail` shows 401 from api.telegram.org | the token was revoked in BotFather or never set | copy the current token to `wrangler secret put TELEGRAM_BOT_TOKEN` and `.env.telegram` |
| Pushes to one person stop with 403 | that person blocked the bot; the relay treats it as withdrawn consent | nothing to fix; they unblock and `/start` |
| `/setup` links open no bot | `TELEGRAM_BOT_USERNAME` wrong or still the maintainer's | B2 |
| Commands missing from the `/` menu | `commands` not run, or not built | C2 |
| The token leaked | anyone holding it is the bot | BotFather → revoke / generate a new token, then B2 and `.env.telegram` |

Refused sends in production: `npx wrangler tail --format pretty --status error`.

## What the relay needs

| name | kind | where from | used for |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | secret (`wrangler secret put`) | @BotFather `/newbot` | replies, pushes, name lookups; the bot's own id |
| `TELEGRAM_WEBHOOK_SECRET` | secret | B1 (you generate it) | verifying every update; the same value in `setWebhook` |
| `TELEGRAM_BOT_USERNAME` | var (`wrangler.toml`) | your bot's username, no `@` | `t.me` deep links; recognising itself without a token in dev |
| `PUSH_USER_BUDGET` | var, shared | your choice | per-person monthly push ceiling (Telegram has no platform allowance; `PUSH_BUDGET` does not apply) |

## Platform rules to know

Read Telegram's current [Bot Platform Developer Terms](https://telegram.org/tos/bot-developers) before opening the
bot to others. The points this design depends on: the bot messages only people who started it; data collected is
limited to what the service needs and never used to train models; rate limits (about one message per second per
chat, 20 per minute per group) are respected through `retry_after`, never worked around.
