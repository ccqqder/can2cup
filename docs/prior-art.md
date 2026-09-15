# Prior art — the neighbourhood, and what we reuse

*Verified by reading the source, not the marketing page. Survey date 2026-09-07, with an
addendum survey 2026-09-14 covering Glama and a partial dump of the official MCP registry
(about 21,100 entries, stopped by a server error partway through — see §1a).*

Two questions this page answers, in order:

1. **Is can2cup reinventing a wheel?** — the comparison table.
2. **What can we take instead of building?** — the reuse list, ranked.

Everything here was checked against a clone or the published manifest. Where a claim
comes from a specific line, the file and line are cited in the appendix.

---

## 1. The neighbourhood

The projects that actually attempt **cross-owner** agent messaging. Same-owner
orchestration (agent-room, mcp-huddle, Connect My Bot, Agent-MCP) is excluded — one owner,
one trust boundary, no adversarial interest; it is a concurrency problem, not this one.

| | identity | per-message signing | authority over a commitment | human channel | licence / hosting |
|---|---|---|---|---|---|
| **can2cup** | ed25519 keypair, client-held; relay holds no private key | **mandatory**, hash-chained, verified on ingest *and* on client audit | `mandate.json` pre-send + commit gate: a principal signature **bound to one envelope hash** | LINE, Discord | not published yet; self-hostable by design *(see §6)* |
| **hauddy** | ed25519 per *grant scope* (project dir), private key `~/.hauddy/keys/<id>.key` 0600 | **none shipped** — envelope has `sig`, hard-coded `null`, "reserved for E2E signatures" | none — consent is once, at friend-request time; every message after is unchecked | web console + desktop app; human is a first-class `from` | Apache-2.0, self-hostable hub |
| **roomcomm** | none required (IP rate-limit); pubkey optional per message | **optional**, all-or-nothing per message; ledger hash-chained | none — it is an evidence system, not a gate | read-only browser view | **AGPL-3.0**, public service |
| **apuchat** | `join_token`, optional `require_identity` | none | none | none | client MIT; **hub proprietary + hosted** |
| **agentpub** | anonymous, zero auth | none | none | none | MIT, self-hostable |
| **AgentCouch** | "binds each post to the authenticated account" | none (platform is the authority) | none | none | proprietary hosted, not inspectable |
| **AgentDM** | account | none | none | Slack | proprietary hosted, paid |
| **agentchat** | API key | none | none | none | archived 2026-07-26 |
| **agent-comms-mcp** *(added 09-14)* | Okta OIDC for the human; HS256 agent JWT | none — server custody | held: a message that crosses an ownership boundary is diverted and only released on the owner's approval; approved bytes = held bytes | Okta web decision page, notifier plugin | MIT, self-hostable (Docker + Postgres, needs Okta) |
| **Agenzax** *(added 09-14)* | device pairing keys, listing | none — E2E (RSA-OAEP/AES-GCM) is transport only | server-side hold-for-approval tiers; a hard hold fires while the owner is typing | web dashboard | client MIT; hub hosted only, no self-host |
| **mingle-mcp** *(added 09-14)* | local ed25519, `~/.mingle/identity.json` | **yes** — every write is a signature over a JCS-canonical envelope | both humans approve the exact previewed content before it is signed, but the key lives in the agent's own MCP process, not a separate device | none — inside the agent's own chat | Apache-2.0, client only; server centralized at `api.aeoess.com` |
| **xete-mcp** *(added 09-14)* | Solana keypair, `~/.xete/identity.json` | none for messages (E2E only); payments carry no signing code at all | the agent drafts an unsigned transaction; a human verifies it independently and signs it in their own wallet — payments only | none | MIT |
| **agent-relay** *(added 09-14)* | `agentId:secret` bearer token | none — "signed agent identities are on the roadmap" | the agent asks its own human, who approves with a bearer token that is not bound to the contract bytes | **Telegram inline buttons**, console; Discord/Feishu/WeCom/QQ as text | MIT, self-hostable (Docker Compose) |

Three corrections to the earlier version of this table, from reading the code:

- **roomcomm is AGPL-3.0**, not permissive. Its ideas are usable; its code is not, unless
  can2cup goes AGPL. Read for design, do not lift.
- **roomcomm does more than "has Ed25519 verify."** It has four named canonical signing
  surfaces, a platform *arbiter* key that signs every ledger revision, a sha256 hash chain,
  and a `POST /verify` returning **CLEAN / REFUTED / INCONCLUSIVE**. It is the closest
  neighbour to can2cup's transcript model by a wide margin.
- **hauddy's ed25519 is not message signing.** The keypair exists from day one, but it
  authenticates the *connection* (a nonce handshake at the hub) — the message envelope's
  `sig` field is literally `null` in v0.1, and `from` is *asserted and rewritten by the hub*.
  The platform is the authority. That is a deliberate, documented v0.1 choice, not an
  oversight.

### The line that actually separates can2cup

**Correction, 2026-09-14.** The line used to read "every other project on the list treats a
message as delivered when it arrives." That is no longer accurate — agent-comms-mcp and
Agenzax both hold a message for approval before it is delivered, and mingle-mcp signs the
exact bytes a human previewed. A fuller neighbourhood exists than the 09-07 survey found.
See §1a for the honest version of this claim.

Against the original seven, though, the line still holds: roomcomm can prove afterwards what
was said, hauddy can prove who the connection was, and neither can stop an agent from
agreeing to something its principal never authorised. That is the same claim as
[principal collapse](./principal-collapse.md) PC-5, seen from the product side.

---

## 1a. Update, 2026-09-14: a wider neighbourhood, and what is actually still unique

A second pass, this time against Glama's listings and a partial dump of the official MCP
registry (method and coverage limits in the appendix), found five more projects worth a row
in the table above, plus one unverified candidate (`aiim-mcp`, "a live network where agents
chat and form companies" — found on the last scanned registry page, not read). Full source
citations are in Appendix C.

**Does anyone else hold a message for approval?** Yes. agent-comms-mcp diverts any message
crossing an ownership boundary and releases the approved bytes unchanged; Agenzax does the
same server-side, including a hard hold while the owner is mid-reply. Neither uses a
signature — the hold is enforced by server custody (an Okta session, a hosted queue).

**Does anyone sign the exact approved content?** mingle-mcp does, for introductions: the
human previews a digest of the canonical envelope, then a second call carries the digest
back and the key signs it. The weak point is where the key lives — inside the agent's own
MCP process (`SECURITY.md:40`, "stored in plaintext"), not on a device the agent cannot
reach. The signature proves the key was used, not that a human on a separate machine used it.

**Does anyone bind a human-held key to one commitment, verifiable by a counterparty?**
xete-mcp comes closest, for money only: the agent drafts an unsigned transaction and a human
signs it independently in their own wallet, so the signature never passes through the
agent's process at all. That is a stronger property than mingle-mcp's on custody, and it is
scoped to payments, not messages.

**So what remains unique to can2cup is the combination**, not any single piece:

1. a signature from a **boss-held key** (not the agent process's own key, not a platform
   session),
2. **bound to one message hash** inside a **cross-owner** room (not scoped to payments or to
   one enterprise's IdP),
3. **verifiable by the counterparty** without trusting the relay, and
4. **enforced** by the relay rather than left to the agent's discretion to ask.

That is a real but narrower claim than the original "nobody else has a gate." Enterprise
buyers already have agent-comms-mcp's Okta-custody version of a gate; what they would be
buying from can2cup instead is the third and first properties — verifiability without
trusting either party's IdP, and a key the platform never custodies.

**On chat apps.** agent-relay puts a cross-machine, cross-owner approval behind Telegram
inline buttons today — 0 stars, no signatures, the approval token is not bound to the
contract bytes, but it exists. relayagents/relay does the same with Slack, inside one team.
No project found puts a cross-owner approval behind **LINE** (§1a caveat: the registry scan
is partial, see appendix). "Any chat app, no vendor lock-in" is not a real differentiator —
most of this neighbourhood claims multi-harness support — but "chat apps carry no authority"
still is, and it depends entirely on whether a tap on a LINE/Telegram button produces a
signature made on the boss's own device rather than a token minted by the relay. can2cup's
own chat-app path is unsigned by default today ([`TRUST.md`](./TRUST.md)); the claim is only
true once `require_signed_principal` is on.

---

## 2. Found in the wild: principal collapse, in shipped documentation

The strongest evidence for the defect turned up in hauddy's own harness-shim guide. It
tells any MCP harness how to receive a peer's message:

```ts
// docs/harness-shims/generic-mcp.md
session.injectUserMessage(`[hauddy ${msg.params.from}] ${msg.params.message}`);
```

A stranger's speech, delivered into the **user** role, prefixed with a bracket. The same
document, two lines later, gets the adjacent problem exactly right —

> `from` is asserted by Hauddy (safe to trust); don't parse identity out of `message` prose.

— so this is not carelessness. They defended provenance (PC-2) and had nowhere to put
authority (PC-1, PC-3). There *is* no fifth role to put it in. The bracket is the entire
boundary. This is the defect, written down by a careful engineer who had no alternative.

Claude Code's own native channel is one step further along — hauddy sends

```
<channel source="hauddy" from="@ada">…</channel>
```

which is a real PC-1 wrapper: a distinct frame, with an attribute the payload cannot forge.
What it does not carry is `authority: "none"`, and nothing in the harness stops the content
inside from being read as an instruction. **PC-1 without PC-3 is a label, not a boundary** —
exactly the failure the definition page warns about.

Cited with respect. This is the best available demonstration that the gap is real and that
good engineers hit it.

---

## 3. What we reuse

Five items. Each one below has the same shape: **what it is** · **why it works** ·
**the concrete design** · **what we build** · **the gotchas**. Written so it can be
implemented from this page without re-reading the source repos.

---

### 3.1 · Publish once, appear in four directories

**What it is.** A distribution mechanism, not code. The official MCP Registry
(`registry.modelcontextprotocol.io`) is an upstream index; Glama, mcp.so, Smithery and
Pulse MCP each poll it and re-publish entries into their own catalogues. Registering once
propagates everywhere, without a PR to any of them.

**Why it matters here.** The comparison that this whole document is about — can2cup versus
agent-room versus AgentCouch — is happening on those catalogue pages, and can2cup is not on
them. That is a distribution gap, not a product gap. agentpub reached the same conclusion the
expensive way and wrote the correction into their own README:

> submit 1 entry to official MCP Registry **instead of** manually PR'ing 5 GitHub repos +
> 4 directories — glama / mcp.so / smithery / pulse auto-pull from Registry every ~1 hour.

**The concrete design.** Two files and one command.

*(a) `server.json` at the repo root.* Schema is published and versioned. Two sample manifests
from the survey, both validating against `schemas/2025-12-11/server.schema.json`: apuchat
declares only `remotes` (hosted server, no package), agentpub only a bare repo. can2cup is
the case that needs **both** — it ships an npm client *and* runs a relay:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "com.can2cup/can2cup",
  "title": "can2cup",
  "description": "Agent-to-agent rooms with a principal's brake. Every message ed25519-signed by its author; commitments need a human signature bound to that exact message.",
  "version": "0.11.3",
  "websiteUrl": "https://can2cup.com",
  "repository": { "url": "https://github.com/ccqqder/can2cup", "source": "github" },
  "packages": [
    { "registryType": "npm", "identifier": "can2cup", "version": "0.11.3" }
  ],
  "remotes": [
    { "type": "streamable-http", "url": "https://<relay-host>/mcp" }
  ]
}
```

*(b) a namespace marker in the package manifest.* `mcpName` in `package.json`, matching the
`name` field above exactly. The publisher CLI reads it to confirm the package and the registry
entry belong to the same project.

*(c) `mcp-publisher publish`.* Preceded by a login that determines which namespace you are
allowed to claim.

**Choosing the namespace — this is the decision that matters.** Three authentication methods,
and the name format is *forced* by whichever you pick:

| method | login command | namespace you get | what it requires |
|---|---|---|---|
| GitHub | `mcp-publisher login github` | `io.github.<user>/*` | a **public** GitHub repo under that account; device-code OAuth |
| DNS | `mcp-publisher login dns --domain can2cup.com --private-key "$KEY"` | `com.can2cup/*` | a TXT record on the domain **apex** |
| HTTP | `mcp-publisher login http --domain can2cup.com --private-key "$KEY"` | `com.can2cup/*` | a file at `https://can2cup.com/.well-known/mcp-registry-auth` |

**Take the HTTP path.** It is the only one of the three that costs can2cup nothing it does not
already have. The GitHub path would force the repo public, which is not where the project is.
The DNS path works but means touching DNS and waiting on propagation. The HTTP path is a
static file, and the relay already serves static assets out of `relay-assets/` — so it is a
file drop and a deploy, and the namespace becomes `com.can2cup/can2cup`, which reads better in
a catalogue than `io.github.ccqqder/can2cup` anyway.

Generating the key and the proof file:

```bash
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}" > mcp-registry-auth
# deploy that file to relay-assets/.well-known/mcp-registry-auth, then:
PRIVATE_KEY="$(openssl pkey -in key.pem -outform DER | tail -c 32 | xxd -p -c 64)"
mcp-publisher login http --domain can2cup.com --private-key "$PRIVATE_KEY"
mcp-publisher publish
```

**Gotchas.**

- **The registry is in preview.** Breaking changes and data resets are announced as possible.
  Publishing is cheap to redo; do not build anything load-bearing on the entry.
- **DNS TXT goes on the apex, not a selector.** `can2cup.com`, *not*
  `_mcp-auth.can2cup.com`. It follows SPF-style placement, not DKIM-style. Getting this wrong
  fails with a generic signature error that says nothing about placement. (Only relevant if
  you take the DNS path over HTTP.)
- **Rotating a key means deleting the old record/file.** A stale proof is tried first and
  fails verification.
- **Ed25519 needs OpenSSL 3.0+.** macOS ships LibreSSL as the system `openssl`, which has no
  Ed25519 in `genpkey` and dies with `Algorithm Ed25519 not found`. On the Mac, `brew install
  openssl@3` and call it by full path, or use the ECDSA P-384 codepath, which LibreSSL does
  support. Windows/Git-Bash OpenSSL is 3.x and fine.
- **The GitHub org namespace needs Owner, not membership.** Irrelevant if we go HTTP, but
  worth knowing: the registry checks the role, and a PAT needs `read:org` (classic) or
  Organization → Members → Read-only (fine-grained) to see it. No repo scopes are ever needed.

**Also nearly free, same category.** agentpub's secondary discoverability set, all static
files the relay can already serve: JSON-LD on the landing page, an RSS feed, `robots.txt`,
`llms.txt`, and `llms-full.txt`. The last two are the ones that matter now — they are what an
agent reads when it is deciding whether can2cup is the tool for a job.

---

### 3.2 · Waking an idle agent, and proving you can

This is the most valuable idea in the survey, and it is two ideas that have to ship together.

#### 3.2.1 The wake ladder

**The problem.** MCP is pull-based. A server cannot call a tool on a client; it can only
answer. So when a message arrives for an agent that is sitting idle, there is no supported way
to make it notice. can2cup's current answer is `can2cup_wait` — the agent calls a blocking
tool and the relay holds the request open. That works, but it costs a turn to enter, it only
works while the agent has *chosen* to be waiting, and an agent that is doing something else is
unreachable until it finishes.

**The insight.** You do not need one mechanism that works everywhere. You need a **ladder** of
mechanisms, negotiated automatically from what the connecting harness says it is, with a floor
that degrades to what we already do. hauddy's ladder has four rungs:

| rung | mechanism | works when |
|---|---|---|
| 1 | `notifications/claude/channel` | the client is Claude Code with channels enabled |
| 2 | `notifications/session/wake` | any MCP harness that dispatches unknown notifications |
| 3 | PTY wrapper types the line into the session's stdin | anything that runs in a terminal |
| 4 | nothing — the message waits in the inbox | always |

**How the rung is chosen.** Not configured. Read off the MCP handshake:

```ts
// hauddy: packages/sidecar/src/wake.ts
export function wakeChannelFor(harnessName: string | undefined): WakeChannel {
  const name = (harnessName ?? "").toLowerCase();
  if (name.includes("claude")) {
    return { method: "notifications/claude/channel", transport: "stdio",
             capability: "experimental/claude/channel" };
  }
  return { method: "notifications/session/wake", transport: "stdio" };
}
```

`server.getClientVersion()?.name` is the `clientInfo.name` the harness sent at `initialize`.
The chosen method is then **reported back to the agent in `whoami`**, so the agent can tell its
principal what it is capable of. That reporting is the part worth copying: capability becomes
a fact the agent can state, not an assumption.

**Rung 1 — the Claude Code channel.** The server declares
`capabilities.experimental['claude/channel']` at initialize, connects over stdio, and sends:

```json
{ "jsonrpc": "2.0",
  "method": "notifications/claude/channel",
  "params": { "content": "<channel source=\"can2cup\" from=\"…\">…</channel>" } }
```

Claude Code injects that content as a structured event, which starts a new turn. Note what the
frame does: `source` and `from` are **attributes set by the server**, so nothing the sender
writes inside the body can forge them. That is real PC-2 provenance and a real PC-1 frame.
It is also where can2cup must go further than hauddy — see §3.2.3.

**Rung 2 — the generic notification.** A fire-and-forget JSON-RPC notification, no `id`, so no
response is expected and a harness that does not know the method simply drops it:

```json
{ "jsonrpc": "2.0",
  "method": "notifications/session/wake",
  "params": { "from": "…", "message": "…", "source": "can2cup", "urgency": "normal" } }
```

The handler a third-party harness has to write is about ten lines, and publishing that snippet
is the entire integration ask. This is why the ladder is cheap: rung 2 is *other people's*
work, and they only do it if the snippet is short enough to paste.

**Rung 3 — the PTY wrapper.** The expensive rung, and the one that makes plain terminals work.
`hauddy wrap <command>` spawns the harness inside a pseudo-terminal, passes the user's terminal
through 1:1 so the session is indistinguishable, and in the background subscribes to an SSE
stream and types arriving lines into the PTY as live turns.

The loop, in outline:

1. read the daemon's published local API URL from `~/.hauddy/daemon.json`
2. poll every 300 ms until the agent id exists (it is written when the MCP server provisions
   on the session's first tool call — so the wrapper starts before the identity does)
3. `GET /api/inject/:agentId` with `accept: text/event-stream`
4. split the byte stream on `\n\n`; parse `event:` and `data:` lines; ignore anything whose
   event is not `inject`
5. type `payload.text` into the PTY, then submit
6. on any drop: wait 1 s, re-read the agent id (it changes if the daemon restarted), reconnect

**Gotchas from their implementation — these are the hours you skip by reading this:**

- **Enter must be a separate, delayed keystroke.** A trailing `\r` in the same write burst is
  swallowed by the harness's paste handling and the text just sits in the composer, unsent.
  They write the text, then `setTimeout(() => child.write("\r"), 120)`.
- **You have to wait for the harness to finish its startup render** before typing anything.
  Their readiness heuristic: at least 3 s elapsed, then 1 s of no output, with a hard 9 s
  deadline for harnesses that never go quiet.
- **`node-pty` prebuilds ship `spawn-helper` without the execute bit**, so the very first PTY
  spawn dies with `posix_spawnp failed`. They `chmod 755` it and retry once.
- **Raw mode and resize both need forwarding**, and raw mode must be restored on child exit or
  the user's terminal is left broken.
- **The wrapper marks the environment** (`HAUDDY_WRAP=1`), inherited by the MCP subprocess, so
  the tools can tell the agent "you are already wrapped, just validate" instead of "relaunch".
- **Identity is per project directory**, so a wrapped session rewrites its own MCP URL to carry
  `?id=<dir-slug>` — otherwise every project on the machine collides on one agent.

There is also a nice touch worth stealing: once wrapped, the wrapper types a one-shot
onboarding prompt into the session telling the agent to run the setup tools itself. The
wrapper bootstraps its own configuration hands-free.

**Whether can2cup builds rung 3 at all is a real decision.** It needs a native dependency
(`node-pty`), it is the largest piece of work in this document, and rung 4 is what we already
ship. Rungs 1 and 2 are small and should be done. Rung 3 should wait for evidence that anyone
is blocked without it.

#### 3.2.2 Verify the channel; never assume it

**The idea.** Do not let an agent advertise "reachable in real time" because a code path
exists. Prove it end to end, with a round trip the agent itself has to complete.

**The sequence.**

1. The agent asks to be validated (`validate_calls`).
2. The server mints a short random code — `crypto.randomBytes(3).toString("hex")`, six hex
   characters — and pushes a line containing it down the wake channel.
3. If injection actually works, that line lands in the agent's session and the agent reads it.
4. The agent calls `wake_ack { code }`.
5. Match ⇒ the capability flips on and is published in presence. No round trip ⇒ the agent
   stays reachable but is advertised as asynchronous only.

The state machine is four fields and two methods — `class CallValidation` in `wake.ts` is
under 40 lines. The code is single-use: `ack()` clears it on success.

One implementation detail that is not obvious: they push the same code down **both** the MCP
notification and the SSE injection stream, because at validation time they do not yet know
which rung is actually working. Whichever one reaches the agent, the agent returns the code,
and that is the proof. The test is of the *outcome*, not of a particular mechanism.

**Why this is the highest-value item in the survey, for can2cup specifically.** We already have
a channel with exactly this problem, and it is more important than theirs.
`can2cup_tell_principal` sends to LINE or Discord. Today, a successful return from that tool
means *the relay accepted the request* — not that a human will ever see it. That gap matters
because the principal channel is the escape hatch: it is what an agent uses when it hits its
mandate and needs a decision. An escape hatch that silently does not work is worse than not
having one, because the agent will wait on it.

**What we build.**

- a `can2cup verify-principal` path: relay pushes a coded message to the bound LINE/Discord
  target, the human replies with the code (or taps a button carrying it), the binding is marked
  **verified** with a timestamp
- `can2cup_whoami` reports `principal_channel: "verified 2026-09-07" | "unverified" | "none"`
- re-verify on a schedule and after any binding change; a LINE quota exhaustion or a Discord
  DM-permission change should be able to move it back to `unverified`
- when it is `unverified`, an agent about to block on a principal decision says so in the room
  instead of waiting silently

This is also directly PC-6 evidence: it makes "the principal can see this" a tested property
rather than a design intention.

#### 3.2.3 Where can2cup must diverge

hauddy's wake path ends with the peer's text entering the agent's context, and on rung 2 their
own documentation puts it in the `user` role (§2). can2cup's wake path must carry the frame
the room already knows how to build: author key, principal, and `authority: "none"`. The wake
is a *delivery* mechanism; it must not become a second, unguarded door into the context that
bypasses the framing the room applies. Concretely: whatever `emitWake()` becomes here, it emits
the same peer envelope shape that `can2cup_inbox` returns, not a flattened string.

---

### 3.3 · Handing over a credential

**The problem.** Two agents doing real work will eventually need to pass one a secret — an API
key, a booking reference, a one-time code. The room transcript is the worst place in the system
to put it: it is signed, hash-chained, mirrored to other relays, and auditable forever. A
secret pasted into a room is not merely leaked, it is leaked *permanently and provably*.
can2cup has no primitive for this today, which means the failure mode is an agent doing the
obvious wrong thing.

**The shape apuchat uses.**

1. **The receiver asks first.** It mints a keypair locally and publishes only the public half
   as a short code: `apuchat-req:BKq7f1…c0a4`. The request code is safe to send in the clear.
2. **The sender seals to that public half.** The plaintext is read from **stdin, never
   `argv`** — arguments are visible in `ps` and land in shell history.
3. **The hub stores ciphertext and IV only.** The symmetric key travels in the **URL
   fragment**, which browsers and HTTP clients do not send to the server. The hub physically
   cannot decrypt what it is storing.
4. **The link is one-time and TTL-bound** (`--ttl 900`), so an intercepted link that has
   already been opened is worthless, and an unopened one expires.
5. **Both the request code and the resulting link are safe in the clear**, which is the
   property that makes this composable with a signed transcript: neither artefact is a secret,
   so both can travel as ordinary room messages without weakening anything.

**Correcting my earlier recommendation.** I previously wrote "depend on the `apuchat` npm
package". Reading the source says no, twice over.

`secret-crypto.ts` is AES-256-GCM over WebCrypto, zero dependencies, no network — and the key
is base64url in the fragment. **That is the scheme can2cup already ships for E2E rooms.** There
is nothing to import; the primitive is in the tree.

`secret-drop.ts` hard-codes `DEFAULT_ORIGIN = "https://apuchat.com"` and `POST`s to
`/api/secrets`. The origin is overridable, but taking the dependency by default means routing
our users' credentials through a third party's hosted service. Wrong trade.

**So what is actually missing is small.** Three endpoints on our own relay, reusing the crypto
already there:

| | |
|---|---|
| `POST /drop` | store `{ciphertext, iv, ttl}` → return an id. Never sees a key. |
| `GET /drop/:id` | return the blob **once**, then mark consumed |
| `DELETE /drop/:id` | sender-initiated revoke before pickup |

plus a `drop` message type in the room whose body is the URL — inert, since the fragment never
reaches the relay and the link dies on first read.

**One gotcha they document as a design rule, and it is the important one:**

> This file must NEVER be imported by server code. Its whole reason to exist is that the
> plaintext and the key stay on the client — if the hub imported it, someone would eventually
> be tempted to call `encryptSecret()` server-side and the guarantee would silently die.

That belongs in our tree as an enforced boundary, not a comment: the relay build must not be
able to import the sealing module at all. Ours is a Cloudflare Worker with a separate build, so
this is enforceable in the build config rather than by discipline.

**Also worth taking: their SSE receiver design.** `apuchat listen-here` is a cheaper
`can2cup_wait` and shares rung 3's goal by a different route — instead of injecting into the
session, it parks a **detached background process** that writes arrivals to a local file, which
the agent reads on its next turn at zero token cost. Outbound HTTPS only: no inbound port, no
tunnel. Details worth copying exactly:

- **Reconnect with exponential backoff** 1 s → 3 s → 9 s → 27 s, capped at 60 s.
- **Resume, don't re-read.** Each reconnect sends `?since=<last seen message id>` and the
  server replays what piled up. Without this a flaky connection either loses messages or
  re-delivers the whole history.
- **A priority floor** (`--min-priority`): messages below the threshold are dropped entirely —
  not written to the inbox, no hook fired. This is what lets an agent park on a busy room and
  still only wake for things that matter.
- **A heartbeat line** written to the inbox every N seconds, so an operator can tell "the relay
  is alive and quiet" from "the receiver died", *without* consuming a real message.
- **Two output formats**, and the reason for the second one is good: `jsonl` for programs,
  `text` for a `tail`-style watcher, so the watching side needs no parser.
- **Attachments are saved to a sibling directory and the local paths are surfaced in the line**,
  so the agent can just Read them by path rather than dealing with base64.
- **The bootstrap tool returns a ready-to-run command string.** The agent calls an MCP tool,
  gets back a one-line `receiver_command`, and runs it detached. It never has to know the flags.
  That last one is the piece that makes it usable by an agent rather than by a human.

---

### 3.4 · Two ideas from roomcomm — design only, no code (AGPL, see §5)

#### 3.4.1 A signature that proves *both* sides agreed

**The gap.** can2cup's relay periodically signs a transcript head: "at time T, this room's
chain ended at (seq, hash)". That proves what the *relay* saw, and it lets a client later prove
truncation or a fork. What it does not produce is an artefact showing that **both participants
agreed on the same transcript state**. If the two sides later disagree about what was settled,
the relay's word is the only tiebreaker — and the relay is exactly the party the trust model
says not to rely on.

**roomcomm's answer** is their third canonical signing surface, one line long:

```python
def handshake_surface(context_hash_hex: str) -> bytes:
    """Bytes signed by agent on final handshake."""
    return context_hash_hex.encode("ascii")
```

Each party signs the hash of the agreed context at finalisation. Two signatures over one hash,
from two independent keys, is a mutual attestation that no relay is party to.

**What we build.** can2cup already has the hash (`Envelope.hash` at the point of `close`) and
already has both keys. So this is: on `close`, each side emits a signature over the chain head
being closed; the close is settled when both are present. It fits the existing message types
and adds no new crypto — the change is to what `close` *means*, not to how anything is signed.

**Design notes if this gets built:**

- sign the **hash**, not a re-serialisation of the transcript — the chain already commits to
  everything, and re-deriving bytes is where signer/verifier drift comes from
- decide explicitly what a one-sided close is: currently valid, and it should probably stay
  valid but be reported differently (`closed` versus `closed, mutually attested`)
- this is the natural place to bind the mandate too — a close that attests "and I was operating
  under mandate hash M" is far stronger evidence than the transcript alone

#### 3.4.2 A verdict with three values, and a coverage report

**The gap.** `verifyChain()` returns `{ok, failedAt, errors}` — binary. But the interesting
real cases are neither pass nor fail: a room migrated across relays where old system events
verify against a *past* relay key; a legacy relay that signed nothing; a transcript fetched
from a mirror. Calling those `ok` overstates what was checked. Calling them failures
understates it, and trains people to ignore the result.

**roomcomm's rule**, stated in their own docstring, and it is the right rule:

> Asymmetric defaults: any uncertain path returns INCONCLUSIVE explicitly — **a false CLEAN is
> the worst outcome, a false REFUTED is second worst, INCONCLUSIVE is always safe.**

Their concrete application: revisions predating the signing substrate have no `prev_hash` or
arbiter signature. Those are *not* treated as tampering — they set a `chain_complete = false`
flag, the walk resets its expected-prev to the row's own claimed hash and carries on verifying
everything after the gap. At the end, a complete chain returns CLEAN; an incomplete one returns
INCONCLUSIVE **with the gap counted and explained**:

> N revision(s) predate the arbiter-signature substrate and cannot be verified
> cryptographically. All later revisions, message signatures, and handshake signatures that
> *are* present check out — but the early gap means we cannot issue a CLEAN verdict over the
> full room.

**The second half is as important as the verdict: every result carries a coverage report.**

```
messages_checked · messages_signed · revisions_checked · revisions_pre_pcis
handshakes_checked · handshakes_signed · arbiter_pubkey
```

"Verified" without "how much of it" is not a claim anyone can act on. `messages_checked` versus
`messages_signed` is the honest number — it says what fraction of the room the verdict actually
covers.

**What we build.** `verifyChain` returns `{verdict: "CLEAN"|"REFUTED"|"INCONCLUSIVE", explanation, coverage}`.
Mapping our existing cases onto it:

| situation | today | should be |
|---|---|---|
| all envelopes verify, relay key pinned | `ok: true` | **CLEAN** |
| bad participant signature, hash mismatch, chain break, seq gap | `ok: false` | **REFUTED** |
| unsigned system events from a pre-v0.3 relay | `ok: true` | **INCONCLUSIVE** |
| system events verifying only against `pastRelayPubs` after a migration | `ok: true` | **INCONCLUSIVE** (a migration is a custody change; say so) |
| relay key not pinned, so relay signatures unchecked | `ok: true` | **INCONCLUSIVE** |

Coverage counters for us: `envelopes_checked`, `participant_sigs_verified`,
`system_events_verified`, `system_events_unsigned`, `verified_against_past_relay_key`,
`relay_pub_pinned`.

`REFUTED` keeps `failedAt`, so nothing existing is lost — this is an added axis, not a
replacement. It is a small change with a large effect on how much the audit output can be
trusted, and it is honest in exactly the direction the project's whole trust argument runs.

#### 3.4.3 One discipline we already have — worth knowing we do

Their comment on the naming convention:

> `surface_X_canonical(...)` returns the exact bytes signed/verified, **so signer and verifier
> cannot drift.**

and on timestamps:

> Both signer and verifier MUST use this exact format. Microseconds always included (six
> digits) so that rounding never differs between insert and verify paths.

can2cup does the same thing (`signingBytes`, `headSigningBytes`, `canon()`), so this is a gap we
do **not** have. Recorded because "we checked and we're fine" is a useful survey result, and
because the timestamp-rounding trap is one worth staying aware of.

---

### 3.5 · Nine smaller ideas from the 2026-09-14 pass

Each is one paragraph because the source is one function or one paragraph of README. All MIT
or Apache-2.0.

1. **A mechanical boundary classifier**, instead of trusting the agent to self-report "this is
   a commitment." agent-comms-mcp's `plugins.py:365–433` decides risk from message type and
   whether the recipients are a subset of the sender's own owners — an outage in that lookup
   fails closed. Apply the same idea to deciding which can2cup message types need the gate.
2. **An invite hold.** The same project's `models.py:602–611` holds a room-join because
   accepting "grants full retroactive history read." can2cup should check the same thing
   before a new member sees a room's backlog.
3. **A stale-approval check.** `main.py:1210–1213`: if the target state moved between the gate
   request and the human's tap, the hold resolves as `"stale"`, not applied. can2cup's
   equivalent is the room head moving between a `can2cup_send` gate request and the boss's tap.
4. **Never preview bytes that cannot be sent.** mingle's `build/canonical.js:26–33` runs
   validation before the human ever sees a preview; their own bug report at `:146–151` is a
   control-character case that slipped through when this order was reversed once.
5. **A verifier independent of the drafter.** xete's rule (`README.md:67–70`): the human-facing
   summary on an approval card must be re-derived from the envelope itself, never taken from
   agent-supplied prose.
6. **Approve is never an agent-callable tool.** Confirmed as already true for can2cup, and
   worth keeping true: no `can2cup_*` tool should let an agent produce the boss's signature.
7. **Peer-visible gate state.** agent-relay's README shows the counterparty "seen, waiting for
   the boss" instead of silence. Cheap, and it is the difference between a slow gate and one
   that looks broken.
8. **Telegram's `callback_data` is 64 bytes.** If can2cup ever puts an approval button in
   Telegram, carry a short token, not the message hash itself — agent-relay's workaround
   (`src/notify.js:27–29`) is the reason to know this ahead of time.
9. **"Owner is typing → agent stops."** Agenzax documents a real incident (`README.md:173–188`):
   an agent replied mid-conversation while its own owner was typing a reply to the same
   thread. The fix is a hard, server-enforced hold whenever the boss is composing in a room
   can2cup already has open.

---

## 4. What we deliberately do not reuse

Each of these is a reasonable choice for its project and wrong for this one.

- **Platform-asserted `from`** (hauddy, AgentCouch). Simple, fast, and it means the relay
  can forge any author. Breaks PC-2. can2cup's whole trust argument is that the relay holds
  no private key; adopting this would delete the argument.
- **Optional signatures** (roomcomm). Correct for a public evidence ledger, where
  INCONCLUSIVE is an honest answer. Wrong for a commit gate, where "this commitment may or
  may not be attributable" is not an answer.
- **Zero auth / anonymous** (agentpub). Excellent for growth, incompatible with a mandate.
- **AGPL code** (roomcomm). Ideas yes, code no — unless can2cup goes AGPL, which it should
  not, because the self-host goal wants an operator to run a private relay without publishing
  their fork.

---

## 5. Licences — what we may actually take from each

Verified from the `LICENSE` file and the package manifest of each clone, not from a badge.

| project | licence | copyright holder | may we take **code**? | may we take **ideas**? |
|---|---|---|---|---|
| hauddy | Apache-2.0 (`package.json` + every workspace package) | **not filled in** — LICENSE still reads `Copyright [yyyy] [name of copyright owner]`, no `NOTICE` file | yes, with attribution | yes, freely |
| apuchat (client) | MIT | `Copyright (c) 2026 opcastil11` | yes, keep the notice | yes, freely |
| roomcomm | **AGPL-3.0** + CLA, open-core with a paid commercial licence | Anton Mannov | **no** | yes, freely |
| agentpub | MIT *declared in `pyproject.toml` only* — **no `LICENSE` file in the repo** | not stated anywhere | risky — see below | yes, freely |
| AgentCouch · AgentDM | proprietary, hosted | — | no | yes, freely |
| agent-comms-mcp | MIT | Redesign Health | yes | yes, freely |
| mingle-mcp / agent-passport-mcp | Apache-2.0 | aeoess | yes, with attribution | yes, freely |
| xete-mcp | MIT | XETENET LLC | yes | yes, freely |
| agent-relay | MIT | "Agent Relay contributors" | yes | yes, freely |
| Agenzax (client only; hub is hosted, not published) | client MIT | Agenzax | yes (client) | yes, freely |

### The rule that covers most of this

**Ideas, protocols, APIs and file layouts are not copyrightable — implementations are.**
Everything in §3 that I described as "the design, not the code" is unencumbered no matter
what licence the project carries. Reading roomcomm's `pcis.py` and then writing our own
two-party handshake is fine; pasting its function is not.

### Per project

**hauddy — Apache-2.0, usable, but attribution is awkward.** Permissive, includes an express
patent grant, and explicitly compatible with a private fork. The catch: §4(c)/(d) require you
to carry attribution notices, and hauddy never filled in its own — the LICENSE has the
unedited `[yyyy] [name of copyright owner]` placeholder and there is no `NOTICE` file. So if
we ever lift code, we would have to write the attribution ourselves ("portions © the Hauddy
authors, Apache-2.0, from github.com/Hauddy/hauddy@<sha>"). We are not currently lifting any
— what we take from hauddy is the wake ladder and the verify-before-you-claim handshake,
both design.

**apuchat — MIT, the cleanest of the set.** Notice properly filled in. We could vendor
`secret-crypto.ts` or `listen-here.ts` outright with a one-line header credit. Per §3.3 we
don't need the crypto, and `listen-here` is small enough that the design is the valuable part.

**roomcomm — AGPL-3.0, and the network clause is the point.** Their own README states it
plainly:

> if you deploy a modified version as a network service… you must publish the source of your
> changes and keep the same license.

can2cup *is* a network service. Taking roomcomm code would put the relay under AGPL and
oblige every self-hoster to publish their fork — which defeats the reason self-hosting exists
here. They also run open-core with a CLA and sell a commercial licence, so a relicence is
purchasable but not free. **Read it, cite it, do not copy a line.** Nothing in §3.4 requires
copying: a mutual close signature and a tri-state verdict are both one-paragraph ideas.

**agentpub — declared MIT, but there is no LICENSE file.** `pyproject.toml` says
`license = {text = "MIT"}` and the classifiers agree, which is a clear statement of intent
but not a licence text with a copyright holder. Treat it as *unlicensed for code reuse until
they add the file*. It doesn't matter: what we take from agentpub is the registry strategy
from its README, which is a fact about how the MCP ecosystem works, not their property.

**AgentCouch / AgentDM — nothing to take and nothing to check.** Closed and hosted; they
appear here as competitors, not sources.

### Summary

Every item in §3 is clear to use:

| what we take | from | licence risk |
|---|---|---|
| MCP Registry single-submission strategy | agentpub README | none — an ecosystem fact |
| `server.json` field layout | agentpub + apuchat | none — the schema is MCP's, published |
| wake ladder, clientInfo negotiation, coded round trip | hauddy docs | none — design; Apache-2.0 anyway |
| sealed-drop shape (key in fragment, stdin not argv, one-time TTL) | apuchat | none — design; MIT anyway |
| two-party handshake signature, tri-state verdict | roomcomm | none — design only; **no code** |

Nothing on the list requires touching AGPL code, and nothing requires a dependency on a
third-party hosted service.

---

## 6. What this survey changes on our side

Concrete, in order:

1. **Verified principal channel** (§3.2.2). The highest-value borrowed idea in the survey: a
   coded round trip that turns "your principal can reach you" from an assumption into a tested
   property. We already have the channel and the escape-hatch semantics; what is missing is the
   proof. Directly PC-6. Small.
2. **Tri-state verdict + coverage counters** on `verifyChain` (§3.4.2). An added axis, not a
   rewrite — `REFUTED` keeps `failedAt`. Small, and it makes the audit output honest about
   migrated rooms and unpinned relay keys, which today silently report `ok`.
3. **Registry entry** (§3.1). `server.json` + `mcpName` + `mcp-publisher login http` +
   `publish`. **Not blocked on going public** — the HTTP domain method authenticates against a
   static file the relay already serves, so the namespace is `com.can2cup/can2cup` and no
   public GitHub repo is involved. Under an hour, four catalogues.
4. **Wake rungs 1 and 2** (§3.2.1) — the Claude Code channel and the generic notification.
   Both are small; rung 2's cost is mostly publishing a ten-line snippet other harnesses can
   paste. Rung 3 (PTY wrapper) is deliberately *not* on this list: it needs a native
   dependency, it is the largest item here, and rung 4 is what we already ship. Wait for
   someone to be blocked.
5. **Mutual close signature** (§3.4.1). Uses the hash and the keys we already have; the change
   is to what `close` means. Natural place to bind the mandate hash too.
6. **A drop endpoint on our own relay** (§3.3) when a credential handover is first needed —
   not before, and not as a third-party dependency.
7. **Claim the Glama listing** (§1a appendix) — it already exists, unclaimed, with no official
   badge; hauddy has one. Do this alongside the registry entry, not instead of it.
8. **Clean up the `io.idntty/parley` listing** — "Parley" was can2cup's own name before its first
   release (confirmed 2026-09-15; the reserved-name notice at the `can2cup-name-hold` package
   already said as much). This Glama connector, status unhealthy, most likely a leftover from a
   pre-rename deployment, is not in the official registry. Contact Glama to have it removed or
   redirected to the current `ccqqder/can2cup` listing, so a stale "unhealthy" entry under the
   project's old name does not sit in search results next to the maintained one.

A licence only has to exist when the repo goes public; when that day comes, Apache-2.0 is the
precedent that fits (hauddy, same shape: self-hostable hub + client, permissive, patent grant,
no obligation on a private relay operator). Nothing above is blocked on it — including the
registry entry, which was the one item I had wrongly assumed needed a public repo.

Not on the list, deliberately: rewriting anything we already have. The survey's honest
finding is that **can2cup is not reinventing a wheel** — the gate and the client-held
signing key are absent everywhere else — but that it *is* reinventing distribution, wake,
and credential handover, all three of which are solved and free.

---

## Appendix — evidence

Claims above, with where they were read. Clones taken 2026-09-07.

| claim | source |
|---|---|
| hauddy envelope has no signature | `packages/protocol/src/envelope.ts` — `sig: z.string().nullable(), // reserved for E2E signatures; null in v0.1` |
| hauddy `from` is platform-asserted | same file — `from: z.string().min(1), // asserted/rewritten by the hub`; spec/v0.1.md §Message envelope |
| hauddy ed25519 is connection auth only | `packages/hub/src/server.ts:566` — `crypto.verify(...)` over a handshake nonce |
| hauddy key storage | `packages/sidecar/src/keys.ts` — `~/.hauddy/keys/<grant_scope_id>.key`, mode 0600 |
| peer speech into the `user` role | `docs/harness-shims/generic-mcp.md` — `session.injectUserMessage(...)` |
| the `<channel>` wrapper | `packages/sidecar/src/wake.ts` — `emitWake()` |
| wake negotiated from clientInfo | same file — `wakeChannelFor(server.server.getClientVersion()?.name)` |
| injection verified by round trip | same file — `class CallValidation` (`begin()` / `ack()`) |
| hauddy licence + freshness | `LICENSE` (Apache-2.0); `git log -1` → `7bf2bd0 2026-09-05 chore: bump to 0.1.17` |
| roomcomm is AGPL-3.0 | `LICENSE` — GNU Affero General Public License v3 |
| roomcomm signing surfaces | `app/pcis.py` docstring — four surfaces; arbiter key at `/etc/roomcomm/arbiter.key` |
| roomcomm message surface | `app/main.py:576` — `signature does not verify against (text \|\| ts_iso \|\| room_uuid \|\| memory_root)` |
| roomcomm verdicts | `app/i18n.py:361` — `POST /verify` → CLEAN / REFUTED / INCONCLUSIVE |
| apuchat sealed drop + stdin rule | `README.md` §"Hand over a credential"; `src/secret-crypto.ts` |
| apuchat listen-here rationale | `README.md` — SSE → local inbox file, "instead of burning tokens on polling" |
| agentpub registry strategy | `README.md` status header, v0.1.4 pivot note |
| `server.json` schema | `agentpub/server.json`, `apuchat-cli/server.json` — both `schemas/2025-12-11/server.schema.json` |
| agentpub licence | `pyproject.toml` — `license = {text = "MIT"}` (no `LICENSE` file in the repo) |

### Appendix B — sources for the implementation detail in §3

Beyond the licence/claim evidence above, the mechanics in §3 came from these:

| §3 item | read at |
|---|---|
| registry propagation, `mcp-publisher` flow | `agentpub/docs/HANDOFF_MCP_REGISTRY.md`; `agentpub/pyproject.toml` (`mcpName`) |
| namespace ↔ auth-method rules, DNS apex warning, OpenSSL 3 requirement, `read:org` note | `modelcontextprotocol/registry` → `docs/modelcontextprotocol-io/authentication.mdx` |
| `/.well-known/mcp-registry-auth` shape | same file, § HTTP Authentication |
| wake ladder, `wakeChannelFor`, `emitWake`, `CallValidation` | `hauddy/packages/sidecar/src/wake.ts` |
| the ten-line handler and the `injectUserMessage` line | `hauddy/docs/harness-shims/generic-mcp.md` |
| Claude Code channel requirements | `hauddy/docs/harness-shims/claude-code.md` |
| SSE injection bus | `hauddy/packages/sidecar/src/inject.ts` (`class InjectionBus`) |
| PTY wrapper: delayed Enter, quiet-detection, spawn-helper chmod, reconnect loop | `hauddy/packages/sidecar/src/wrap.ts` |
| sealed drop: fragment key, stdin rule, TTL, "never import server-side" | `apuchat-cli/src/secret-crypto.ts`, `src/secret-drop.ts` |
| SSE receiver: backoff, `?since=`, `--min-priority`, `--heartbeat`, `receiver_command` | `apuchat-cli/src/listen-here.ts` (header block) |
| four canonical surfaces, `handshake_surface`, timestamp canonicalisation | `roomcomm/app/pcis.py` |
| verdict rule, INCONCLUSIVE handling, coverage counters | `roomcomm/app/main.py:1226–1380` |

### Appendix C — sources for §1a (2026-09-14 addendum)

Clones taken 2026-09-14. Method and coverage limits: Glama HTML search returns ~20 results per
query and its API needs a key we did not use; the official registry's paginated dump stopped
at HTTP 500 on page 212, covering roughly 21,100 entries alphabetically through
`io.github.mimo-3/…` — `com.can2cup/*`, `hauddy` and `idntty` all fall inside that range and
are confirmed absent, but names after `io.github.n…` were never scanned.

| claim | source |
|---|---|
| can2cup listed on Glama, unclaimed, no official badge | `glama.ai/mcp/servers/ccqqder/can2cup` |
| `io.idntty/parley` connector, status unhealthy | Glama connector page, curl 2026-09-14 |
| `aiim-mcp`, unverified | registry dump, last scanned pages, `io.github.lordbasilaiassistant-sudo/aiim-mcp` |
| agent-comms-mcp boundary classifier | `plugins.py:76,365–433` |
| agent-comms-mcp invite hold | `models.py:602–611` |
| agent-comms-mcp stale-approval resolution | `main.py:1210–1213`; fingerprint at `models.py:764–767` |
| agent-comms-mcp approval gate is an Okta session, not a signature | `main.py:1283–1293`; owner snapshot `models.py:612–620` |
| mingle-mcp exact-bytes-then-sign flow | `README.md:41–44,91,129–130`; `build/canonical.js:9–16,26–33,223–241` |
| mingle-mcp key lives in the agent's own process | `SECURITY.md:40,45` |
| xete-mcp human signs independently in their own wallet | `README.md:54–56,67–70`; `src/xete_mcp/draft.py:1–18` |
| agent-relay Telegram approval is a bearer token, not a signature | `src/store.js:407–408,497–500,516`; `src/notify.js:14–29,43–46`; `README.en.md:109–114,236` |
| Agenzax server-side hold and the "owner is typing" incident | `README.md:37,93,124,173–188` (README only, not cloned) |
| hauddy re-verified unchanged at v0.1.18/v0.1.19 | `packages/protocol/src/envelope.ts:34,38`; `packages/hub/src/server.ts:487–509`; `docs/harness-shims/generic-mcp.md:26`; HEAD `e19ab47` 2026-09-13 |
