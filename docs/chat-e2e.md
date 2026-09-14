# Testing the chat apps without two humans

The product's core story needs two people in one chat group, each with an agent on their own computer. Testing it by
hand means finding a second human every time a bot string changes. This is the mechanism that removes that: three
layers, each catching what the one below cannot, with the human only at the very top.

## Layer 1 — `npm run check:chat` (done, 2026-09-11)

`scripts/chat-e2e.mjs`. One scenario, three drivers, two REAL clients:

- **The people are forged webhooks**, signed the way each check script already signs them (LINE HMAC, Discord
  Ed25519 with the throwaway dev key, Telegram secret header). Person A and person B share one group / channel.
- **The agents are `dist/mcp/index.js`**, spawned over stdio exactly as Claude Code spawns them, each with its own
  `CAN2CUP_HOME`. Nothing is stubbed on the client side: link, inbox, auto-create, auto-join, send, wait, tell,
  the pause check — all the code a user runs.
- **What people would have seen is read from the push queue** (`/bridge/debug/pushes`): the dev relay has no
  chat-app token, so every reply, card, mirror and notification falls back to the queue instead of leaving the machine.

The scenario, per channel:

1. A binds by the reverse flow (`/link` → code → `can2cup_link {code}`), B by the forward one (`can2cup_link` →
   `/link CODE`); `can2cup_whoami` names the chat app.
2. A's 1:1: `/a …` → receipt → the client reads it from the inbox as UNVERIFIED, labelled with the app →
   `can2cup_tell_principal` → back in A's 1:1.
3. The group: `/status` shows the unwired card → 接上這個群 → A's client opens and wires the room → the join code
   is posted into the group.
4. B taps 讓我的 agent 也進來 → B's client auto-joins from its inbox → `can2cup_rooms` lists the room.
5. A and B talk; each line wakes the other's `can2cup_wait` under the untrusted header and is mirrored into the
   group; `/status` now lists both agents.
6. `can2cup_tell_principal where "group"`; `/pause` makes A's client refuse to send (and the principal is told);
   `/resume` lets the next send through.
7. Both `/unbind 確定`; the bridge agrees.

Run it against a local relay (`npm run dev:relay -- --var MIN_CLIENT:0.9.0`, `.dev.vars` with `DEBUG_ROUTES=1`
and the dev secrets the three check scripts use) after `npm run build`:

```
npm run check:chat                       # all three channels, 102 checks, ~1.5 min
node scripts/chat-e2e.mjs --channel discord --verbose   # one channel, every push and tool call printed
```

Two things it deliberately tolerates:

- The client asks the bridge about the brake at most once every 5 s (`pausedCache` in core.ts), so the script waits
  5 s after `/pause` and after `/resume`. A principal who pauses and an agent that sends within the same 5 s is
  a real, known window; the fail-safe direction (staying paused 5 s after `/resume`) is the one users see.
- Discord "people" can only speak slash commands, because that is all a Discord person can do to an HTTP-only app.

What it does not cover: the chat app's own API (message length limits, button payload sizes, image fetches, rate
limits) — the dev relay never calls it. That is layers 2 and 3.

## Layer 2 — `npm run probe:prod` (done, 2026-09-11)

`scripts/probe-prod.mjs`, against the **production** relay, after every deploy. Four checks, none needing a phone:

- **routes** — each webhook route is up and verifying: an unsigned or wrong-secret POST gets that adapter's own
  refusal (LINE 400, Discord 401, Telegram 401). No secret needed.
- **secret** — for every channel whose secret is on this machine (`.env.telegram`, `.env.line`), a forged `/help`
  from a synthetic unbound id is accepted (200): the deployed secret is the one we hold. The bot's reply to that id
  fails at the chat app as a per-target failure, never channel-wide, so the real principal's health is untouched.
- **loop** — the full path on the channel this machine's agent is bound to (`can2cup status` says which): a forged
  `/a probe <nonce>` as the real principal → the machine's own `can2cup watch` reads it → `can2cup tell` answers →
  `can2cup whoami` is polled until the relay's "last delivered" is after the probe began, which is the chat app's
  API saying yes to this very message. The phone gets two short lines per run. Skipped when a watch is already on
  duty (it would take the probe first).
- **discord** — only the bot token (`GET /users/@me`). Discord's inbound cannot be forged: its interactions are
  signed by Discord's own key, and driving a user account through a browser to "type /status" is a self-bot
  under Community Guideline 14, which is not an option. Inbound Discord on production is one `/status` by hand,
  and only after a Discord adapter change (layer 3).

Needs (`CAN2CUP_ENV_DIR` says which directory holds these; unset, they are looked for in the repo root):
`.env.telegram` (`TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_TEST_USER_ID` = the principal's own id), optionally
`.env.line` (`LINE_CHANNEL_SECRET`, `LINE_TEST_USER_ID`) and `.env.discord` (`DISCORD_BOT_TOKEN`). It drives the
*installed* client; `--cli dist/cli/index.js` uses the working tree's build instead (needed until the installed
client is a version whose `can2cup whoami` prints the channel health line).

```
npm run probe:prod -- --relay https://<relay>                   # ~10 s; two lines arrive on the principal's phone
node scripts/probe-prod.mjs --relay https://<relay> --skip-loop  # routes + secrets + token only, nothing reaches the phone
```

## Layer 3 — real devices, only at the adapter boundary

A live pass on a phone is needed only when an adapter's **API calls or UI pieces** change: a new button or modal,
image delivery, a new API endpoint, a message-splitting rule. Text and bridge-logic changes are covered by layer 1
and never trigger it. Test only the channel that changed.

For Discord the second person is a second account of your own: Discord's Terms and Community Guidelines
(checked 2026-09-11, last updated 2025-08-29) have no one-account-per-person rule, but they do forbid self-bots —
the second account must be tapped by hand in the official client, never automated. The second agent is just
another `CAN2CUP_HOME` on the same machine.
