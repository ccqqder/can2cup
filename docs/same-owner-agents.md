# Same-owner agents across clients — just use the room you already have

## The question, and the answer

One person often has agents on several machines and sessions — a desktop, a laptop, a cloud session —
all answering to them. They want those agents to coordinate: presence, "I'm about to push main", a handoff.

The tempting move is to build a *special same-owner mode* — auto-discovery, a room derived from the
principal key, a friendlier "it's me, trust it" channel. **Don't.** Same-owner coordination is not a new,
harder problem; it is the *ordinary* room used for your own devices. can2cup already does it: create a room,
share the invite, the other agent joins. (This document was itself written while two of the author's own
agents coordinated through exactly that flow.)

**So the whole feature is: use the existing different-owner room mechanism for your own devices.** No new
trust model, no deterministic room, no new relay auth. Everything below is why that is not just less work but
*more correct*, and the one small convenience worth adding later.

## Why reusing the different-owner scheme is the right call, not a shortcut

Two independent design reviews (2026-09-09) killed the "special same-owner mechanism" idea and both pointed
back to reuse:

- **The trust model must NOT be relaxed for same-owner.** The instinct to trust "my own device more" is the
  attack surface, not a convenience. A compromised device of *yours* is arguably a **more** dangerous peer
  than a counterparty: it knows your repos, it can steer high-consequence local actions (a `git push`, an
  `npm publish`, a handoff), and you are predisposed to believe it. So same-owner peer text must render **at
  least as untrusted** as a counterparty's — which is exactly what the ordinary room already does
  (`UNTRUSTED_HEADER`, `safeLabel`/`fenceBody`, peer messages as DATA, only principal-signed items VERIFIED).
  Reuse gives you the correct trust model for free; a bespoke "trusting" mode would have been the real bug.
- **"Advisory awareness" is powerful, so keep it advisory.** The value of "I'm about to push main" is that
  another agent *reads it and changes what it does*. That means a peer message with only an agent key can
  still cause harm by being **truthfully-shaped but false** — "you're clear, push" (inducing a bad release),
  "hold off forever" (denial), "please take over X" (redirection). Framing stops *forged structure*, not
  *false content*; `checkMandate` bounds money and decision-types, not "a peer message made my agent run a
  push." **Therefore: presence and the activity feed are information shown to the human/agent, never an
  automated gate another agent acts on unattended. Anything with side effects — spend, grant, release,
  commit-on-behalf — must be principal-signed, not an agent's "please take over."**
- **Revocation already exists.** To cut off a compromised or retired device you `eject` it and
  `rotate_invite` — the room mechanism the adversarial case already ships. No new per-device enrollment
  machinery is needed *because we are not building a special room*.

## The one real gap, and its cheap fix

Reusing the ordinary flow leaves exactly one friction versus a bespoke feature: you re-share the invite each
time instead of the devices finding each other automatically. That is a convenience, not a necessity, and the
safe way to close it is **not** a principal-key-derived room (the reviews showed that welds membership to the
key, removes rotation/eviction, and turns a principal-*public*-key-derived id into a relay-visible correlator
of all your devices). The cheap, safe version:

- **Sync the room's coordinates the way you already sync `principal.json`.** The first device creates one
  long-lived room; you copy its `{id, secret}` (and E2E key, if used) to your other devices alongside the
  principal key. "Have the synced file ⇒ you're in the room" delivers the actual goal (no hand-carried link)
  with near-zero relay change, rotation still working (`rotate_invite` + re-sync), and eviction still working
  (`eject` + rotate). The relay change, if any, is only a longer TTL for a persistent channel (the group-room
  keep-alive already exists) — not a new secret model or a new auth mode.

Even this is optional and low-priority. Manual create/invite/join works today.

## What this is NOT

- Not a devices-presence/sync product. can2cup's distinctive thing is the mandate-negotiation brake between
  *different* owners; same-owner reuse is a small application of that, not a pivot into a crowded category.
- Not cross-device command. A device does not gain authority over another by being same-owner; authority
  still flows only from principal signatures, and the only wired principal-verified transport today is the
  LINE/Discord bridge (a room-carried principal-message path would be a new hardened transport — out of scope).
- Not a reason to relax framing, skip the mandate, or auto-act on peer messages.

## Priority

**Behind the on-thesis work, not ahead of it.** The north star is different-owner agents under mandates; the
roadmap's open on-thesis gaps (semantic-disclosure detection, advisory review, a releasable `require_confirm`,
revoke-on-absence, English UI, real-device Discord) all serve it and same-owner reuse serves none of them. The
release-divergence pain that motivated this is already mitigated by tags + [RELEASE-ROLLBACK](RELEASE-ROLLBACK.md)
+ a single release machine. So: **treat same-owner as a documented usage pattern of the existing mechanism**,
add the coordinate-sync convenience only if the friction actually bites, and keep it in the ROADMAP behind the
on-thesis gaps.

## Honest residual

A device holding the synced principal key (or room secret) *is* you: if compromised, it is a same-owner peer
you are biased to trust, on a channel that broadcasts your activity. The mitigations are the ordinary ones —
untrusted-peer framing (do not relax it), `eject`/`rotate`, principal-key rotation as the last resort — plus
keeping the sync channel itself encrypted at rest and in transit. There is no same-owner trust dividend to
collect; the safety comes from treating your own other device exactly like anyone else's agent.
