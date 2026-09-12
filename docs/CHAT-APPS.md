# The chat-app bridge — the principal lives in LINE / Discord / Telegram, not in a terminal

`BridgeDO` on the relay owns the chat-app webhooks and turns a 1:1 chat into the principal's console and a group /
channel into a window on the room. The console (`src/relay/bot.ts`) is channel-neutral; each app is one adapter behind
the `Channel` interface in `src/relay/channel.ts`, registered in `src/relay/channels.ts`:

| app | adapter | how it hears you | ids |
|---|---|---|---|
| LINE | `line.ts` (v0.12.0) | Messaging API webhook, HMAC-verified; reply / push / rich menu | `U…` / `C…` |
| Discord | `discord.ts` (v0.12.1) | HTTP-only interactions (no gateway, no privileged intent): slash commands, buttons, a modal; embeds for the status card | `discord:u:<id>` / `discord:c:<id>` |
| Telegram | `telegram.ts` (v0.15.0) | Bot API webhook with the secret header; privacy mode on (commands, @mentions, replies) | `telegram:u:<id>` / `telegram:c:<id>` |

One agent binds to one chat account. A person can run several agents (one per machine) bound to different apps;
`can2cup status --all` and the connector's `can2cup_status` list them on one page ([dashboard-tool.md](dashboard-tool.md)).
Adding a fourth app is one file + one registry entry + two scripts; [CONTRIBUTING.md](../CONTRIBUTING.md) § Adding a
chat app is the walkthrough.

```
your Claude Code (can2cup MCP) ──── room ──── their Claude Code
        │ /p/* (ed25519-signed)          ▲ RoomDO tells BridgeDO about every stored envelope
        ▼                                │
   BridgeDO: bindings · inbox · remote pause · room knowledge · mirrors · push queue (alarm) · monthly budget
        │ console (bot.ts, channel-neutral) ── adapters (line.ts · discord.ts · telegram.ts)
        │ webhook in (verified per app)  ·  reply / push out (that app's token)
   1:1 chat (each principal)   ·   group / channel (you + them + bot)
```

The bot speaks Traditional Chinese, English, Simplified Chinese, Japanese, Thai, Indonesian and Vietnamese; the agent speaks the boss's own language, one of sixteen (v0.17.0,
**Languages** below). The console's sentences are written in Chinese in the code and translated in
`src/relay/i18n/<lang>.json`; `npm run check:i18n` keeps the two in step ([i18n/LANGUAGES.md](i18n/LANGUAGES.md)).

## What the bridge does

- **Bind.** `/setup` in the bot embeds a user-bound 30-minute code in `can2cup setup --link`; if it expires, setup
  prints a one-scan QR. The manual path: the agent calls `can2cup_link` → the principal sends `/link ABCD-1234` to the
  bot within 10 min. Auth is the code (only whoever runs that agent has it), not a whitelist on the bot — a friend can
  onboard with zero installs on the bot side. `/link` typed while already bound hands out a code for the claude.ai
  connector sign-in instead.
- **Agent → principal.** RoomDO reports every stored envelope to BridgeDO (delivered from `alarm()`); decision types
  (`question proposal counter accept reject grant revoke escalate attachment close`) are pushed to the bound account with
  同意 / 拒絕 / 看全文 buttons. Plain `text` is not pushed 1:1. The agent's own blocked sends and `escalate`s go too.
- **Principal → agent.** `/a …` and button taps land in a per-agent inbox; `can2cup_wait` drains it and returns it as
  a separate block labelled **UNVERIFIED** (the phone holds no key; only `can2cup say` / `can2cup approve` from a
  machine with `principal.json` earns *VERIFIED*). `/agent on` routes every 1:1 text there.
  `require_signed_principal` in the mandate drops these entirely.
- **Agent → principal, in words.** `can2cup_tell_principal` answers in the chat app. An `/a` typed in a group carries
  the group id and the reply goes back to that group (labelled `💬 <agent>（agent）`); `where=dm` keeps it private;
  `blocked` / `escalate` always go to the 1:1. So two people in one group, each bound to their own agent, can drive
  both agents from the group — the bot is the shared interface. Every group the principal has spoken from gets a
  stable alias (`can2cup groups`; `tell --where group:g2`).
- **Group = room.** `/room [name]` in a group (or the 接上這個群 button on `/status`) makes that group *the* room: the
  typer's agent creates and wires it, the join code is posted back, the other person taps 讓我的 agent 也進來 and their
  agent auto-joins, and every envelope is mirrored into the group with sender names. `/mirror [room] [all]` attaches
  an existing room (decision points only unless `all`); `/unmirror` stops either. A wired group's room expires
  `GROUP_ROOM_TTL_DAYS` after its last message.
- **Presence.** The MCP process announces itself on start, heartbeats every 60 s and says goodbye when its stdin
  closes. `/status` shows 🟢 在線 / 🔴 離線（最後在線 N 分鐘前）; `/a` to an offline agent queues; the principal is told
  "agent 已離線" / "回來了（排隊 K 則）". Several sessions on one machine share one agent key, so the goodbye is held
  for `PRESENCE_GRACE_SEC` (90 s > the heartbeat) and only the *last* session leaving is announced.
- **Remote brake.** `/pause` sets a flag the client checks in `mandateCheck` (cached up to 5 s) — nothing leaves until
  `/resume`. An unsigned `/pause` always brakes (the safe direction); an unsigned `/resume` cannot lift a *signed* pause.
  The 5-second cache is a real window: a principal who pauses and an agent that sends within the same 5 s.
- **Duty / watch.** `can2cup watch` blocks at zero token cost across every open room + the inbox and exits when
  something real arrives — run it in a background shell and let its exit wake the agent.
- **Images.** `can2cup tell --image shot.png [--ttl 3600]` hosts the file on the relay (`/f/:id`, auto-deleted after
  ttl, default 1 h) and sends it as an image message.
- **Invite through the chat app.** `can2cup_invite_line {room}` → a short code + deep link / QR; the invitee's bot chat
  opens with `/join <code>` prefilled and their agent auto-joins. Forwarding the raw invite link to the bot works too.
- **Resume after a restart.** The MCP's server instructions and `can2cup_whoami` open with `RESUME: in N open room(s)`
  and the count of instructions left while it was away.
- **Binding lifetime.** A 1:1 binding lapses after the agent has been absent `IDLE_DAYS` (90; warned 14 days ahead;
  any signed call renews). `/keep` and `can2cup keep` override. Group wires die with their room.
  ([security/2026-09-05-binding-lifetime.md](security/2026-09-05-binding-lifetime.md))
- **Budgets.** LINE's free plan meters pushes, so LINE alone is gated on `PUSH_BUDGET` (180 / month); every channel is
  bounded by `PUSH_USER_BUDGET` (per target / month) and the per-room hourly gate. `/quota` shows your channel's numbers.
- **Languages (v0.17.0).** Every chat account, and every wired group, has a language: `/lang` (a picker, a code, or
  the language's own name), or the picker `/setup` shows first when the platform names none. Discord and Telegram
  send a locale, LINE does not; nothing known means English, and accounts bound before 0.17.0 keep Traditional
  Chinese. A group's language is its wirer's to set, like `/context on`. The bot answers in the boss's language
  when it has a catalog for it (Traditional Chinese, English, Simplified Chinese, Japanese, Thai, Indonesian and Vietnamese) and in English otherwise. The agent is told the boss's
  language on `/p/state` and on every inbox item and speaks it; its prompt stays in English (SKILL.md §3.6).
  Binding sends the agent a CHAT APP CONNECTED event, and it introduces itself in that language. A language is
  only ever a code from `src/protocol/lang.ts`, never free text: the unsigned chat path must not become a way to
  write into the agent's prompt. Notifications the client sends (a blocked send, an expired room) travel as a code
  and are worded by the relay in the language of the place they land.

## Known small things

- **Discord**: typing `/a hello` and pressing Enter *without picking `a` from Discord's command popup* sends a plain
  message that an HTTP-only app never receives — no error anywhere. Pick the command from the popup, or use the
  交代 agent button on `/status`, which has no such trap.
- **Discord**: the app is not yet Discord-reviewed, so it does not appear in a server's "Add your first app" list; the
  guide at can2cup.com/guide has the two install links (user install for DMs, server install for channels).
- **Telegram**: privacy mode stays on. In a group the bot hears `/commands`, `@mentions` and replies to itself, nothing
  else. A command addressed to another bot (`/pause@other_bot`) is ignored.
- **LINE**: when the monthly push allowance is spent, every push to LINE fails with 429 until month end; the operator
  is warned once and `/quota` says so.

## Secrets and setup (relay operator)

Per app, set the secrets named in `wrangler.toml` (`LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN`;
`DISCORD_APPLICATION_ID` + `DISCORD_PUBLIC_KEY` + `DISCORD_BOT_TOKEN`; `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`,
plus `TELEGRAM_BOT_USERNAME` in `[vars]`), deploy, then run `scripts/discord-app.mjs` / `scripts/telegram-app.mjs`
(`app` points the platform at your relay, `commands` registers the command menu from `src/relay/commands.ts`). With no
chat-app secrets at all the relay has no bot ("direct mode"). Details in [SELF-HOST.md](SELF-HOST.md) §3.
`BRIDGE_KEY` + `LINE_FORWARD_URL` remain for an external bot of your own.

## Testing

Chat-text and bridge-logic changes are proven by `npm run check:chat` (two forged people, two real clients, all three
apps in one run), not by a second human. After a deploy, `npm run probe:prod`. Real devices only when an adapter's own
API calls or UI pieces change. The three layers: [chat-e2e.md](chat-e2e.md).

## Not yet

`/say` (the principal speaking *in the room* under their own key) · a signed `/link` (bind the chat account to the
principal key, not just to a code) · one agent bound on several apps at once · the console in the other nine languages (one JSON file
each) · Teams
(shelved; the plan and a do-it-yourself checklist are in the maintainer's notes — open an issue to get them).
