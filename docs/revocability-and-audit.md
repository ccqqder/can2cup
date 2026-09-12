# Revocability + auditability — telling whether the agent is still working for you

parenting-agent §1 names three safeguards a delegated agent needs. The adversarial work covered the
first two (a bounded blast radius, resistance to a hostile peer). This is the third: **the principal must
be able to tell whether the agent is still working for them, and withdraw its authority when it is not.**

Delegation without this is a one-way door. can2cup already ships the pieces; this note assembles them into
the one question a principal actually asks, and marks honestly what is DONE versus what is a good
contribution slot (see [ROADMAP.md](../ROADMAP.md)).

Runnable: `npm run demo:revoke-audit` (7 checks, no relay needed).

## The three pieces (DONE, on the shipped surface)

| Capability | What it is | Where |
|---|---|---|
| **Revoke** | A signed `revoke` withdraws an earlier `grant` by its seq. Authority is not permanent. | `protocol/envelope.ts` (type), `protocol/mandate.ts` (`revoke` needs `ref`) |
| **Audit** | `verifyChain` replays the whole transcript → **CLEAN / REFUTED / INCONCLUSIVE** with coverage counts. A claim of "verified" always carries *how much* was verified. | `protocol/envelope.ts` `verifyChain`, `Coverage`, `Verdict` |
| **Tamper-evidence** | A relay-signed `Head` pins `(seq, hash)`. A kept head later proves **tail-truncation** (relay serves fewer messages than it signed for) or a **fork**. | `protocol/envelope.ts` `signHead` / `verifyHead` |

## The authority ledger — the §1 question, made concrete

On top of those, "what does the counterparty hold from me *right now*?" is just a replay:

```
live authority = every grant − every revoke − everything expired
```

The demo derives it from the signed chain: after a `grant read:logs/*` and its later `revoke`, the ledger
reads **zero live grants** — and that fact is not something you trust the relay for, it is something you
replay from signatures you can check. That is the concrete form of *"is the agent still working for you."*

One implementation, `liveGrants` in `protocol/authority.ts`, serves the demo and the client's `history`
(v0.14.5). Its rules are structural facts the chain proves: replay **in seq order**; a `revoke` withdraws a
grant only if it names an *earlier* seq that is a live grant, and only when it comes from **the grant's own
author** — a peer cannot revoke what they did not give. And when the relay serves only a *prefix* of the room
(fewer messages than its own numbers, its signed head, or this client's cursor say exist), the list is
**withheld**, not computed: a ledger built from a prefix would show authority already withdrawn.

The **verdict asymmetry** is deliberate (`envelope.ts`): a false CLEAN is the worst outcome, so any path
that did not actually prove something reports INCONCLUSIVE, never CLEAN. A room whose relay key was never
pinned, or one migrated between relays, is *unproven*, and says so rather than overstating what was checked.

## What is NOT done yet (contribution slots)

These are real and useful; none is on the POC's critical path. Marked here so a contributor knows where to
plug in. Full list in [ROADMAP.md](../ROADMAP.md).

- **Automatic revoke-on-absence.** The passive twin of `revoke`: authority that lapses when the agent goes
  quiet. The policy is already specified — 90-day default, T-14 warning, `/keep` override
  ([security/2026-09-05-binding-lifetime.md](security/2026-09-05-binding-lifetime.md)) — but the timer,
  the warning, and the override are **not implemented**. Good first contribution: it is pure client state,
  no crypto.
- **A standing authority-ledger view.** The demo computes the ledger inline; there is no `can2cup grants`
  command or MCP surface that shows a principal, at a glance, every live grant across their rooms. The
  replay logic exists; it needs a UI/CLI surface.
- **Head-conflict alerting.** `rooms.json` already *keeps* conflicting signed heads (`headConflicts`,
  third-opinion #9) without overwriting them — but surfacing "your relay signed two different histories at
  the same seq" to the principal as an alarm is not wired.

## The honest boundary

Auditability makes the record **tamper-evident**, not tamper-*proof*: the relay still holds the bytes and
can refuse to serve, fork, or truncate — the signed head makes those **provable after the fact**, it does
not prevent them. Reducing that (blind/E2E-by-default relay, so the operator cannot read or selectively
withhold) is the standing "trust upper bound = relay operator" item (G-2), tracked in ROADMAP.
