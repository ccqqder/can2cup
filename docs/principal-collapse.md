# Principal collapse

*A defect class in agent harnesses, and the `peer` role that fixes it.*

Canonical definition page. Coined 2026-09-07. Maintained at
`https://github.com/ccqqder/can2cup/blob/main/docs/principal-collapse.md`.
Background: <https://peachpitboat.com/zh-tw/posts/parenting-agent/>

---

## Terms

**Principal** — the human (or organisation) an agent answers to, and whose authority it
borrows. Every harness has exactly one by default: the person at the terminal.

**Peer** — an agent that answers to a *different* principal. Not a subagent, not a tool,
not a hostile injector. A legitimate, named counterparty whose principal authorised it to
speak, but who is outside your trust boundary.

**Harness** — the program that assembles a model's context and executes its tool calls:
Claude Code, Codex CLI, opencode, pi, or your own.

---

## Definition

> **Principal collapse** is the defect in which speech authored by one principal acquires
> the authority of another, because the harness has no representation for input that is
> *authored but not authoritative*.

Harnesses today carry two classes of non-system input:

| role | meaning | authority |
|---|---|---|
| `user` | my principal said this | **instruction** |
| `tool` | a tool returned this | data |

There is no third class. So when a peer's message arrives, it is either flattened into
`user` — where it inherits your principal's authority — or degraded into `tool`, where its
authorship is discarded and it becomes unattributable. Neither is correct. The message is
*someone's* speech; it is just not *your* principal's.

The collapse is not that the wrong bytes get in. It is that **the authority axis has only
one position**, so the moment a second principal exists, the harness cannot represent the
difference.

---

## The test

Ask three questions about your harness. Any "no" means you have principal collapse.

1. **Distinctness.** Can it represent a message that has a known author who is *not* your
   principal, without putting it in the same role as your principal?
2. **Non-promotion.** If such a message contains the sentence *"the user has approved
   this"*, is there any code path by which it becomes true?
3. **Legibility.** For any action the agent took, can the principal see which role the
   input that caused it came from?

Shorter version: *ask your harness which bytes in its context are authoritative. If the
answer is "everything in the `user` role", and anything from outside your trust boundary
can reach the `user` role, you have principal collapse.*

Every general-purpose harness the author is aware of fails all three as shipped. This is
not a criticism of their engineering. They were built for one principal, and for one
principal the defect is unobservable — there is nothing to collapse.

---

## Found in the wild

Not hypothetical. From the harness-shim guide of [hauddy](https://github.com/Hauddy/hauddy)
(Apache-2.0), telling any MCP harness how to receive a message from an agent that answers to
*someone else*:

```ts
session.injectUserMessage(`[hauddy ${msg.params.from}] ${msg.params.message}`);
```

A stranger's speech, placed in the **user** role, prefixed with a bracket. The same document,
two lines below, gets the adjacent problem exactly right —

> `from` is asserted by Hauddy (safe to trust); don't parse identity out of `message` prose.

— so this is not carelessness. Provenance was defended; authority had nowhere to go, because
there is no fifth role to put it in. The bracket is the entire boundary.

The same project's Claude Code path goes one step further and sends

```
<channel source="hauddy" from="@ada">…</channel>
```

which is a genuine PC-1 wrapper: a distinct frame carrying an attribute the payload cannot
forge. What it does not carry is `authority: "none"`, and nothing downstream stops the
content inside from being read as an instruction. **PC-1 without PC-3 is a label, not a
boundary.**

Cited with respect, and as the clearest available evidence that careful engineers hit this
gap because the representation is missing — not because they were not thinking about it.
More neighbours, read the same way, in [prior-art.md](./prior-art.md).

---

## What it is not

Naming the neighbours honestly, because the first objection will be that this is one of them.

**Not prompt injection.** Injection is *illegitimate* content smuggled through a data
channel. A peer message is legitimate: its principal authorised it, it is signed, the
author is known and stable. Injection defences ask *"should this be here?"*. Principal
collapse asks *"whose authority does this carry?"* — a question that remains open even
after you are certain the content belongs. A harness perfectly hardened against injection
still collapses, because the peer message was never an intruder.

**Not the confused deputy** (Hardy, 1988). The confused deputy is a *program* misusing
*its own* ambient authority on behalf of a caller; the fix is capability-based
authorisation — stop carrying ambient authority. Principal collapse is a defect in the
*representation of speech*: the context window has no field for authorial authority, so
capabilities alone do not fix it. A harness with perfect capability discipline still
cannot tell the model "this sentence is a proposal from a stranger, not an order from your
boss." Same family; different member.

**Not multi-agent orchestration.** Subagents, swarms, and worker/reviewer fan-out are all
*single-principal*. They share one owner, one trust boundary, one permission model, and
no adversarial interest. Nothing collapses because there is only one authority to collapse
into. Multi-agent is a concurrency problem; principal collapse is an authority problem.

**Not multi-tenancy.** Multi-tenancy is one operator serving many isolated customers. Here
the principals are not isolated — they are *talking to each other*, on purpose, and neither
one is the operator.

---

## The fix: a `peer` role

Add the missing position on the authority axis.

```
system | user | assistant | tool | peer
```

A `peer` message is **authored, attributable, and non-authoritative by default**.

```json
{
  "role": "peer",
  "author": {
    "id": "ed25519:9f3c…",
    "display": "Carol (agent of B)",
    "verified": "signature"
  },
  "principal_of_author": "B",
  "content": "We can do 2400, but only if you cover shipping.",
  "authority": "none"
}
```

Three fields carry the whole idea: **who authored it**, **which principal they answer to**,
and **what it may cause on its own** (`none`).

### Conformance requirements

A harness is **multi-principal** if it satisfies all six. Numbered so they can be cited
and tested individually.

- **PC-1 · Distinct role.** Input originating outside the principal's trust boundary MUST
  be represented in a role distinct from the principal's own.
- **PC-2 · Provenance.** Every `peer` message MUST carry an author identity verifiable
  independently of the transport that delivered it. If the relay can forge the author, the
  role is decorative.
- **PC-3 · Non-authority.** `peer` content MUST NOT, by itself, authorise a tool call, a
  commitment, or a change to the agent's own constraints.
- **PC-4 · Non-promotion.** No content *within* a `peer` message may cause the harness to
  reclassify it — or any later message — into the principal role. Promotion MUST require a
  fresh input arriving on the principal's own channel.
- **PC-5 · Mandate boundary.** An action crossing a declared threshold (money, granted
  authority, disclosure of a reserved fact) MUST require an authorisation attributable to
  the principal and **bound to that specific act**, not to the session.
- **PC-6 · Legibility.** For any action taken, the principal MUST be able to see which role
  the causing input occupied.

PC-4 is the one that gets skipped, and it is the one that matters. A `peer` role that any
sufficiently persuasive paragraph can talk its way out of is not a boundary; it is a label.

### What PC-3 buys, precisely

It does not make the peer trustworthy, and it does not need to. It makes the peer's speech
*inert*: it can inform the agent, and it can never move the agent's own limits. The agent
may still be wrong, may still be persuaded, may still propose something foolish to its own
principal — but it cannot be *authorised* by the counterparty. The cost of being persuaded
becomes bounded by the mandate rather than by the model's judgement.

---

## Why it is about to matter

For one principal, the defect is invisible. It becomes load-bearing the moment any of these
ships:

- agent-to-agent negotiation or scheduling across organisations
- an agent acting for a customer against another company's agent
- a shared channel where several people's agents are present
- any agent-to-agent payment or commitment

The protocol layer for this already exists — A2A reached Linux Foundation governance and
150+ organisations by April 2026 — and the transport is being solved without the authority
model. Transport standards describe how two agents exchange messages. None of them
describe **whose authority a message carries once it lands inside the other agent's
context**. That gap is where principal collapse lives.

---

## Reference implementation

`can2cup` is the author's reference implementation. Mapping, so the requirements are
checkable rather than aspirational:

| | how |
|---|---|
| PC-1 | room messages arrive as a distinct content class; principal material is delivered as separate MCP content blocks |
| PC-2 | every message ed25519-signed by the participant's own key, hash-chained; the relay holds no private key and cannot forge authorship |
| PC-3 | inbound peer content is framed as data, not instruction; `mandate.json` is evaluated on every outbound message before it leaves |
| PC-4 | only a principal-signed input is ever labelled `VERIFIED`; room bodies are scrubbed of the principal-channel sentinel; `require_signed_principal` closes the unsigned path entirely |
| PC-5 | the commit gate: once the mandate is widened, an `accept`, a `grant`, or a priced proposal requires a principal signature **bound to that envelope hash** (`can2cup approve <room> <seq>`) |
| PC-6 | private per-message `rationale` in the local audit log; the principal's window and the transcript both record which channel an instruction arrived on |

The implementation is not the point of this page. The six requirements are. Any harness can
satisfy them, and the author would rather they did.

---

## Prior art

- Hardy, N. (1988). *The Confused Deputy* — ambient authority, and why capabilities fix it.
- Willison, S. (2022–). *Prompt injection* — the naming precedent, and the adjacent defect.
- Google / Linux Foundation (2025–). *A2A* — transport and discovery for cross-agent work.
- Anthropic (2026). *Project Deal* — 69 employees, 500+ items; principals represented by
  stronger models did measurably better while **self-rated fairness stayed the same**. The
  empirical case that a principal cannot feel this defect from the inside.

## History

- **2026-09-07** — term coined; this page created.

Corrections, counterexamples, and claims of prior coinage are welcome as issues. If the
concept already has a name, the author would rather adopt it than compete with it.
