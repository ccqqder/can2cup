#!/usr/bin/env node
/**
 * Revocability + auditability — "the core of delegation is being able to tell whether the agent is still
 * working for you, and to pull the plug when it is not." (parenting-agent §1, third safeguard.)
 *
 * This is NOT new protocol. can2cup already ships the three pieces; this demo assembles them into the one
 * question a principal actually asks — "what authority is live right now, is the record honest, and can I
 * withdraw it?" — using the REAL shipped primitives from dist/protocol, no reimplementation:
 *
 *   1. REVOKE          — a signed `revoke` withdraws an earlier `grant` by its seq. Authority is not a
 *                        one-way door.
 *   2. AUDIT           — verifyChain replays the whole transcript and returns CLEAN / REFUTED / INCONCLUSIVE
 *                        with coverage counts. "Verified" always says how MUCH was verified.
 *   3. TAMPER-EVIDENCE — a relay-signed Head pins (seq, hash). A kept head later proves tail-truncation
 *                        (relay serves fewer messages than it signed for) or a fork.
 *
 * On top of those it derives the AUTHORITY LEDGER: grants minus revokes = what the counterparty holds from
 * you at this instant. That is the concrete form of "is the agent still working for you."
 *
 *   npm run demo:revoke-audit      # builds, then runs
 */
import { newKeypair, sign, computeHash, genesis, verifyChain, signHead, verifyHead, liveGrants } from "../dist/protocol/index.js";

const ROOM = "aud1deadbeef0";
const alice = newKeypair();   // the principal delegating a scope
const bob = newKeypair();     // the counterparty's agent receiving it
const relay = newKeypair();   // the relay's signing key (pins heads)

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("  ✗", m); process.exit(1); } pass++; console.log("  ok:", m); };

/** Build a signed, hash-chained transcript from a script — exactly what the relay stores. */
function chain(items) {
  const out = [];
  let prev = genesis(ROOM), seq = 1;
  for (const it of items) {
    const u = { v: 1, room: ROOM, from: it.key.pub, ts: new Date(Date.now() + seq * 1000).toISOString(), type: it.type, body: it.body, prev };
    const s = sign(u, it.key.priv);
    const hash = computeHash({ ...s, seq });
    out.push({ ...s, seq, hash });
    prev = hash; seq++;
  }
  return out;
}

// The authority ledger (grants − revokes − expired) is `liveGrants` from dist/protocol/authority.ts — the SAME
// replay the client's `history` shows (v0.14.5: it used to be computed twice, differently — the demo replayed in
// order, the client did not; a revoke naming a later seq, or a stranger's revoke, hid a live grant there).

console.log('Revocability + auditability — "is the agent still working for you?"\n');

// A transcript: Alice grants Bob read access, Bob uses it, then Alice REVOKES it.
const script = [
  { key: alice, type: "grant", body: { scope: "read:logs/*", expires: new Date(Date.now() + 3.6e6).toISOString(), text: "for the incident review" } },
  { key: bob, type: "text", body: { note: "thanks — reading the logs now" } },
  { key: alice, type: "revoke", body: { ref: 1, text: "review done, pulling access" } },
  { key: bob, type: "text", body: { note: "understood, access released" } },
];
const msgs = chain(script);

console.log("1) AUDIT — replay the whole transcript, get a verdict with coverage");
{
  const r = verifyChain(ROOM, msgs);
  ok(r.verdict === "CLEAN", `verifyChain → ${r.verdict} (every hash links, every participant signature checks out)`);
  ok(r.coverage.participant_sigs_verified === 4 && r.coverage.envelopes_checked === 4,
    `coverage is explicit: ${r.coverage.participant_sigs_verified}/${r.coverage.envelopes_checked} participant signatures verified — "verified" always says how much`);
}

console.log("\n2) THE AUTHORITY LEDGER — what does the counterparty hold from you, right now?");
{
  // Snapshot the chain as it stood right AFTER the grant was used (first two messages only): 1 live grant.
  const before = liveGrants(msgs.slice(0, 2));
  ok(before.length === 1 && before[0].scope === "read:logs/*",
    `before revoke: 1 live grant — Bob holds "${before[0].scope}" (the agent IS acting for you here)`);
  // The full chain, after the revoke: nothing live. The plug was pulled, and it is provable from the record.
  const after = liveGrants(msgs);
  ok(after.length === 0, "after revoke: 0 live grants — authority withdrawn, and the withdrawal is on the signed chain");
  console.log("     → this ledger is the answer to the §1 question: authority is not a one-way door, and");
  console.log("       what the agent still holds from you is a fact you can replay, not a thing you must trust.");
}

console.log("\n3) TAMPER-EVIDENCE — the record cannot be quietly rewritten");
{
  // (a) mutate a delivered message body WITHOUT re-signing (a relay/peer altering history): REFUTED.
  const tampered = msgs.map((m) => m.seq === 2 ? { ...m, body: { note: "you also approved deploy:prod" } } : m);
  const r = verifyChain(ROOM, tampered);
  ok(r.verdict === "REFUTED" && r.failedAt === 2,
    `a forged message body is caught → ${r.verdict} at seq ${r.failedAt} (the signature no longer matches)`);
}
{
  // (b) TAIL-TRUNCATION: the relay signs a Head at seq 4, then later serves only the first 2 messages.
  // The kept head proves the drop — servedMax(2) < head.seq(4) — without trusting the relay's word.
  const head = signHead({ room: ROOM, seq: 4, hash: msgs[3].hash, at: new Date().toISOString() }, relay.priv);
  ok(verifyHead(head, relay.pub), "the relay's signed head verifies under its key");
  const servedMax = 2; // relay now hands back a truncated tail
  ok(head.seq > servedMax, `truncation is provable: a kept head says seq ${head.seq}, the relay served only ${servedMax} — the missing tail cannot be hidden`);
}

console.log(`\n${pass} checks passed.`);
console.log("\nWhat this proves (parenting-agent §1, third safeguard, concretely):");
console.log("  • REVOCABLE — a grant is withdrawn by a signed revoke; the authority ledger (grants − revokes)");
console.log("    replays what the counterparty holds from you at any instant. Delegation is not a one-way door.");
console.log("  • AUDITABLE — verifyChain gives CLEAN / REFUTED / INCONCLUSIVE with coverage counts, so a claim");
console.log("    of 'verified' always carries how much was actually checked, and a forged body is REFUTED.");
console.log("  • TAMPER-EVIDENT — a relay-signed head pins (seq, hash): tail-truncation and forks become");
console.log("    provable after the fact, even though the relay is the one holding the bytes.");
process.exit(0);
