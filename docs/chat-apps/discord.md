# Discord runbook: connect a Discord app to your relay

This takes a relay you already run ([SELF-HOST.md](../SELF-HOST.md) §1–5) and makes it a Discord app. When you are
done, people install the app on their account (for DMs) or into a server (for channels), bind it to their agent with
`/setup`, and drive the agent with slash commands. LINE and Telegram have their own runbooks: [line.md](line.md),
[telegram.md](telegram.md).

Written so a person or a coding agent can follow it top to bottom. Every step says **where** (the portal page or the
command), **set** (the value), **why** (what breaks without it) and **check** (how you know it worked). Steps marked
**[human]** happen in the Developer Portal and need a person logged in; steps marked **[script]** run from the repo.
An agent doing this should stop at each **[human]** step, ask the person to do it, and continue with the check.

Throughout, `https://<your relay>` is your relay's public URL, with no trailing slash.
The maintainer's deployment, can2cup.com, is a worked example: github.com/ccqqder/can2cup-deploy.

The relay speaks to Discord over **HTTP interactions only**: no gateway connection, no privileged intents. The bot
therefore never hears ordinary messages, only slash commands, buttons and modals. That is by design.

Portal labels were checked against Discord's documentation on 2026-09-14; where the screen differs, the linked
official page is the authority.

## Prerequisites

- A deployed relay: `curl -s https://<your relay>/` answers `{"ok":true,"service":"can2cup-relay",…}`.
- A clone of this repo with `npm install` and `npm run build` done (`commands` reads `dist/relay/commands.js`), and
  `npx wrangler login` done for the Cloudflare account that owns the relay.
- A Discord account that can sign in to the [Developer Portal](https://discord.com/developers/applications).
- Your own `/terms` note and privacy page. The relay serves `relay-assets/operator/terms-note.html` inside `/terms`
  and `relay-assets/privacy/index.html` at `/privacy/`. Both are the operator's words: rewrite them to name you and
  say what Discord data you keep, for how long, and how people delete it (Discord's Developer Policy asks for this).
- A directory outside the repo for credentials the scripts read (for example `~/can2cup-env`). Set
  `CAN2CUP_ENV_DIR` to it. The script looks for `.env.discord` there (the repo root if unset).
- Before step C1, edit the `description` and `tags` in `scripts/discord-app.mjs` (the `app` branch): they describe
  the maintainer's app and `app` writes them to yours.

## Part A: the Discord side [human]

### A1. Create the application [human]

- **Where:** [Developer Portal](https://discord.com/developers/applications) → **New Application**. Optionally create
  a **Team** first (Teams in the portal's sidebar) and create the app under it.
- **Set:** a name for your app. It must not suggest it is Discord or someone else's app.
- **Why a Team:** App Verification (needed before 100 servers) and ownership transfers go through the Team owner;
  starting under a Team avoids moving the app later.
- **Check:** the app opens on its **General Information** page.
- Docs: [Getting started](https://docs.discord.com/developers/quick-start/getting-started).

### A2. General Information [human]

- **Where:** the app → **General Information**.
- **Copy:** **Application ID** and **Public Key**.
- **Set:** **Terms of Service URL** `https://<your relay>/terms`; **Privacy Policy URL** `https://<your relay>/privacy/`.
  Leave **Interactions Endpoint URL** empty for now: Discord validates it on save, and the relay cannot answer until
  Part B is deployed. Step C1 sets it.
- **Why:** the Public Key verifies every interaction (Ed25519); the Application ID addresses commands and follow-up
  messages; the two URLs are shown on the install screen and are what Discord's policy expects you to publish.
- **Check:** the Public Key is 64 hex characters.

### A3. Bot [human]

- **Where:** the app → **Bot**.
- **Set:**
  - **Reset Token** → copy it now. It is shown once. It is the bot: never put it in a file in the repo.
  - **Privileged Gateway Intents**: all three (Presence, Server Members, Message Content) **off**.
  - **Public Bot**: **on** if anyone other than you will add the app to a server.
- **Why:** the token sends DMs, channel messages and name lookups. The relay needs no intent (it has no gateway), and
  an intent you do not use is a review you do not need once the app grows.
- **Check:** the token is copied somewhere safe for B1 and C1.

### A4. Installation [human]

- **Where:** the app → **Installation**.
- **Set:**
  - **Installation Contexts**: **User Install** and **Guild Install** both on.
  - **Install Link**: **Discord Provided Link**.
  - **Default Install Settings**: User Install scopes `applications.commands`; Guild Install scopes
    `applications.commands` + `bot`, permissions **View Channels, Send Messages, Embed Links, Attach Files, Read
    Message History** (step C1 writes exactly these through the API; they are the permission integer `117760`).
- **Why:** User Install lets a person use the bot in DMs with no server at all; Guild Install puts the bot into a
  server so it can post in a wired channel. A server that has the app only as a user install cannot receive the
  bot's later posts, and the bot says so.
- **Check:** after C1, `node scripts/discord-app.mjs show` prints `integration_types_config` with an explicit
  `permissions` string for both `0` and `1` (see the "Well, this is awkward" row in Troubleshooting).
- Docs: [Application resource: installation contexts](https://docs.discord.com/developers/resources/application).

## Part B: the relay side [script]

### B1. Secrets and deploy [script, values pasted by the human]

- **Run:**

  ```bash
  npx wrangler secret put DISCORD_APPLICATION_ID   # paste the Application ID
  npx wrangler secret put DISCORD_PUBLIC_KEY       # paste the Public Key
  npx wrangler secret put DISCORD_BOT_TOKEN        # paste the bot token
  npx wrangler deploy
  ```

- **Why:** without the Public Key the endpoint answers 404 and Discord will not save it; without the token and the
  Application ID the relay acknowledges a command but can never fill the answer in ("is thinking…" forever).
  Discord needs no var in `wrangler.toml`. An agent should let the person paste the values and never echo them.
- **Check:** `npx wrangler secret list` names all three, and an unsigned POST is refused as a bad signature, not as
  a missing app:

  ```bash
  curl -s -X POST https://<your relay>/discord/interactions -d '{}'
  # {"error":"bad signature"}                                     → ready
  # {"error":"no Discord app on this relay (DISCORD_PUBLIC_KEY unset)"} → B1 not applied
  ```

## Part C: point Discord at the relay [script]

Put the credentials the scripts read in `$CAN2CUP_ENV_DIR/.env.discord`:

```
DISCORD_APPLICATION_ID=<Application ID>
DISCORD_BOT_TOKEN=<bot token>
```

### C1. Endpoint, install settings, links [script]

- **Run:** `node scripts/discord-app.mjs app --relay https://<your relay>`
- **Set (by the script, through `PATCH /applications/@me`):** Interactions Endpoint URL
  `https://<your relay>/discord/interactions`; `integration_types_config` for both install contexts with explicit
  permissions (`"0"` for User Install); `install_params`; Terms of Service and Privacy Policy URLs; description and
  tags (edit them first, see Prerequisites).
- **Why:** Discord validates the endpoint on the spot (a PING that must get a PONG, and a request with a bad
  signature that must be refused), so it only succeeds against a deployed relay with the right Public Key.
- **Check:** it prints `ok: endpoint https://<your relay>/discord/interactions` and two install links. Keep those
  links: they are what you give people (see C3). In the portal, **General Information** now shows the endpoint.
- Without the script: paste the endpoint into **General Information → Interactions Endpoint URL** and save. You
  still need the script's `integration_types_config` fix, or Troubleshooting row 1 will bite.
- Docs: [Interactions overview](https://docs.discord.com/developers/interactions/overview).

### C2. Slash commands [script]

- **Run:** `npm run build && node scripts/discord-app.mjs commands`
- **Set:** the global command set, generated from `src/relay/commands.ts` (the same table LINE and Telegram use).
- **Why:** the bot hears nothing but registered commands, buttons and modals. Rerun after any change to
  `commands.ts`.
- **Check:** it prints `ok: N global commands registered: /…`. `node scripts/discord-app.mjs show` lists them too.

### C3. The install links [script output, handed to people]

The two links `app` printed have this shape. Always give people the full link with its scopes:

```
user install (DMs):   https://discord.com/oauth2/authorize?client_id=<Application ID>&integration_type=1&scope=applications.commands
server install:       https://discord.com/oauth2/authorize?client_id=<Application ID>&integration_type=0&scope=bot+applications.commands&permissions=117760
```

- **Why:** an unverified app does not appear in a server's "Add your first app" browser, so a direct link is the only
  way in. A link without `scope` falls back to whatever the app stores and is the usual route into the consent-screen
  crash.
- **Check:** open each link in a browser signed in to Discord: the consent screen lists the app, the scopes and (for
  the server link) the five permissions.

## Part D: verify end to end

1. **Config check [script]:** `node scripts/discord-app.mjs show` prints the app with your endpoint, both
   `integration_types_config` entries with a `permissions` string, your ToS and privacy URLs, and the command list.
2. **DM [human]:** open the user-install link, authorize, then in a DM with the app type `/help` and **pick `help` from
   Discord's command popup**. The console answers.
3. **Bind [human + agent]:** `/setup` and follow it on a computer with the can2cup client; `/status` then shows the
   agent.
4. **Server [human]:** open the server-install link, add the app to a test server, run `/status` in a channel.
5. **Without Discord (development) [script]:** against a local relay, never production:

   ```bash
   cp .dev.vars.example .dev.vars   # fill RELAY_SIGNING_KEY as the file says
   npm run dev:relay                # terminal 1
   RELAY=http://127.0.0.1:8787 BRIDGE_KEY=devbridge npm run check:discord   # terminal 2
   ```

   It signs forged interactions with a throwaway dev key (its public half is `DISCORD_PUBLIC_KEY` in
   `.dev.vars.example`) and reads the answers from `/bridge/debug/pushes`.

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| The consent screen crashes with "Well, this is awkward" | an `oauth2_install_params` in `integration_types_config` without `permissions`: Discord stores the string `"None"` and its client fails on it | rerun `discord-app.mjs app` (it sends `"0"` for User Install); `show` must print a `permissions` string for both contexts |
| The portal refuses to save the Interactions Endpoint URL, or `app` fails with an endpoint validation error | relay not deployed, `DISCORD_PUBLIC_KEY` unset, or the Public Key of a different app | the B1 curl check must say `bad signature`; redeploy with the right key |
| A command shows "is thinking…" and never answers | `DISCORD_BOT_TOKEN` or `DISCORD_APPLICATION_ID` missing or wrong on the relay | B1; `npx wrangler tail --format pretty --status error` shows the refused call |
| "The application did not respond" | the relay did not acknowledge within Discord's 3-second limit (deploy in progress, Worker error) | retry; check `wrangler tail` |
| `/a hello` does nothing, no error anywhere | it was sent as a plain message because `a` was not picked from the command popup; an HTTP-only app never receives plain messages | pick the command from the popup, or use the button on `/status` |
| Commands missing in the client | `commands` not run, or the client has an old list | C2; restart the Discord client |
| `commands`: `Cannot find module …dist/relay/commands.js` | not built | `npm run build` |
| `discord-app.mjs`: 401 from discord.com | the token in `.env.discord` was reset in the portal | copy the current token to `.env.discord` and to `wrangler secret put DISCORD_BOT_TOKEN` |
| In a server the bot says it is only installed on your account | the server has a user install, not a guild install | a server admin opens the server-install link |
| People cannot find the app in their server's app browser | unverified apps are not listed there | give them the C3 links |
| The app cannot join more servers | App Verification is needed before 100 servers | apply in the portal (**App Verification**); the Team owner verifies identity |

## What the relay needs

| name | kind | where from | used for |
|---|---|---|---|
| `DISCORD_APPLICATION_ID` | secret (`wrangler secret put`) | General Information → Application ID | command and follow-up URLs, install links |
| `DISCORD_PUBLIC_KEY` | secret | General Information → Public Key | verifying every interaction |
| `DISCORD_BOT_TOKEN` | secret | Bot → Reset Token | DMs, channel posts, name lookups |
| `PUSH_USER_BUDGET` | var (`wrangler.toml`), shared | your choice | per-person monthly push ceiling (Discord has no platform allowance; `PUSH_BUDGET` does not apply) |

The Application ID is public, but it is kept out of `wrangler.toml` so a fork never runs with someone else's.

## Platform rules to know

Read Discord's current Developer Terms of Service and Developer Policy before opening the app to others. The points
this design depends on: DMs start from a user action (a person installs and runs `/setup` first); API data may not
train models; bot tokens never go into an open-source repository; App Verification before 100 servers
([App Verification](https://support-dev.discord.com/hc/en-us/articles/23926564536471)). Interaction handling:
[Receiving and responding](https://docs.discord.com/developers/interactions/receiving-and-responding) (3-second first
response, 15-minute token).
