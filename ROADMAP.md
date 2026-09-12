# Roadmap & contribution map

can2cup is a **proof of concept for a paradigm**, not a finished security product. The idea it exists to
demonstrate: when two people each delegate to an AI agent, and those agents negotiate on their behalf, the
safety that matters comes from **structure around the agents — a principal's brake, a signed record, a
revocable grant — not from hoping the agents are smart enough to resist manipulation.** (Background: the
*parenting-agent* essays, https://peachpitboat.com/zh-tw/posts/parenting-agent/.)

The bar for the POC is **usable-minimum**: enough that two agents can hold a signed conversation under their
principals' mandates, and a person can audit and revoke. That bar is met. Several things are deliberately
left as **nice-to-have** — genuinely valuable, but past the minimum, and some of them (the cryptography in
particular) want expertise this project does not claim to have. They are written down here so that when the
repo opens, a contributor can see exactly what to build and where it plugs in.

**How to read the status tags:** ✅ done · 🟡 partial (spec or primitives exist, surface does not) ·
⬜ not started · 🔒 gated (must not merge into `src/protocol` until a precondition is met).

---

## What the POC already does (✅)

- **Signed rooms.** Every message is an ed25519-signed, hash-chained envelope; `verifyChain` gives a
  three-value verdict (CLEAN / REFUTED / INCONCLUSIVE) with explicit coverage counts. (`src/protocol/envelope.ts`)
- **The principal's brake.** `checkMandate` runs on every outbound message, at both the local client and the
  hosted relay, from **one shared implementation** so the two floors cannot drift. It caps amount, scope,
  currency, grant lifetime, and literal disclosures. (`src/protocol/mandate.ts`)
- **Self-preservation list** (parenting-agent §1). The brake rises from *amount* to *decision type*: the
  principal names the message types the agent may never send alone (`require_confirm`), and they are held
  for a signed go-ahead however persuaded the agent is. (`demo:self-preservation`)
- **Adversarial robustness** (parenting-agent §1). Outbound: a fully-persuaded agent is still contained by
  `checkMandate`. Inbound: a hostile peer's display name / room title / message body cannot forge the
  structure the agent reads (`src/mcp/framing.ts`). (`demo:adversarial`)
- **Revocable + auditable** (parenting-agent §1). Signed `revoke` withdraws a `grant`; the authority ledger
  (grants − revokes − expired) replays what a counterparty holds from you; a relay-signed head makes
  truncation and forks provable. (`demo:revoke-audit`, [docs/revocability-and-audit.md](docs/revocability-and-audit.md))
- **Release safety.** Every release is tagged; you can always ship the last released version no matter how
  half-finished `main` is. ([docs/RELEASE-ROLLBACK.md](docs/RELEASE-ROLLBACK.md))

---

## Nice-to-have — open contribution slots

### Security / cryptography (hard; expertise wanted)

The project owner's honest position: these are obviously worth having, but they are the parts where domain
expertise matters most, and the POC does not depend on them. If you do this kind of work, this is where the
leverage is.

- 🔒 **Tier 2 privacy crypto — external audit, then integration.** A working *prototype* of privacy-preserving
  settlement (Paillier + homomorphic comparison, Pedersen commitments, range/bit proofs, cross-scheme
  equality) lives in its own repository, [can2cup_lab](https://github.com/ccqqder/can2cup_lab) (`tier2/`), and is deliberately kept **out of this
  repository and of `src/protocol`**. It must not move onto
  the shipped surface until a real external cryptographer signs off. The prep an auditor needs — every
  primitive's assumption, the (too-small) prototype sizes, the soft-first confirm list — is already written:
  [can2cup_lab/docs/tier2-audit-scope.md](https://github.com/ccqqder/can2cup_lab/blob/main/docs/tier2-audit-scope.md). There is
  also a proven **impossibility floor** (on a struck deal, price + k + your own bid solves the counterparty's
  bid by arithmetic; only the no-deal case and third-party hiding are protectable) — so scope the ambition to
  that. **Status: research, off the critical path. Do not merge into `src/protocol` without the audit.**
- ⬜ **Semantic-disclosure detection.** `never_disclose` is a *literal substring* scan: "2400" is caught,
  "twenty-four hundred" is not. Structure caps the money and the framing; it cannot read *meaning*. An
  advisory reviewer (an LLM-judge or NLP layer) that reads an outbound body for paraphrased secrets — and
  *holds* rather than *blocks*, since meaning is a judgement call — would close the honest residual named in
  the adversarial work. Plugs in alongside `checkMandate` as an advisory pass, not inside it. **Hard because
  it is a judgement, not a rule; must fail safe (advisory, human-confirmed), never auto-approve.**
- ⬜ **Advisory review / a second pair of eyes.** The self-preservation list forces a human onto a *category*;
  it cannot tell an in-bounds *good* trade from an in-bounds *unwise* one. A reviewer model that flags "this
  is within your mandate but looks like a bad deal" before a held decision is confirmed. Complements, does not
  replace, the structural brake.
- ⬜ **Blind / E2E-by-default relay.** The standing honest caveat is *"trust upper bound = the relay
  operator."* The relay holds bytes and can refuse, fork, or truncate (the signed head makes those
  *provable*, not *impossible*). Making E2E the default and the relay unable to read content shrinks that
  upper bound. (Threat context: [docs/security/2026-09-05-g2-line-path-unsigned.md](docs/security/2026-09-05-g2-line-path-unsigned.md).)
- ⬜ **npm provenance (P3).** Tarball hash signing exists (P1/P2); wiring real npm provenance / trusted
  publishing attestation on open-source release is specced but not the current mechanism.
  ([docs/security/2026-09-05-g3-tarball-signing.md](docs/security/2026-09-05-g3-tarball-signing.md))

### Input-validation completeness (medium; from the sixth opinion)

The sixth-opinion review ([docs/security/2026-09-09-sixth-opinion.md](docs/security/2026-09-09-sixth-opinion.md))
fixed the structural-forgery and fail-open findings. The shared send schema and flat-terms rule it deferred
were done in 0.14.5 ([docs/security/2026-09-10-seventh-opinion.md](docs/security/2026-09-10-seventh-opinion.md),
`protocol/terms.ts`). One item remains:

- 🟡 **A releasable `require_confirm` hold.** Today a self-preservation hold returns before the commit gate,
  so even a signed principal approval cannot release it — the semantic is "this agent never sends this type
  on its own." That fails *closed* (safe), but wiring the hold to the same signed-approval path a widened
  commit uses would let a principal release a specific held action by signing it. Needs a
  `deny / needsConfirmation / allow` split threaded through `commitGate`.

### Delegation lifecycle (medium; mostly plumbing)

- 🟡 **Automatic revoke-on-absence.** Policy fully specified — 90-day default, T-14 warning, `/keep` override
  ([docs/security/2026-09-05-binding-lifetime.md](docs/security/2026-09-05-binding-lifetime.md)) — but the
  timer, warning, and override are not implemented. Pure client state, no crypto: a good first contribution.
- 🟡 **Standing authority-ledger view.** The replay logic (grants − revokes − expired) is one shared function
  (`protocol/authority.ts` `liveGrants`, used by `history` and the demo); a `can2cup grants` CLI / MCP surface
  that shows every live grant across a principal's rooms does not exist yet.
- 🟡 **Head-conflict alerting.** Conflicting signed heads are *kept* (`headConflicts`) but not surfaced to the
  principal as an alarm ("your relay signed two histories at the same seq").

### Reach & polish (easy–medium)

- ✅ **Telegram adapter (third channel)** — shipped in 0.15.0 (@can2cup_bot). The channel registry that made it a
  one-file addition, and the two LINE assumptions the first real session surfaced (0.15.1), are in
  [docs/telegram-adapter.md](docs/telegram-adapter.md).
- 🟡 **A principal's dashboard — every connected chat app and its state, on one page.** *Stage 1 shipped in 0.15.2:
  the data (`/p/dashboard`), the connector tool `can2cup_status` and `can2cup status --all`, grouped by a principal-signed
  proof — [docs/dashboard-tool.md](docs/dashboard-tool.md). Stage 2, the HTML page, is what remains of the design below.* Today the same facts are spread over `can2cup status`, `/status` in each chat app,
  `can2cup groups` and `history`'s LIVE GRANTS line, and each shows one slice. Everything the page needs already
  sits in BridgeDO keyed by the agent's pub, so this is a read surface plus one auth step, no new storage:
  - **What it shows** (per agent): the binding — which app (LINE / Discord / Telegram), bound since, idle-expiry
    clock (`/keep`), pause state, channel health (`dh:` — last ok / last refusal / status), this month's pushes
    against that app's allowance; the groups the agent is wired into (`mirror:` — room, keep-alive expiry, quiet /
    context flags, members with agents); open rooms with their signed-head seq; the live-grant ledger
    (`liveGrants`, one line per grant, expiry); and the audit tail (blocked sends, held decisions).
  - **How you get in**: the relay already has an HTML surface (`/terms`, the OAuth consent page) and a code
    flow. Two doors, both existing primitives: (a) the CLI mints a short-lived signed token — `can2cup dashboard`
    → `/p/dashboard-token` (agent-signed, like every `/p/*`) → prints `https://<relay>/d/<token>` and opens it;
    (b) from a phone, `/dashboard` in the chat app answers a `/link`-style code the page accepts. Tokens are
    minutes-long and read-only; actions (unbind, keep, pause / resume) stay on the signed paths that exist.
  - **Where it lives**: one Worker route rendering server-side HTML from a `/p/dashboard` JSON (same data the
    page and a future `can2cup status --json` share), no framework, no client-side fetching of secrets; the
    same `safeLabel` framing for every peer-controlled string. Self-hosters get it for free.
  - **Why it comes before multi-app binding**: once a person can see all their connections in one place, "one
    agent bound on several apps" is a list on this page rather than a new set of blind spots.
- ⬜ **One agent, several chat apps (same owner on LINE + Discord + Telegram)** — *deferred until the dashboard
  exists.* Today a binding is one person ↔ one agent, stored both ways (`user:<id>` / `pub:<pub>`), and a new
  `/link` replaces the old one. Making `pub:<pub>` a list is a storage-shape change plus routing rules (default
  push target = the app the principal last spoke from, as `lastGroup:` already does; `where:` gaining an app
  selector; idle expiry per binding; `/unbind` naming which one; the hosted OAuth tier staying one-to-one). The
  project already carries enough N-to-N relations (agents × rooms × groups × apps); adding one more without a
  place to see them is how blind spots are made. Development case meanwhile: a second machine's agent bound
  to the other app, which is what the Mac mini does with Discord.
- ⏸ **Microsoft Teams adapter — planned, not built** (the plan is in the maintainer's notes; open an issue to get it). The
  registry needs one more entry and the wire protocol (Bot Framework activities, RS256 JWT in, Connector REST
  out) is a two-to-three-day adapter. What stopped it on 2026-09-11 is the test bed, not the code: a custom
  Teams app can only be sideloaded into a tenant whose admin allows it, which rules out the company tenant and
  consumer Teams; the free Developer Program sandbox is no longer offered to individuals; and a tenant of your
  own is Business Basic plus the Teams add-on (about NT$236 a month, no trial in that billing account). Not
  worth it for an app nobody has asked for yet. **Open contribution slot**: the plan's §5 is a file-by-file
  checklist (registry entry, `teams.ts` modelled on `telegram.ts`, JWT verify, conversation references, the
  three scripts, the e2e driver); someone with a Teams tenant can build and verify it without us.
- ✅ **English UI** (v0.17.0). The bot speaks Traditional Chinese, English, Simplified Chinese, Japanese, Thai, Indonesian and Vietnamese; the agent speaks the boss's own language, one of sixteen. A further bot language is one JSON file (src/relay/i18n/).
- 🟡 **Chat-app testing without two humans** ([docs/chat-e2e.md](docs/chat-e2e.md)). Three layers, the top one
  done: (1) ✅ `npm run check:chat` — two forged people in one group, each with a REAL client, through bind /
  `/a` / wire / join / talk / mirror / brake / unbind, on LINE, Discord and Telegram in one run (102 checks);
  a text or bridge-logic change never needs a second person again. (2) ✅ `npm run probe:prod` — after a
  deploy: every webhook route refuses a bad signature, a forged `/help` proves the deployed secret is ours
  (LINE, Telegram), and one forged `/a` as the real principal goes relay → this machine's watch → `tell` →
  the chat app's API says delivered. Discord cannot be probed that way (its webhooks are signed by Discord's
  own key; driving a user account with a browser would be a self-bot). (3) Real devices only when
  an adapter's API calls or UI pieces change (a new button, modal, image), and only on that channel. Discord
  1:1 live pass done 2026-09-11 (bind via `/setup` code, `/a`, `tell` delivered, the 交代 agent modal, `/pause`
  refusing a room send, `/resume`) and the channel half the same day (接上這個群 in a server channel → room
  opened and wired, join code posted, room messages mirrored, `/a` from the channel, `tell` back into it).
  The only piece never seen on a real Discord is 讓我的 agent 也進來 pressed by a SECOND account; its logic
  runs in `check:chat` and its mechanism is the same button interaction as the ones tested, so it stays
  untested until a second person with Discord shows up (a second account of your own would be allowed —
  ToS checked 2026-09-11: no one-account rule; self-bots are not — but it is not worth one). One finding
  from the live pass: typing `/a hello` and pressing Enter without picking `a` from Discord's command popup
  sends a plain message the app never receives — no error anywhere. The `/help` text should say "pick the
  command from the popup" (or point at the 交代 agent button, which has no such trap).
- ⬜ **More brokerage mechanisms.** Only the sealed-bid k-double settlement is implemented; other
  negotiation protocols could slot behind the same `mechanism` message type.
- ⬜ **Same-owner coordination convenience (optional, low priority).** One owner's agents on several machines
  coordinate through the **ordinary room mechanism** — no special same-owner mode; the existing untrusted-peer
  framing is the correct, unrelaxed trust model (see [docs/same-owner-agents.md](docs/same-owner-agents.md)).
  The only convenience worth adding *if the friction bites* is syncing a long-lived room's `{id, secret}` the
  way `principal.json` is already synced, so devices skip re-inviting — never a principal-key-derived room, and
  never an automated gate an agent acts on unattended. Behind the on-thesis gaps.

---

## Principles for contributors

1. **Structure over cleverness.** A safeguard belongs in `checkMandate` / the signed chain, not in a prompt
   that asks the agent to behave. If it can be talked around, it is not a safeguard.
2. **One implementation for both floors.** Any rule the local client enforces, the hosted relay must enforce
   too, from the same `src/protocol` module. A rule on one floor and not the other is a hole.
3. **`src/protocol` is the audited surface.** Prototype cryptography stays in `demo/` until an external audit
   clears it. The 🔒 tag means exactly that.
4. **Name the residual.** When a defense has a hole, say so in the docs and the demo. An honest boundary is
   worth more than an overstated guarantee.
