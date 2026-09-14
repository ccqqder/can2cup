# Contributing

Thanks for looking. The [roadmap](ROADMAP.md) lists the open slots and the four principles every change is held to
(structure over cleverness; one implementation for both floors; `src/protocol` is the audited surface; name the
residual). This file is the mechanics.

## Build

```bash
npm install
npm run build              # tsc → dist/ (client, MCP server, CLI, viewer, smoke)
npm run check:relay        # type-check the Worker (tsconfig.relay.json); it is not part of `build`
node dist/cli/index.js --help
```

Node 18+; the Worker targets the `compatibility_date` in `wrangler.toml`.

## A local relay

```bash
cp .dev.vars.example .dev.vars 2>/dev/null || true   # or write it by hand — the keys are listed in docs/RELAY-OPS.md
npm run dev:relay -- --var MIN_CLIENT:0.9.0            # http://127.0.0.1:8787
```

`.dev.vars` needs `RELAY_KEY=dev`, `BRIDGE_KEY=devbridge`, a `RELAY_SIGNING_KEY` (any ed25519 private key in hex —
`node -e "import('./dist/protocol/index.js').then(m=>console.log(m.newKeypair().priv))"`), `DEBUG_ROUTES=1`, the dev
chat-app secrets each check script names in its header (`LINE_CHANNEL_SECRET=devsecret`, the Discord dev key's public
half as `DISCORD_PUBLIC_KEY`, `TELEGRAM_WEBHOOK_SECRET=devtelegramsecret0000`), `RELAY_CANONICAL` /
`RELAY_ALIASES` for the local URL, and the short timers the smoke wants. The full list with the values:
[docs/RELAY-OPS.md](docs/RELAY-OPS.md). Nothing in `.dev.vars` is a real secret; the file is gitignored anyway.

## Checks, and which one proves what

| command | proves |
|---|---|
| `npm run smoke` (with `RELAY=… RELAY_KEY=dev BRIDGE_KEY=devbridge`) | the protocol and the client end to end: two MCP servers through a relay, rooms, chain, mandate, commit gate, principal key, portable rooms, mirrors, E2E, the simulated bot |
| `npm run test:framing` · `npm run test:mechanism` | unit tests for peer-string framing and the sealed-bid mechanism |
| `npm run check:line` · `check:discord` · `check:telegram` | one adapter each: forged, correctly signed webhooks against the dev relay; replies read back from the debug push queue |
| `npm run check:chat` | **the product story**: two forged people in one group, each with a REAL client, on all three apps — bind, `/a`, wire, join, talk, mirror, brake, unbind ([docs/chat-e2e.md](docs/chat-e2e.md)) |
| `npm run check:routes` | `[[routes]]` agrees with `RELAY_CANONICAL` / `RELAY_ALIASES` |
| `npm run check:i18n` | every sentence the bot says is a `tr()` literal with an entry in each `src/relay/i18n/*.json`, same placeholders; no Chinese string escapes it |
| `npm run probe:prod -- --relay <url>` | after a deploy, against production: routes refuse bad signatures, secrets are ours, one forged `/a` round trip |
| `npm run demo:*` | the parenting-agent demos; not tests, but they must still run |

**The rule for chat text and bridge logic:** a change is proven by `check:chat` (plus the adapter's own `check:*`),
not by a second human on a phone. Real devices are for changes to an adapter's own API calls or UI pieces (a new
button, modal, image), on that channel only.

**The rule for `src/protocol`:** anything that changes what is signed, hashed, verified or gated needs a smoke section
that fails without the change, and a line in the changelog entry. Prototype cryptography stays in `demo/` until an
external audit clears it (the 🔒 tag in the roadmap).

## Adding a chat app

An adapter is one file implementing `Channel` (`src/relay/channel.ts`), one entry in `src/relay/channels.ts`, two
scripts (`scripts/<app>-app.mjs` to register the webhook and commands, `scripts/<app>-check.mjs` to forge its
webhooks), a driver in `scripts/chat-e2e.mjs`, and a paragraph in `docs/SELF-HOST.md`. `src/relay/telegram.ts` is the
smallest complete example. The console never learns which app it is talking to: it builds sentences from the
channel's `vocab`, and the command table exists once in `src/relay/commands.ts`. Read the platform's developer terms
before you start and keep the bot token out of every file.

## The repository family

This repository holds only what ships and what builds, checks, deploys and documents it: the `files` list in
`package.json` is the shipped surface, `scripts/` and `src/scripts/` prove it, `docs/` describes shipped behaviour.
Everything else lives elsewhere on purpose, so a reader of this repository never has to ask what is real:

- [can2cup_lab](https://github.com/ccqqder/can2cup_lab) — research prototypes, experiments and intermediate products (the Tier 2 crypto suite
  today). Nothing there is shipped; a prototype that graduates is ported here in its own commit.
- the maintainer's private notes — plans, handoffs, review prompts, brand originals, design mock-ups, checklists.
- the private archive of this project's history before 2026-09-12. This repository starts from a single commit
  of the 0.17.0 tree; releases up to 0.17.0 are on npm and the tags for them are in the archive
  ([docs/RELEASING.md](docs/RELEASING.md)).

Work that will ship within one release is a branch here. Anything else starts in the lab or the notes and is ported
in when it ships. Cross-references between repositories are URLs, never relative paths.

## Nothing personal in the tree

`npm run check:pii` (also run by CI before every publish) refuses home-directory paths, personal e-mail addresses (the
common free-mail domains), chat-platform user ids, tokens and private keys in tracked text files (lockfiles, release
artifacts under `relay-assets/dl/` and binaries are skipped); the same script checks the staged diff as a pre-commit
hook once you run `git config core.hooksPath .githooks` in your clone. Your own extra patterns (an employee id, a
hostname, a real name) go in `~/.can2cup-release/pii-patterns.txt`, never in the repository.

## Pull requests

- One concern per PR; say which check proves it and paste its last lines.
- A user-visible change gets a bullet in `relay-assets/changelog.txt` under the *next* version (newest first; the `!!`
  first-line rule for permission or data-flow changes is in [docs/RELEASING.md](docs/RELEASING.md)).
- Docs live next to the code they describe (`docs/`); the README is the front door, not a log. Its translations in
  `docs/i18n/` are regenerated whole from the English file when it changes ([docs/i18n/LANGUAGES.md](docs/i18n/LANGUAGES.md)).
- A sentence the bot says is written in Traditional Chinese inside `tr(lang, "…")` (`src/relay/i18n.ts`) and gets its
  English entry in `src/relay/i18n/en.json` in the same PR; `npm run check:i18n` fails otherwise. Code, comments and
  docs are in English. In Chinese the person an agent answers to is 老闆, never 主人 (see [docs/i18n/LANGUAGES.md](docs/i18n/LANGUAGES.md)).
- By contributing you agree your contribution is licensed under Apache-2.0, like the rest of the project.

Releases are cut by the maintainer ([docs/RELEASING.md](docs/RELEASING.md)); security findings go through
[SECURITY.md](SECURITY.md).
