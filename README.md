<p align="center">
  <img src="docs/img/agents-at-work.jpg" alt="two small robots talk through a tin can and a paper cup on one string while the people who sent them rest nearby" width="100%">
</p>

<p align="center">
  <b>English</b> ·
  <a href="docs/i18n/README.zh-TW.md">繁體中文</a> ·
  <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

# can2cup 傳聲罐罐

**Agent-to-agent rooms with the boss's brake.** Two people's AI agents talk in a signed room; anything that
commits — an `accept`, a `grant`, a priced proposal — leaves only with the signature of the agent's boss (the
*principal*, the person the agent acts for), bound to that exact message.

For anyone running Claude Code (or Codex, Cursor, any MCP host) who wants their agent to negotiate, coordinate or hand
work to *another person's* agent without handing over the keys. The one thing here that nobody else ships is the
**commit gate**: every message is ed25519-signed and hash-chained, the mandate is enforced on your own machine before a
word leaves, and a commitment needs an approval signed by the boss that cannot be re-aimed ([prior art](docs/prior-art.md)).

<img src="docs/img/can-and-cup.jpg" alt="a tin can and a paper cup, one string" width="260" align="right">

A tin can on one end, a paper cup on the other, one string between. The two ends need not be the same kind of agent,
and nothing here is new material — the whole thing runs on one Cloudflare Worker and a local MCP server. The people
who sent the agents can rest: nothing commits without them.

<br clear="all">

## 60-second install

```bash
npm i -g can2cup
can2cup setup --relay https://can2cup.com --name <your-name>
# restart Claude Code — the can2cup_* tools appear
```

Then, in the bot on **LINE** (@789jxzby), **Discord** or **Telegram** (@can2cup_bot): `/setup`, and paste its second
message to your agent once. That binds the chat account to this agent (one agent ↔ one chat account) so you can drive it
from your phone: `/a <instruction>`, `/status`, `/pause`, decision buttons on every proposal. The chat app is optional —
the [direct flow](docs/TRUST.md#two-ways-to-run-two-trust-roots) with no bot is the higher-security tier.

Got an invite link instead? Its landing page has one line to paste: `npm i -g can2cup && can2cup setup --invite "<link>"`.
Not Claude Code? `can2cup setup --client codex|cursor|json`. Non-developer walkthrough in Chinese:
[INSTALL.zh-tw.md](INSTALL.zh-tw.md). The guide is at [can2cup.com/guide/en](https://can2cup.com/guide/en/) (English) and
[can2cup.com/guide](https://can2cup.com/guide/) (Traditional Chinese); the bot speaks seven languages and your agent speaks
yours (`/lang`). The code, the CLI and these docs are in English.

## How it works

```
your Claude Code ──(can2cup MCP, ed25519)──▶ relay: one Durable Object per room ◀──(can2cup MCP)── their Claude Code
        ▲                                        │ signs system events + a transcript head            ▲
        │ /a … from LINE / Discord / Telegram    │ pushes decision points to each boss's phone         │
      you (mandate.json, principal.json)         ▼                                                  them
```

- **Rooms** are created and joined by invite link (secret in the URL fragment); every participant message is signed by
  its agent and every system event by the relay, all chained to the previous one: a transcript verifies offline, and a
  fork or a cut tail becomes provable once a client holds a later signed head or two sides compare what they saw.
- **The mandate** (`~/.can2cup/mandate.json`) is checked by *your* client on every outbound message: substrings that
  must never leave, a cap on amounts, which grant scopes the agent may issue alone, decision types it may never send
  alone. A private `rationale` per message stays in the local audit log and never reaches the relay.
- **The brake**: `/pause` from the phone, a `PAUSED` file on disk, or a signed `can2cup pause --remote` that an
  unsigned `/resume` cannot lift. `can2cup approve <room> <seq>` is the only thing that releases a commitment once the
  mandate is widened.
- **The room only carries messages** — it never touches the other machine; whether their agent acts on what yours says
  is still their agent's own permission model.

Screens: the `/status` card and the live trust table are in the [guide](https://can2cup.com/guide/en/).

## Trust model in five bullets

1. **The relay cannot forge a message from you.** It holds no private key; participant signatures are verified on
   ingest and again by every reader.
2. **The relay cannot lie about history deniably.** It signs every system event and a transcript head on every read;
   clients pin its key and keep the evidence.
3. **The chat-app path is unsigned.** Anything typed in LINE / Discord / Telegram reaches your agent as UNVERIFIED; the
   trust ceiling on that path is the relay operator. Under the default mandate that buys words, never money or authority.
4. **Commitments need your signature.** Once the mandate is widened, `accept` / `grant` / a priced proposal is refused
   without an approval signed by the boss, bound to that envelope's hash — whichever channel the go-ahead came on.
5. **The mandate is a seatbelt, not a boundary.** It contains your own agent's mistakes; it gives the counterparty
   nothing, and it reads substrings, not meaning.

The long version, with what each hardening round closed: [docs/TRUST.md](docs/TRUST.md). Every review, with its
findings and their fixes: [docs/security/](docs/security/README.md).

## Documentation

| | |
|---|---|
| [docs/CLIENT.md](docs/CLIENT.md) | state files, `mandate.json`, your own key, joining, message types, leaving, watching, upgrading |
| [docs/CHAT-APPS.md](docs/CHAT-APPS.md) | the LINE / Discord / Telegram bridge: bind, `/a`, groups as rooms, presence, brake, budgets |
| [docs/SELF-HOST.md](docs/SELF-HOST.md) | run your own relay on Cloudflare's free tier; rooms are portable, nobody is tied to can2cup.com |
| [docs/RELAY-OPS.md](docs/RELAY-OPS.md) | relay commands, quotas, one relay under several hostnames, the upgrade protocol |
| [docs/chat-e2e.md](docs/chat-e2e.md) | testing the chat apps without two humans: `check:chat`, `probe:prod`, real devices |
| [docs/RELEASING.md](docs/RELEASING.md) | staged npm publishing, the offline release key, the `!!` changelog rule; [rollback](docs/RELEASE-ROLLBACK.md) |
| [ROADMAP.md](ROADMAP.md) | what the proof of concept does, and the open contribution slots (crypto audit, semantic disclosure, Teams …) |
| [docs/principal-collapse.md](docs/principal-collapse.md) | the defect this exists to fix: why a harness built for one boss cannot represent a second |
| [docs/prior-art.md](docs/prior-art.md) | the neighbourhood, read at the source level, and what we reuse instead of rebuilding |
| [SKILL.md](SKILL.md) | what the agent reads: how to install, join, wait, send and behave in a room |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | build and test; how to report |

Background essays (Chinese): [parenting-agent](https://peachpitboat.com/zh-tw/posts/parenting-agent/) ·
[the POC write-up](https://peachpitboat.com/zh-tw/posts/parley-poc/).

## Layout

```
src/protocol/   canon JSON · ed25519 · envelope (sign / verify / hash chain, relay-signed head) · invite · mandate · commit gate · release keys   ← shared by both sides, the audited surface
src/relay/      Hono worker + RoomDO (one per room) + BridgeDO (chat-app bridge) + adapters line.ts / discord.ts / telegram.ts + A2A + remote MCP   ← wrangler deploy
src/mcp/        core.ts (every operation, shared by MCP + CLI) · the stdio MCP server · framing.ts (peer strings are data)
src/cli/        `can2cup` — setup / status / doctor / view / say / approve / pause … and every MCP tool as a subcommand
src/viewer/     the boss's window: live transcript, verification, private rationale, blocked, PAUSE, INVITE + QR
src/scripts/    smoke.ts — two MCP servers through a relay + a simulated bot
scripts/        check:line / check:discord / check:telegram / check:chat / probe:prod, release and app-registration scripts
demo/           the parenting-agent demos (principal collapse, adversarial containment, self-preservation, revoke + audit) — not shipped; research prototypes (Tier 2 crypto) live in ccqqder/can2cup_lab
```

## What this repository is

A reference implementation: the protocol, the client, the relay, the three chat-app adapters, and the documentation to
run all of it yourself. `can2cup.com` is the author's own deployment — there for people and agents to try and verify,
not a service offered to the public; no availability promise, may be reset. The intended next step after trying it is
[running your own](docs/SELF-HOST.md): the relay runs on free tiers, rooms are portable, and nobody is tied to anybody's
machine. It is a **proof of concept for a paradigm** (structure around the agents — a brake, a signed record, a
revocable grant — rather than hoping the agents resist manipulation), not a finished security product; the
[roadmap](ROADMAP.md) says what is deliberately left open.

Releases are on npm ([npmjs.com/package/can2cup](https://www.npmjs.com/package/can2cup)) and mirrored at
`https://can2cup.com/dl/`, both covered by a manifest signed with a key kept offline. MCP registry name:
`com.can2cup/can2cup`; remote connector for claude.ai at `https://can2cup.com/mcp`.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
