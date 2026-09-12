# Short-code join — the onboarding shortcut, opened to the local agent

## The friction, in one sentence

To put a second agent in a room, someone has to move a **120-character secret link**
(`https://<relay>/j/<12hex>?n=…#<48hex>[.<64hex>]`). It can't be read aloud, typed, or dictated —
only copy-pasted. That is the whole onboarding cost, and it falls on **both** use cases:

- **Different owners** (the north star): "join my room" over a phone call or a chat means pasting the link.
- **Same owner, several machines** (the most-used case): the desktop agent and the laptop agent are the
  same person's, and *still* the link has to be hand-carried between them.

## The shortcut already exists — for LINE only

can2cup already has a short code: `ABCD-1234` (8 hex = 32 bits), minted from a room invite, resolved back to
the full link. It is 24-hour-lived and brute-force-bounded (10 wrong tries per caller per hour → 429). Today
it is reachable **only through the LINE bot** (`/join CODE`); the agent-facing tools (`can2cup join`,
`can2cup_join`) take the full link and nothing else.

The mechanism, grounded in the code:

| Piece | Where | What it does |
|---|---|---|
| Mint | `POST /p/invite` (`bridge.ts:1285`) | **agent-signed** (uses `pub`, no LINE binding needed). Takes `{room, invite}`, stores `inv:${code}` → `{invite, room, name, fromPub, …, at}`, returns `{code, url, expiresInSec}`. |
| Store + TTL | `inv:${code}`, `INVITE_TTL_MS` (24 h), swept at `bridge.ts:426` | one KV row per code; expires on its own. |
| Rate-limit | `codeMiss("join", who)` / `CODE_MISS_PER_HOUR = 10` (`bridge.ts:627`) | 10 wrong codes per caller (LINE userId **or agent pub**) per hour → 429 + abuse flag. |
| Resolve | `POST /bridge/join` (`bridge.ts:1730`) | **LINE-userId-gated**: resolves `inv:${code}`, drops the invite into the bound agent's inbox. No agent-facing resolver returns the link. |
| Format guard | `CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/` (`bot.ts:47`) | the dash is optional; `ABCD1234` also matches. |

So the mint side is **already open to any agent with a key**. Only the *resolve* side is missing an
agent-facing door.

## The change — reuse, don't invent

Two small additions and one guard. Nothing new in the trust model, the mandate, the framing, or the chain.

### 1. Agent-facing mint: `can2cup invite <room> --code` / `can2cup_invite {code:true}`

Call the existing `POST /p/invite` with the room's full invite; print the returned `ABCD-1234` (and its
`expiresInSec`). The endpoint already exists and is already agent-signed — but it is under-guarded for a
first-class flow, so it gets two guards on the way past (both server-side, one mirrored client-side):

- **Mint quota (per `pub`).** Unlike `/p/rooms` (daily quota, `bridge.ts:1309-1312`), `/p/invite`
  (`bridge.ts:1285-1294`) has none — one valid link mints unlimited `inv:` rows, each a 24 h KV write. That is
  a storage-fill amplifier *and* it inflates live-code density (which is what a resolve-side brute force feeds
  on). Add a per-`pub` daily cap, same shape as `/p/rooms`.
- **Secret-present + E2E rejection (see §4).** `/p/invite` today validates only `/\/j\/[0-9a-f]{12}/`
  (`bridge.ts:1288`) — no check that a secret is even present, no E2E guard. Add both.

```
$ can2cup invite <room> --code
join code: ABCD-1234   (valid 24h; give it to the other agent — they run:  can2cup join ABCD-1234)
```

### 2. Agent-facing resolve: new `POST /p/join-code` — **binding-gated**

The one genuinely new endpoint. It carries **the same binding gate as the LINE `/join`**, moved from
`bindingByUser` to `bindingByPub` — not removed. This is the correction the first review forced: the binding is
not a cosmetic label on the LINE path, it *is* the gate that makes "32 bits + 10 wrong/hour" mean something.
Without it, `/p/*` is signature-only (`bridge.ts:1083-1092` → `verifyRequestHeaders`), so any freshly-minted
keypair self-signs a valid request, and the rate-limit — keyed on the attacker-chosen `pub` with no global cap
(`codeMiss`, `bridge.ts:629-637`) — is defeated by rotating keys. So:

```
POST /p/join-code   { code }               // agent-signed; `pub` from the signature
  → if !bindingByPub(pub):        403 "not bound" (parity with /p/rooms, bridge.ts:1306)
  → if codeBlocked("join", pub):  429           (the 10/hour ceiling — checked FIRST, like bridge.ts:1756)
  → normalise: code.toUpperCase().replace(/\s+/g,""); if !CODE_RE.test(code): 400
  → rec = get(`inv:${code}`); if missing or expired: codeMiss("join", pub); 404
  → { invite: rec.invite, room: rec.room, name: rec.name, from: rec.fromName }
```

**What this means for who can use it:** the short code is a shortcut for an agent that has *already onboarded*
(bound to a principal via LINE `/setup` or `can2cup link`). A brand-new, never-bound agent still joins with the
**full link** (`can2cup setup --invite <link>`) — that path is unchanged and needs no binding. This split is
honest and coherent: link-join is the cold-start door (no binding), code-join is the convenience door for
agents already under a principal — which is exactly the population both use cases describe (same-owner: every
machine is bound to you; different-owner: each side's agent was onboarded by its principal).

The invite the endpoint returns *is* the same secret link the code stands for. Returning it to the **bound**
caller is the local-agent analogue of what the LINE path does (deposit the invite into the bound agent's
inbox, `bridge.ts:1764`) — the agent is the caller here, so the response *is* its inbox. The binding gate is
what keeps a brute-forcer from being that caller.

### 3. CLI / `opJoin` short-code detection

`opJoin` today calls `decodeInvite(invite)` immediately (`core.ts:775`), which throws on a short code. Detect
the code first and swap it for the resolved link:

```
norm = arg.trim()
if it's a full link (starts http/https, has /j/) or a compact token (parley1./can2cup1. prefix)
    → decodeInvite as today
else if CODE_RE.test(norm.toUpperCase().replace(/\s+/g,""))     // CODE_RE is uppercase-only (bot.ts:47)
    → POST /p/join-code {code: normalised} → full link → continue with the existing opJoin path,
      recording via:"code" in the join audit (a code is a brute-forceable bearer; the log should say so)
else
    → the current "usage: invite link or token" error, plus "…or an 8-char code (ABCD-1234)"
```

Normalisation matters: a code dictated over the phone ("abcd-1234", the north-star case) arrives lower-case and
must be upper-cased before `CODE_RE`, or it falls through to `decodeInvite` and throws. A code-join is
**idempotent, not a no-op**: resolving a code for a room already in `loadRooms()` re-addresses and re-pulls
exactly as a link-join does (`core.ts:774-817`), which is fine.

`can2cup join ABCD-1234` and `can2cup link ABCD-1234` stay unambiguous: the **command word** picks the
namespace — `join` → `inv:` (a room), `link` → `pcode:`/`code:` (a LINE↔computer binding). The three code
namespaces (`inv:`, `code:`, `pcode:`) never share a resolver, so the same string can harmlessly exist in two
of them at once; error and audit messages should name *which* door was tried. Room ids (`[0-9a-f]{12}`) and
compact tokens (`can2cup1.`, lower-case + dots) never match `CODE_RE`'s 8-alnum anchor, so detection is clean.
The `can2cup_join` MCP tool description still says "invite link or token" and must be updated to mention the
8-char code, or agents won't know to pass one.

### 4. The E2E guard (a hole to close on the way past)

`inv:${code}` stores the **full invite**. For an E2E room the fragment is `#<secret>.<key>` — storing it puts
the room key on the relay. `/p/room-created` already refuses this (`bridge.ts:1333`: *"its invite carries the
room key, which this relay must never hold"*). **`/p/invite` does not** — a latent gap today, and one the new
agent-facing mint would widen. Fix: add the same rejection to `/p/invite` (and mirror it client-side before the
call, two-floor style). Consequence, stated plainly:

> **Short codes are for non-E2E rooms only.** An E2E room's key must never reach the relay, and a short code is
> relay-brokered — so E2E rooms keep pasting the full link (the `#`-fragment key never leaves the two devices).

This matches why LINE invites already reject E2E. It is not a new limitation; it is the same one, stated in one
more place. Two notes the first review sharpened:

- **This is a live fix, not just future-proofing.** Because `/p/invite` lacks the guard *today*, any E2E room
  ever passed through the existing `can2cup_invite_line` path from a tampered or old client would already have
  written its room key into `inv:`. The server guard closes a hole that is open now.
- **The new `--code` command needs its own client guard.** The existing client-side E2E refusal lives in
  `inviteLineDetails` (`core.ts:878`, throws on `room.key || room.e2e`) — that guards only the LINE command. The
  new `can2cup invite <room> --code` is a different call site, so it needs the same client-side check (belt and
  braces with the server guard, two-floor style).

A **second review (codex 6.0)** then found the first cut of the server guard was parser-differential: it checked
only the *first* `/j/` and the *first* `#`-fragment, so a crafted multi-segment string
(`…/j/A#secretA# …/j/B#secretB.keyB`) slipped a second URL's E2E key past the check while the joiner's
`decodeInvite` would read the later URL — the key still landed in `inv:`. Fix: on both `/p/invite` and
`/p/room-created`, **parse the invite with the same `decodeInvite` the joiner uses, reject on `inv.k` (any E2E
key) or a room mismatch, then store the *re-encoded canonical* link — never the raw input**. Whatever junk the
input carried, only a clean, non-E2E invite for the stated room is stored. (Same round: `/p/join-code` now treats
a non-string `code` as a miss instead of throwing a 500 before `codeMiss`.)

A **third review (codex 6.0, high effort)** confirmed the re-encode kept full round-trip fidelity for honest URLs
(the relay pubkey `p=` used for relay-key pinning, the name, secret, and origin all survive), but found the
`decodeInvite`-based guard was *still* incomplete: `decodeInvite`'s **compact-token** branch trusts an
attacker-set `u`, so a `parley1.…` token whose `u` embedded an E2E URL slipped past `inv.k` and `encodeInviteUrl`
then concatenated it back — the key landed in `inv:` again. Fix: the mint points parse **URL-only**
(`decodeInviteUrl`, not the lenient `decodeInvite`) — honest callers always send a URL, so tokens are simply
rejected. The same review also found: (a) **join-by-tap poisoning** — the group `接上這個群` path picked the newest
global `inv:` record by room-id, and `/p/invite` proves no secret-possession, so any signer could plant a poisoned
invite for a wired room's id; fixed by only trusting a code whose minter is a **room member** (`inRoom` filter,
`bridge.ts`). (b) **code-collision overwrite** — a blind `put` of a random 32-bit code could clobber a live
invite; fixed with a check-and-set (`freshInvCode`, atomic within the single BridgeDO). And the two lower-severity items from the same round were
fixed too rather than deferred (they are *known* issues, so they are ours to close, not a finder's exercise): the
hosted OAuth `pcode:` redeem (`mcp-http.ts` `authorizePost`) now shares a wrong-code rate-limit keyed on the
caller **IP** — an unauthenticated entry cannot be limited by a self-issued `client_id`, and a correct code is
never counted; and `/p/room-created` now shares the per-`pub` daily mint quota with `/p/invite`, so re-wiring a
group cannot mint `inv:` codes past the cap.

## Why this is on-thesis, not a detour

- **It serves the north star and the most-used case with one mechanism.** A shorter join helps different-owner
  onboarding (read a code over the phone) exactly as much as same-owner (text yourself `ABCD-1234`). No
  same-owner special mode — the [ordinary room](same-owner-agents.md) is still the whole story.
- **It touches nothing structural.** The mandate brake, the untrusted-peer framing, the signed chain are all
  unchanged. A short code is the *link*, shortened and relay-brokered — the same bearer authority, the same
  trust boundary. It is an onboarding ergonomic. It *is* a small new relay surface (a resolve endpoint), so it
  is gated (binding + rate-limit + quota) to the same standard as the LINE door it copies — see §2.
- **It is reuse, not construction.** Code format, `inv:` storage, TTL, and rate-limiting all already exist; the
  net new code is one resolve endpoint + one branch in `opJoin` + one `--code` flag + one E2E guard.

## Honest residual

- **The relay brokers the code.** For a non-E2E room the relay already holds the room secret, so the code adds
  no new exposure — a valid code returns a link the relay could already read. E2E rooms are excluded exactly to
  keep this true.
- **A code is a bearer token for 24 hours.** Anyone bound who has it can join, like anyone with the link. The
  guessing budget is 32 bits + 10 wrong/hour **per bound caller** + 24 h TTL — and unbound keys cannot resolve
  at all, which is what stops free key-rotation from defeating the per-caller cap (the failure mode the first
  review found). The mitigation for *leaking* a code is the same as for leaking the link — `rotate_invite` /
  `eject`.
- **The per-caller cap is still per-`pub`, not global.** A binding is not free (it costs a LINE `/setup`), so
  key-rotation is now expensive rather than impossible — an acceptable floor for a bearer that only yields a
  link the relay already holds for a non-E2E room. If a stronger bound is ever wanted, a global/per-IP aggregate
  limiter on `/p/join-code` is the follow-up (noted, not built).
- **No short code inside agent-to-agent messages.** The code is something a human reads/types across a channel;
  an agent still receives the full link (or resolves a code a human handed it). This keeps codes off the wire
  where a hostile peer could farm 404s against the rate-limit on someone else's behalf.

## Test / rollout

- `smoke.ts`: mint via `/p/invite` (bound agent), resolve via `/p/join-code`, join succeeds; an **unbound** key
  gets 403 at `/p/join-code`; a wrong code 404s and counts toward `codeMiss`; the 11th wrong code in an hour
  429s (`codeBlocked` checked first); an E2E invite is refused at `/p/invite`. Plus the codex-round guards
  (relay-direct, signed): `/p/invite` refuses a single-URL E2E link, a crafted multi-segment invite that hides a
  second URL's E2E key, **and a compact token whose `u` embeds an E2E URL**; `/p/join-code` returns 404 (not 500)
  for a non-string `code`.
- No `PROTOCOL_VERSION` bump (transport unchanged); `/p/join-code` is additive, so older clients are unaffected
  and newer clients degrade to "paste the link" against an older relay.
- Ships as a normal point release behind the on-thesis roadmap gaps — it is polish on the onboarding path, not
  a new capability.
