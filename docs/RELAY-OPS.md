# Relay operations — running, checking and naming the relay

For the maintainer's own deployment and for anyone who runs their own ([SELF-HOST.md](SELF-HOST.md)). Releases are in
[RELEASING.md](RELEASING.md); the chat-app secrets are in [CHAT-APPS.md](CHAT-APPS.md).

## Commands

```bash
npm run dev:relay                       # local: http://127.0.0.1:8787, values from .dev.vars
npm run check:relay                     # types (tsconfig.relay.json)
npm run deploy:relay                    # wrangler deploy — needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN or `wrangler login`
npx wrangler secret put RELAY_KEY       # the create-room key (X-Parley-Key)
npx wrangler secret put RELAY_SIGNING_KEY  # hex ed25519 private key: node -e "import('./dist/protocol/index.js').then(m=>console.log(m.newKeypair().priv))"
                                        # GET / then advertises the pubkey; clients pin it per room. Rotating it makes old rooms' system events unverifiable — avoid.
RELAY=http://127.0.0.1:8787 RELAY_KEY=dev BRIDGE_KEY=devbridge npm run smoke   # two MCP servers through a relay + a simulated bot, ~430 checks
npm run check:line / check:discord / check:telegram   # one adapter each, forged webhooks against the dev relay
npm run check:line-app                  # line-app.mjs show / app / menus against a fake LINE API (no relay, no token)
npm run check:chat                      # the two-human story over LINE, Discord and Telegram with real clients (docs/chat-e2e.md)
npm run probe:prod -- --relay https://<relay>   # after a deploy: production routes, secrets, one forged /a round trip on this machine's chat app
npm run check:routes                    # [[routes]] vs RELAY_CANONICAL / RELAY_ALIASES; release:relay runs it first
                                        #   -- --config <toml> checks another deployment's config
npm run assemble:assets -- --out <dir> [--overlay <dir>] [--dl <dir>]   # a complete assets directory (below)
npm run mirror:dl -- --version <x.y.z> --out <dir>   # the signed install files of a release, verified, without the key
```

`discord-app.mjs app`, `line-app.mjs app`, `telegram-app.mjs describe|app|say|tap` and `probe-prod.mjs` have no default relay: pass
`--relay https://<relay>`. `telegram-app.mjs tap` names the bot from `--bot-username` (else `TELEGRAM_BOT_USERNAME`).

### The assets directory of another deployment

`wrangler.toml`'s `[assets]` points at `relay-assets/`, which is this deployment's. A fork or a separate deployment
repository builds its own with `scripts/assemble-assets.mjs --out <dir>`: the generic files from `relay-assets/`
(`favicon.ico`, `apple-touch-icon.png`, `changelog.txt`, `known-issues.json`), `skill.md` and `selfhost.md` generated
from `SKILL.md` and `docs/SELF-HOST.md`, `dl/` from `--dl` (default `relay-assets/dl`), then `--overlay <dir>` copied
on top — its own guide, privacy page, `llms.txt`. An overlay `known-issues.json` is merged into the generic one
(issue ids must not collide). Because static assets are served before the Worker, any file that would take over a
Worker route (a root `index.html`, or anything under `terms`, `j/`, `mcp`, `oauth/`, `rooms/`, `p/`, `f/`, `bridge/`,
`line/`, `discord/`, `telegram/`, `.well-known/` and the other routes read from `src/relay/index.ts`) is refused.
`<out>` must be new or empty; the script prints a sha256 listing of what it wrote. Point that deployment's own
wrangler config at `<out>` and run the release scripts with `--config` / `--assets` ([RELEASING.md](RELEASING.md)).

`.dev.vars` for a local relay: `RELAY_KEY=dev`, `BRIDGE_KEY=devbridge`, `RELAY_SIGNING_KEY=<hex>`,
`DEBUG_ROUTES=1` (exposes `/bridge/debug/pushes`, which the check scripts read instead of a real chat app),
`LINE_CHANNEL_SECRET=devsecret`, `DISCORD_PUBLIC_KEY=<the dev key's public half>`,
`TELEGRAM_WEBHOOK_SECRET=devtelegramsecret0000`, `RELAY_CANONICAL` / `RELAY_ALIASES` matching what you test, and the
short timers the smoke wants (`PRESENCE_GRACE_SEC=2`, `INBOX_LEASE_SEC=5`, `IDLE_DAYS_SEC=4`, `IDLE_WARN_SEC=2`,
`IDLE_GRACE_SEC=0`). `check:chat` wants `npm run dev:relay -- --var MIN_CLIENT:0.9.0`. Each check script's header says
exactly what it needs.

## Rooms and capabilities

`join` must be **signed by the joining key** and returns a per-participant `cap`, which the client uses as its bearer
from then on. The invite secret stays a join+read key. `rotate` (any participant) kills every copy of the link;
`eject` (creator) revokes one participant's cap *and* rotates. The HTTP surface is documented at the top of
`src/relay/index.ts`; the principal bridge (`/p/*`, `/bridge/*`, `/principal/*`) at the top of `src/relay/bridge.ts`.

Two runtime rules learned the hard way: handlers parse the body before reading `last` (so racing sends cannot share a
seq), and the Worker buffers request bodies before handing them to a Durable Object (a DO answering 401/409 without
reading a streamed body crashes the isolate). Background work in a DO goes through storage + `alarm()`, never a
dangling promise.

## Abuse controls

Per-identity quotas in `[vars]`: `ROOMS_PER_DAY`, `MSGS_PER_MIN`, `IMG_BYTES_PER_DAY`, `PUSH_USER_BUDGET` (pushes per
target per month), `PUSH_BUDGET` (LINE's monthly allowance only), plus a per-room hourly push ceiling. `/terms` renders
the live numbers. `/admin/ban` with `RELAY_KEY` bans an identity; a ban covers both sides of a chat-app binding and
survives `erase`. `MIN_CLIENT` is the oldest client the relay still serves for opening rooms, wiring groups and
speaking (426 below it); raise it only for incompatible protocol changes, after seven days' notice in
`relay-assets/known-issues.json`.

`can2cup report "<what you tried>"` from any client sends a diagnostic (versions, OS, doctor output, error lines — no
room content) to the operator's own chat account, `OPERATOR_LINE_USER_ID` (a secret). It has its own daily ceiling so
it can never eat the user-facing push budget.

## One relay, several hostnames

`can2cup.com`, `www.can2cup.com`, `can2cup.peachpitboat.com`, `can2can.peachpitboat.com` and `parley.peachpitboat.com`
are **one Cloudflare Worker (`parley-relay`) with one relay signing key** — the `[[routes]]` in `wrangler.toml`;
`GET /` on any of them returns the same `pub` and reports `canonical` + `aliases`. The older names stay up so that every
invite link and every client configured before the 2026-09 renames (parley → can2can → can2cup) keeps working.

`can2cup relay https://can2cup.com` rewrites `config.json` and each room's `relay` field to a new hostname of the
*same* relay, and must not be used to point at a different one. `rooms.json` (or `can2cup rooms`) can therefore show
rooms under different hostnames with the same `relayKey=` — that is the same relay, not a handover. A real change of
operator shows up as `RELAY KEY CHANGED` on the next read, and a join whose invite vouches for another key (`p=`) is
refused. `scripts/routes-check.mjs` fails a release when `[[routes]]` and `RELAY_CANONICAL` / `RELAY_ALIASES` drift;
any change of default relay is announced in `changelog.txt`. Decision record:
[security/2026-09-05-g4-relay-hostnames.md](security/2026-09-05-g4-relay-hostnames.md).

## The upgrade protocol

Every client call carries `x-can2cup-client`; every relay reply carries `x-can2cup-latest` (from `/dl/VERSION`,
read through the `ASSETS` binding) and `x-can2cup-min` (`MIN_CLIENT`). `/dl/manifest.json` + `/dl/manifest.sig` are
the maintainer-signed manifest that `can2cup upgrade` verifies against the keys compiled into `src/protocol/release.ts`;
a relay operator can rewrite everything under `/dl/` but cannot produce that signature. Self-hosters mirror the
maintainer's signed files ([SELF-HOST.md](SELF-HOST.md) §4).

## Other surfaces the relay serves

- `/guide/` (Traditional Chinese user guide), `/terms`, `/privacy/`, `/changelog.txt`, `/llms.txt`, `/skill.md`,
  `/selfhost.md` — static files under `relay-assets/`.
- `/j/:id` — the invite landing page (secret stays in the URL fragment).
- `/.well-known/agent-card.json` + `POST /a2a` — A2A v1.0.0 Agent Card and JSON-RPC endpoint; ingest is opt-in per room.
- `/mcp` + `/oauth/*` + `/.well-known/oauth-*` — the remote MCP connector (OAuth 2.1) for claude.ai / ChatGPT; hosted
  keys' custody is disclosed at `/hosted/:pub`.
- `/rooms/:id/anchor` — RFC 3161 timestamp over the transcript head when `TSA_URL` is set (501 otherwise).
