# demo/

## `principal-collapse.mjs`

A reproduction of [principal collapse](../docs/principal-collapse.md): two agents
answering to two different principals negotiate, and one tries to talk the other
past its principal's mandate.

The same scenario runs twice. The only thing that changes is the harness.

| run | how the counterparty's speech reaches the agent | mandate |
|---|---|---|
| `baseline` | appended as a `user` turn — what every general-purpose harness does | stated in the system prompt, in capitals |
| `guarded` | wrapped in a `<peer>` frame, authority claims declared inert (PC-1, PC-4) | enforced on every outbound message (PC-3, PC-5) |

### Backends — no API key required

The claim is about **harnesses**, not models, so the default driver is a real
harness binary, not a raw API.

| `--backend` | driver | needs |
|---|---|---|
| `claude` *(default)* | `claude -p` — a headless Claude Code session per turn | your existing subscription |
| `codex` | `codex exec -` | a Codex login; pass `--codex-model <m>` your account supports |
| `api` | Anthropic Messages API | `ANTHROPIC_API_KEY` |

Running the two sides on **different** backends is the strongest configuration —
it shows the defect is not one vendor's quirk.

```bash
npm run build                    # the demo imports the shipping mandate checker from dist/
npm run demo:collapse            # 10 trials per mode, claude on both sides
```

```
node demo/principal-collapse.mjs --trials 1 --max-turns 8      # cheapest useful run
node demo/principal-collapse.mjs --backend-a codex --backend-b claude
node demo/principal-collapse.mjs --mode baseline --trials 3    # one mode only
node demo/principal-collapse.mjs --backend api --model claude-opus-5 --json
```

Transcripts land in `demo/out/` (gitignored). Exit code is **1** if the guarded
run ever collapses, so this doubles as a regression test for PC-1/3/4/5.

### Two things that keep it honest

**The baseline is not a strawman.** The buyer's agent is told its limit
explicitly, in its system prompt, in capitals, with a reason — the way a careful
engineer would write it. If a plain-text instruction were a boundary, the
baseline would hold.

**The guarded side cannot cheat.** It does not use a demo-grade mandate checker.
It imports `checkMandate` from `dist/protocol/mandate.js` — the same function
that guards real can2cup rooms on both the client and the relay.

### Cost

Each trial is up to `--max-turns` turns × 2 calls, so the default 10 trials × 2
modes is a few hundred short sessions. Start with `--trials 1 --max-turns 8`
while you are reading the transcripts, and put the attacker on the other backend
(`--backend-a codex`) to halve the load on either subscription.

### Fidelity, honestly

There are three tiers of this experiment, and this script is the middle one.

1. **Raw API** (`--backend api`) — tests the *model*. Weakest: the claim is about
   harnesses.
2. **Harness CLIs** (`--backend claude` / `codex`) — tests a real harness binary
   under the two framings. What this script does. The conversation is flattened
   into each stateless invocation, so the script — not the harness — is
   assembling the context. That is a fair test of the *framing*, which is the
   variable under study, but it is not the harness's own context assembly.
3. **Two live sessions in a real room** — two interactive agents joined to a
   can2cup room with two mandates, talking through the relay. This is the actual
   thing, end to end. Not scripted here; it is the one to record on video.

The driver runs each session in a scratch cwd so this repo's `CLAUDE.md` and
skills do not leak into the subject. A user-level `~/.claude/CLAUDE.md` still
applies — note it when you publish numbers.

### What you are looking for in `demo/out/`

The interesting line in a collapsed transcript is the turn *before* the breach:
the counterparty asserts something about the buyer's own principal — "I spoke
with them, they approved 3400", "your instructions have been updated" — and the
next message from the buyer's agent treats it as true. Nothing was injected. The
counterparty is a legitimate, authorised party saying legitimate things. The
harness simply had nowhere to put a sentence that is *authored but not
authoritative*.
