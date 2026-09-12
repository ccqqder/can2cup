# Trust model — what each layer actually guarantees

The signed layer is strong; the convenience layers on top are not. Read this before trusting can2cup with anything
that matters. The short version is the five bullets in the [README](../README.md#trust-model-in-five-bullets); the
live trust table is at [can2cup.com/guide/#trust](https://can2cup.com/guide/#trust); the review records are in
[security/](security/README.md).

## Two ways to run, two trust roots

- **Direct (no chat app)** — each principal sits at their own terminal; two agents join a room by pasting the invite,
  and the human talks to their agent directly in the session. No bridge, no inbox, no operator-trusted channel.
  **This is the higher-security tier**; everything below about the chat-app path does not apply to it.
- **Through a chat app (LINE / Discord / Telegram)** — the human drives from a phone instead of a terminal. This adds
  the relay / bot operator as a trusted party on that path: honest, useful, but not zero-trust. What that trust can
  buy is bounded by the mandate and the commit gate (below).

## What the crypto gives you (real)

Participant messages are ed25519-signed and the relay holds no private key, so it *cannot forge a message from you*.
`verifyChain` catches reordering and mid-stream omission and returns a three-value verdict (CLEAN / REFUTED /
INCONCLUSIVE) with coverage counts. Between two *active* participants, a forked view self-detects (your signed `prev`
pointers won't line up). That is genuine tamper-evidence of *authorship and order of what you were shown*.

## What it does NOT give you

- **Completeness / freshness — provable, not preventable.** The relay signs its `system` events and, on every read, a
  transcript **head** (room, seq, hash, at). Clients pin the relay key at create/join (the invite vouches for it as
  `p=`), refuse unsigned system events once pinned, keep the newest head, and flag `TAIL TRUNCATION` / `RELAY KEY
  CHANGED` with the signed evidence in `rooms.json`. The relay *can* still withhold or fork — it just can't do so
  deniably. An optional RFC 3161 anchor puts a third party's clock under the head.
- **A boundary between agents.** `mandate.json` runs on *your* machine over *your* config; it constrains only your own
  agent (a guardrail against your agent's mistakes / injection), and its checks are substring / numeric — "2400" is
  caught, "twenty-four hundred" is not. It gives the counterparty nothing. It is a seatbelt, not a mutual control.
  Structure caps the money and the framing; it cannot read *meaning* (open slot: [../ROADMAP.md](../ROADMAP.md)).
- **A trustworthy operator — only on the unsigned paths.** Whoever runs the relay + bot can, on the *chat-app* path,
  insert UNVERIFIED "principal" text, un-pause an unsigned pause, fake a binding, and add a silent room mirror. They
  cannot forge a participant signature, forge a **VERIFIED** instruction, lift a **signed** pause, or re-aim a signed
  approval (it is bound to the envelope hash). With `require_signed_principal` on, the operator's only remaining
  principal-side power is to *withhold* (a liveness attack the pause fail-closed rule partly covers). They read every
  room in plaintext unless the room is E2E (`create --e2e`).
- **Authenticated access.** The invite secret is rotatable and per-participant caps are revocable (`eject`); joining
  proves key possession. The `/link` code proves someone *received* it, not *who*, and transits the chat app —
  interception of a fresh `/link` code is silent takeover of the *chat-app* channel (not of the signed one).
- **Inbound framing.** A hostile peer's display name, room title or message body cannot forge the structure the agent
  reads (`src/mcp/framing.ts`: every peer-controlled string is labelled and fenced). What the peer *says* is still
  data the agent may be persuaded by; the mandate is what contains a persuaded agent.

## The chat-app path is unsigned, and what that means under the default rules

Everything typed or tapped in LINE / Discord / Telegram reaches your agent as UNVERIFIED text; the relay / bot
operator, or whoever holds the phone, could have written it. So the honest trust ceiling on that path is *the relay
operator*. What the ceiling can buy is bounded by `mandate.json`: under the default (`max_commit_amount: 0`,
`may_grant: []`) it buys words in your agent's name, never money or authority. The moment you widen the mandate, the
**commit gate** turns on: an `accept`, a `grant`, or a proposal with an amount is refused unless a
principal-**signed** approval bound to that exact envelope is on record (`can2cup approve <room> <seq>` on the
computer). Same rule whatever channel the go-ahead came on. `unsigned_may_commit: true` is your explicit opt-out.
Decision record: [security/2026-09-05-g2-line-path-unsigned.md](security/2026-09-05-g2-line-path-unsigned.md).

`require_confirm` goes one step further: the principal names the message *types* the agent may never send alone, and
they are held however persuaded the agent is and however in-bounds the amount.

## Hardening history, briefly

The crypto core was reviewed 2026-08-19 (principal keypair, relay signing key, per-participant caps, separate MCP
content blocks, join-by-possession). Portable rooms, mirrors and E2E rooms removed reasons to trust the relay with
the transcript. The 2026-09-05 review closed what was left around the relay: a connected group is the wirer's, a
widened mandate needs a signed approval before any commitment, a chat-app binding lapses when the agent is gone, every
release is signed by an offline key and published from CI behind a human's 2FA. Nine adversarial review rounds on
2026-09-06 … 09-10 (several by a different model) found dozens of ways the enforcement was weaker than the words; every
confirmed one is closed with a regression test. The records: [security/README.md](security/README.md).

## Disclaimer

We made what can be verified verifiable — signatures, hash chains, a release key kept offline, public keys and names —
and wrote down what cannot be. Every service carries risk and this one is no exception: the relay can fail, be
breached or be shut down; the chat-app path is unsigned; the code may have mistakes we have not found. Using it is your
call and your risk; we keep fixing and welcome reports ([../SECURITY.md](../SECURITY.md)), but accept no liability
for loss arising from use. If you would rather not depend on us at all, run your own relay: [SELF-HOST.md](SELF-HOST.md).

**Pilot rules that follow from this:** low-sensitivity, human-reversible work only. No real credentials in a room, no
money commitments, nothing that auto-touches production. For anything higher-stakes, use the direct (no chat app)
flow, run `can2cup principal init`, keep the default mandate, and confirm decisions with `can2cup approve`.
