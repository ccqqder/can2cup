# LINE runbook: connect a LINE Official Account to your relay

This takes a relay you already run ([SELF-HOST.md](../SELF-HOST.md) §1–5) and makes it a LINE bot. When you are done,
people add your account as a friend, bind it to their agent with `/setup`, and drive the agent from LINE.
Discord and Telegram have their own runbooks: [discord.md](discord.md), [telegram.md](telegram.md).

Written so a person or a coding agent can follow it top to bottom. Every step says **where** (the console page or the
command), **set** (the value), **why** (what breaks without it) and **check** (how you know it worked). Steps marked
**[human]** happen in a web console and need a person logged in; steps marked **[script]** run from the repo.
An agent doing this should stop at each **[human]** step, ask the person to do it, and continue with the check.

Throughout, `https://<your relay>` is your relay's public URL, with no trailing slash.
The maintainer's deployment, can2cup.com, is a worked example: github.com/ccqqder/can2cup-deploy.

Consoles change their labels. The names below were checked against LINE's documentation on 2026-09-14; where the
screen differs, the linked official page is the authority.

## Prerequisites

- A deployed relay: `curl -s https://<your relay>/` answers `{"ok":true,"service":"can2cup-relay",…}`.
- A clone of this repo with `npm install` done, and `npx wrangler login` done for the Cloudflare account that owns
  the relay.
- A LINE account that can sign in to [LINE Official Account Manager](https://manager.line.biz/) and the
  [LINE Developers Console](https://developers.line.biz/console/).
- Your own `/terms` note and privacy page. The relay serves `relay-assets/operator/terms-note.html` inside `/terms`
  and `relay-assets/privacy/index.html` at `/privacy/`. Both are the operator's words: rewrite them to name you and
  say what you keep. LINE's User Data Policy requires a privacy policy for a bot that handles user data.
- A directory outside the repo for credentials the scripts read (for example `~/can2cup-env`). Set
  `CAN2CUP_ENV_DIR` to it. The scripts look for `.env.line` there (the repo root if unset; `.env*` is gitignored,
  but outside the repo is safer).
- Optional, for rich menus: Python 3 with Pillow (`pip install pillow`).

## Part A: the LINE side [human]

### A1. Create the Official Account and turn on the Messaging API [human]

- **Where:** [LINE Official Account Manager](https://manager.line.biz/): create an account, then open it →
  **Settings** → **Messaging API** → **Enable Messaging API**. Choose (or create) a **provider**.
- **Set:** a provider that belongs to this bot only.
- **Why:** since 2024-09-04 a Messaging API channel can no longer be created directly in the Developers Console; it
  comes from an Official Account. The provider cannot be changed or removed later, and user IDs are per provider: a
  person has a different user ID under a different provider, so moving providers means every binding starts over.
- **Check:** the Developers Console now lists the provider with a Messaging API channel under it.
- Docs: [Get started with the Messaging API](https://developers.line.biz/en/docs/messaging-api/getting-started/).

### A2. Response settings: webhook on, LINE's own replies off [human]

- **Where:** LINE Official Account Manager → your account → **Settings** → **Response settings**.
- **Set:**

  | setting | value | what goes wrong otherwise |
  |---|---|---|
  | Chat | **off** | messages go to a human chat inbox and the bot is not the responder |
  | Greeting message | **off** | new friends get LINE's default greeting on top of the bot's own welcome |
  | Webhook | **on** | nothing reaches the relay |
  | Auto-response messages | **off** | LINE answers every message with a canned text next to the bot's answer |

- **Why:** the relay is the only thing that should answer. The Messaging API reports this combination as
  `chatMode: "bot"`.
- **Check:** after Part C, `node scripts/line-app.mjs show` prints `chatMode":"bot"` and no `!! chatMode` warning.

### A3. Let the account join groups [human]

- **Where:** LINE Official Account Manager → **Settings** → **Account settings** → the option that allows the account
  to join groups and multi-person chats. The Developers Console shows the same setting on the channel's
  **Messaging API** tab as **Allow bot to join group chats** (its edit link leads to Official Account Manager).
- **Set:** **on** (it is off by default).
- **Why:** a group wired to a room (`/room`, `/mirror`) needs the bot in the group; with this off, LINE refuses the
  invitation.
- **Check:** invite the account into a test group; it joins and posts its group hello.
- Docs: [Group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/).

### A4. Copy the channel credentials [human]

- **Where:** [LINE Developers Console](https://developers.line.biz/console/) → your provider → the Messaging API
  channel.
  - **Basic settings** tab: **Channel ID**, **Channel secret**, and **Your user ID** (your own `U…` id under this
    provider).
  - **Messaging API** tab: the bot's **Basic ID** (`@…`), and **Channel access token (long-lived)** → **Issue**.
- **Set:** nothing in the console. Keep the four values for Part B and C.
- **Why:** the channel secret verifies every webhook (`x-line-signature`); the access token sends replies, pushes and
  rich menus; the Basic ID builds the add-friend deep links clients print.
- **Warning:** pressing **Reissue** on the long-lived token invalidates the one the relay uses, at once. If you need
  a token for the scripts, give them the Channel ID + Channel secret instead (they mint a 15-minute stateless token
  that revokes nothing).
- **Check:** you have a Channel ID (digits), a 32-hex-character secret, a long token, and an `@…` Basic ID.
- Docs: [Channel access tokens](https://developers.line.biz/en/docs/basics/channel-access-token/).

## Part B: the relay side [script]

### B1. Secrets [script, value pasted by the human]

- **Run:**

  ```bash
  npx wrangler secret put LINE_CHANNEL_SECRET        # paste the Channel secret
  npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN  # paste the long-lived token
  npx wrangler secret put OPERATOR_LINE_USER_ID      # optional: your own U… id; `can2cup report` lands there
  ```

- **Why:** without the secret every webhook is refused (400); without the token the relay hears but cannot answer.
  Secrets never go in `wrangler.toml` or any file in the repo. An agent should let the person paste the values and
  never echo them into its transcript.
- **Check:** `npx wrangler secret list` names them (values are never shown).

### B2. Vars in `wrangler.toml` [script]

- **Where:** `[vars]` in `wrangler.toml`. The file in this repo carries the maintainer's values: replace them.
- **Set:**

  | var | value | why |
  |---|---|---|
  | `LINE_OA_ID` | your Basic ID, with the `@` | deep links `line.me/R/oaMessage/<id>/?…` that open the chat with `/link CODE` typed |
  | `PUSH_BUDGET` | a little under your plan's monthly allowance (180 for a 200-message plan) | the relay stops pushing before LINE starts refusing |
  | `PUSH_USER_BUDGET` | pushes per person per month (default 60) | one busy room cannot spend everyone's allowance |
  | `LINE_MENU_CONSOLE` / `LINE_MENU_ONBOARD` | delete both lines to use the defaults `can2cup-menu-console` / `can2cup-menu-onboard` | rich menus are found by name prefix (C2) |

- **Run:** `npx wrangler deploy`
- **Check:** `curl -s https://<your relay>/` shows `"lineOa":"@…"` with your id. An unsigned POST is refused:
  `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your relay>/line/webhook -d '{}'` prints `400`.

## Part C: point LINE at the relay

### C1. Webhook URL [script, then human]

- **Run [script]:** put the credentials in `$CAN2CUP_ENV_DIR/.env.line`:

  ```
  LINE_CHANNEL_ID=<Channel ID>
  LINE_CHANNEL_SECRET=<Channel secret>
  ```

  (or `LINE_CHANNEL_ACCESS_TOKEN=<token>`), then

  ```bash
  node scripts/line-app.mjs app --relay https://<your relay>
  ```

  It sets the channel's webhook endpoint to `https://<your relay>/line/webhook` and runs LINE's webhook test.
  Without the script: Developers Console → channel → **Messaging API** tab → **Webhook settings** → **Webhook URL** →
  **Edit** → `https://<your relay>/line/webhook` → **Update** → **Verify** (LINE posts `{"events":[]}`; the relay
  answers 200).
- **Then [human]:** same tab, **Webhook settings**:
  - **Use webhook**: **on**. The API sets the URL but not this switch.
  - **Webhook redelivery**: **on**. LINE's docs place it under Webhook settings, off by default, and LINE may force
    it off if a bot causes too many redeliveries. With it off, an event that hits the relay during a deploy or an
    error is lost instead of retried (the relay drops duplicates by `webhookEventId`, so redelivery is safe).
- **Why:** this is the only path from LINE to the relay.
- **Check:** the test prints success (console: **Success**), and `node scripts/line-app.mjs show` prints
  `webhook: {"endpoint":"https://<your relay>/line/webhook","active":true}`. Redelivery has no read API: look.
- Docs: [Receive messages (webhook)](https://developers.line.biz/en/docs/messaging-api/receiving-messages/),
  [Verify webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/).

### C2. Rich menus [script]

Two menus. **console** is for people bound to an agent; **onboard**, the default, is for everyone else. The relay
links each person to one of them when they follow the account and on their 1:1 messages, finding each menu by
**name prefix** (`LINE_MENU_CONSOLE` / `LINE_MENU_ONBOARD`, defaults `can2cup-menu-console` / `can2cup-menu-onboard`).

- **Run:**

  ```bash
  python tools/richmenu/make_richmenu.py --out ./menus --guide https://<your relay>/guide --privacy https://<your relay>/privacy/ [--font <a .ttf/.otf with CJK glyphs>]
  node scripts/line-app.mjs menus --dir ./menus --dry-run    # prints what it would create and delete
  node scripts/line-app.mjs menus --dir ./menus
  ```

  The generator writes `console.json` + `console.png` and `onboard.json` + `onboard.png`. `menus` installs console
  first (not default), then onboard as the default, then deletes older menus with the same prefixes.
- **Set:** each JSON's `name` must start with the matching prefix; if you renamed the prefixes in B2, use the same.
- **Why the order:** installed the other way round, the default briefly (or permanently, if the run stops halfway)
  is the console menu, and everyone who is not bound sees buttons that do nothing for them. Old menus are deleted
  only after the new ones are in, so no one is left without a menu.
- **Check:** `node scripts/line-app.mjs show` lists exactly two menus, the onboard one marked `← default`, and each
  area's action. On a phone, a non-friend who adds the account sees the onboard menu (the default can take up to a
  minute and a reopened chat to appear).
- Docs: [Rich menus overview](https://developers.line.biz/en/docs/messaging-api/rich-menus-overview/) (a per-user
  menu beats the API default, which beats a default set in Official Account Manager).

## Part D: verify end to end

1. **Read-only config check [script]:** `node scripts/line-app.mjs show`. Expect `chatMode "bot"`, the webhook active
   at your URL, this month's allowance and usage, two menus with onboard as default. It ends with the settings it
   cannot read (auto-response, greeting, join groups, redelivery): confirm those by eye against A2, A3, C1.
2. **On a phone [human]:** add the account (scan the QR in Official Account Manager, or search the Basic ID). Expect
   the bot's welcome with `/setup` and `/help` chips, and no LINE default greeting. Send `/help`: the console answers.
3. **Bind [human + agent]:** send `/setup`, follow it on a computer with the can2cup client. After binding, `/status`
   shows the agent and the menu switches to console.
4. **Group [human]:** invite the account into a group and send `/status` there.
5. **Without a phone (development) [script]:** against a local relay, never production:

   ```bash
   cp .dev.vars.example .dev.vars   # fill RELAY_SIGNING_KEY as the file says
   npm run dev:relay                # terminal 1
   RELAY=http://127.0.0.1:8787 BRIDGE_KEY=devbridge npm run check:line   # terminal 2
   ```

   It posts forged, signed webhooks (dev secret `devsecret`) and reads the answers from `/bridge/debug/pushes`.

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| **Verify** fails, or the relay logs 400 on `/line/webhook` | `LINE_CHANNEL_SECRET` missing, mistyped, or from another channel; or the URL is not `/line/webhook` | `wrangler secret put LINE_CHANNEL_SECRET` again with the Basic settings value; check the URL |
| Nothing reaches the relay, no errors anywhere | **Use webhook** off, or Response settings **Webhook** off | turn both on (A2, C1); `show` must print `"active":true` |
| Every message also gets a canned LINE text | Auto-response messages on, or Chat on | A2 |
| New friends get two welcomes | Greeting message on | A2 |
| The account cannot be invited into a group | joining groups not allowed | A3 |
| The bot hears but never answers; `wrangler tail` shows 401 from api.line.me | the long-lived token was reissued or never set | issue or copy the current token, `wrangler secret put LINE_CHANNEL_ACCESS_TOKEN` |
| Pushes stop mid-month; `/quota` says the allowance is spent | the plan's monthly messages are used up; LINE answers every push with 429 `You have reached your monthly limit.` until the 1st | wait for the 1st or change plan; lower `PUSH_BUDGET` / `PUSH_USER_BUDGET`. Diagnose with `npx wrangler tail --format pretty --status error` (lines `push refused: channel=line status=429 …`) |
| Replies work, pushes do not | replies are free and pushes are metered; see the row above, or the person blocked the account | as above |
| Everyone sees console buttons that do nothing | menus installed in the wrong order, or the console menu is the default | rerun `line-app.mjs menus --dir …`; `show` must mark onboard as default |
| No menu at all | no menu name starts with the prefixes, or `LINE_MENU_*` in `wrangler.toml` still name someone else's menus | fix the names or delete the vars (B2), redeploy, rerun `menus` |
| After reinstalling menus, a bound person sees the onboard menu | their per-user link pointed at a deleted menu; the relay remembers it already linked them and relinks only when their bound state changes | link them to the new console menu through the Messaging API, or have them `/unbind` and bind again |
| `line-app.mjs`: `.env.line not found` | `CAN2CUP_ENV_DIR` unset or wrong | set it, or `LINE_ENV_FILE=<path>` |
| Deep links open the wrong account | `LINE_OA_ID` still the maintainer's | B2 |

## What the relay needs

| name | kind | where from | used for |
|---|---|---|---|
| `LINE_CHANNEL_SECRET` | secret (`wrangler secret put`) | Developers Console → Basic settings | verifying every webhook |
| `LINE_CHANNEL_ACCESS_TOKEN` | secret | Developers Console → Messaging API → long-lived token | replies, pushes, names, rich menus |
| `OPERATOR_LINE_USER_ID` | secret, optional | Basic settings → Your user ID | where `can2cup report` lands |
| `LINE_OA_ID` | var (`wrangler.toml`) | Messaging API → Basic ID | add-friend deep links |
| `PUSH_BUDGET` | var | your plan | LINE's monthly push ceiling (LINE only) |
| `PUSH_USER_BUDGET` | var | your choice | per-person monthly push ceiling (every app) |
| `LINE_MENU_CONSOLE`, `LINE_MENU_ONBOARD` | vars, optional | your menu names | rich menu name prefixes |

`BRIDGE_KEY` and `LINE_FORWARD_URL` are only for an external bot of your own; this runbook does not need them.

## Platform rules to know

Only pushes, multicasts, broadcasts and narrowcasts count toward the monthly allowance; replies do not. The free
allowance depends on the region's plan (200 a month on the plans the maintainer uses); check
[Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/) and your region's plan page.
Read LINE's current terms and the LINE User Data Policy before opening the bot to people other than yourself.
