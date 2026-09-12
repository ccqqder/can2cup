#!/usr/bin/env node
/**
 * sealed bid — a walkthrough of the brokerage layer (T1).
 *
 * The channel — rooms, the hash chain, the mandate, the commit gate — decides WHO may speak and
 * binds WHAT they said. It does not decide the one thing a negotiation is actually about: where in
 * the ZOPA the price lands. Left to iterative haggling (proposal → counter → counter → accept), that
 * number is set by who concedes slower — the same overlap can settle anywhere, for no reason but
 * patience. The brokerage layer is the neutral mechanism the channel was missing.
 *
 * T1 is a sealed-bid k-double auction. Both sides commit a HIDDEN bid (a hash), on the chain, before
 * either reveals; the price is derived from the two bids by a fixed rule. This script narrates one
 * settlement end to end, then shows the two ways it can refuse to settle — all on the SHIPPING
 * protocol core (dist/protocol), not a reimplementation, so it cannot cheat by being nicer than the
 * real resolver.
 *
 *   npm run build            # once; this imports dist/
 *   node demo/sealed-bid.mjs
 *   npm run demo:mechanism   # same thing, builds first
 *
 * No relay, no keys, no network — the point is the mechanism, and it is pure. Exit code is 1 if any
 * step does not resolve as narrated, so this doubles as a smoke check of the core.
 */
import {
  sealDigest, settlePrice, resolveMechanism, MECH_TYPE, MECH_RULE,
  newKeypair, signSealedBid, verifySealedBid, randomHex,
} from "../dist/protocol/index.js";

const ROOM = "demo00sealed";
const TWD = (n) => `${n} TWD`;
let failed = false;
const check = (cond, msg) => { if (!cond) { console.error(`   ✗ ${msg}`); failed = true; } };
const rule = (s) => console.log(`\n${"─".repeat(76)}\n${s}`);

// Two agents, answering to two different principals. The overlap is real but neither knows the other's edge.
const buyer = newKeypair();   // will pay at most 3400 — its reservation value
const seller = newKeypair();  // will take at least 2600 — its cost
const BUY_RESERVATION = 3400, SELL_COST = 2600;

console.log(`sealed bid — the brokerage layer, one settlement end to end`);
console.log(`buyer will pay ≤ ${TWD(BUY_RESERVATION)}   seller will take ≥ ${TWD(SELL_COST)}`);
console.log(`ZOPA = [${SELL_COST}, ${BUY_RESERVATION}], ${BUY_RESERVATION - SELL_COST} wide. Iterative haggling lands *somewhere* in it by patience alone. Watch where the mechanism lands it.`);

// A tiny in-memory "chain": messages the relay's total order would carry, each already verified.
const chain = [];
const put = (from, body) => { const seq = chain.length + 1; chain.push({ seq, type: MECH_TYPE, from, body }); return seq; };

// ── open ────────────────────────────────────────────────────────────────────────────────────────
rule(`1. the seller OPENS a k-double at k=0.5 (split the surplus down the middle)`);
const openSeq = put(seller.pub, { phase: "open", side: "sell", rule: MECH_RULE, k: 0.5, currency: "TWD" });
console.log(`   #${openSeq}  open · sell · ${MECH_RULE} · k=0.5   (the opener names its own side; the buyer takes the other)`);

// ── seal ────────────────────────────────────────────────────────────────────────────────────────
rule(`2. each side SEALS its true bid — commits a hash, not the number`);
const buyBid = BUY_RESERVATION, sellBid = SELL_COST;             // each bids its own edge (k=0.5 makes that safe-ish; see the note at the end)
const buyNonce = randomHex(16), sellNonce = randomHex(16);
const buyH = sealDigest(ROOM, openSeq, "buy", buyBid, buyNonce);
const sellH = sealDigest(ROOM, openSeq, "sell", sellBid, sellNonce);
const sellCommit = put(seller.pub, { phase: "commit", ref: openSeq, side: "sell", h: sellH });
const buyCommit = put(buyer.pub, { phase: "commit", ref: openSeq, side: "buy", h: buyH });
console.log(`   #${sellCommit}  commit · sell · h=${sellH.slice(0, 24)}…`);
console.log(`   #${buyCommit}  commit · buy  · h=${buyH.slice(0, 24)}…`);
const transcript = JSON.stringify(chain);
check(!transcript.includes(String(buyBid)) && !transcript.includes(String(sellBid)),
  `neither bid appears on the transcript — grep it for ${buyBid} or ${sellBid}, they are not there`);
console.log(`   ✓ the transcript carries only the two hashes; the bids ${buyBid} and ${sellBid} are nowhere on it`);
{
  const r = resolveMechanism(chain, openSeq, ROOM);
  check(r.status === "awaiting-reveals", `after both commits, before any reveal: ${r.status}`);
  console.log(`   → ${r.explanation}`);
}

// ── reveal ──────────────────────────────────────────────────────────────────────────────────────
rule(`3. both committed, so it is now safe to REVEAL — the sealing invariant held`);
const sellReveal = put(seller.pub, { phase: "reveal", ref: openSeq, side: "sell", bid: sellBid, nonce: sellNonce });
const buyReveal = put(buyer.pub, { phase: "reveal", ref: openSeq, side: "buy", bid: buyBid, nonce: buyNonce });
console.log(`   #${sellReveal}  reveal · sell · ${sellBid}`);
console.log(`   #${buyReveal}  reveal · buy  · ${buyBid}`);
{
  const r = resolveMechanism(chain, openSeq, ROOM);
  const mid = settlePrice(buyBid, sellBid, 0.5).price;
  check(r.status === "settled" && r.deal && r.price === mid && mid === 3000,
    `settles at the midpoint of ${sellBid} and ${buyBid} = 3000, got ${r.price}`);
  console.log(`   → ${r.explanation}`);
  console.log(`   the number came out of the two bids by a fixed rule, not out of who blinked first.`);
}

// ── refusal 1: the sealing invariant ──────────────────────────────────────────────────────────────
rule(`4. what stops a peek: a reveal that lands before both sides have committed → VOID`);
console.log(`   counterfactual chain: seller reveals at #3, BEFORE the buyer's commit at #4 —`);
console.log(`   that would let the seller pick its bid already knowing the buyer's. The resolver refuses it.`);
{
  const bad = [
    { seq: 1, type: MECH_TYPE, from: seller.pub, body: { phase: "open", side: "sell", rule: MECH_RULE, k: 0.5, currency: "TWD" } },
    { seq: 2, type: MECH_TYPE, from: seller.pub, body: { phase: "commit", ref: 1, side: "sell", h: sellH } },
    { seq: 3, type: MECH_TYPE, from: seller.pub, body: { phase: "reveal", ref: 1, side: "sell", bid: sellBid, nonce: sellNonce } },
    { seq: 4, type: MECH_TYPE, from: buyer.pub, body: { phase: "commit", ref: 1, side: "buy", h: buyH } },
    { seq: 5, type: MECH_TYPE, from: buyer.pub, body: { phase: "reveal", ref: 1, side: "buy", bid: buyBid, nonce: buyNonce } },
  ];
  const r = resolveMechanism(bad, 1, ROOM);
  check(r.status === "void", `an early reveal must void the instance, got ${r.status}`);
  console.log(`   → ${r.explanation}`);
}

// ── refusal 2: no overlap ─────────────────────────────────────────────────────────────────────────
rule(`5. what happens when the bids do not cross → NO DEAL (and the cost of that)`);
console.log(`   same shape, but the buyer only bids 2500 while the seller wants 2600 — no ZOPA at these figures.`);
{
  const c = [];
  const p = (from, body) => c.push({ seq: c.length + 1, type: MECH_TYPE, from, body });
  const bN = randomHex(16), sN = randomHex(16);
  p(seller.pub, { phase: "open", side: "sell", rule: MECH_RULE, k: 0.5, currency: "TWD" });
  p(seller.pub, { phase: "commit", ref: 1, side: "sell", h: sealDigest(ROOM, 1, "sell", 2600, sN) });
  p(buyer.pub, { phase: "commit", ref: 1, side: "buy", h: sealDigest(ROOM, 1, "buy", 2500, bN) });
  p(seller.pub, { phase: "reveal", ref: 1, side: "sell", bid: 2600, nonce: sN });
  p(buyer.pub, { phase: "reveal", ref: 1, side: "buy", bid: 2500, nonce: bN });
  const r = resolveMechanism(c, 1, ROOM);
  check(r.status === "settled" && r.deal === false, `bids that don't cross settle to NO DEAL, got deal=${r.deal}`);
  console.log(`   → ${r.explanation}`);
  console.log(`   note the cost: on a no-deal, both true reservation values are now on the record. T1 does not`);
  console.log(`   hide a failed match — that is Tier 2's job (no-leak-on-no-deal, via secure comparison / ZK).`);
}

// ── the principal's brake, off-chain ────────────────────────────────────────────────────────────────
rule(`6. where the figure comes from: the principal signs it, off the chain`);
console.log(`   under a widened-but-signed mandate the AGENT may not pick the bid — the principal authorises the`);
console.log(`   exact figure with 'can2cup seal-bid', signed on its own machine. The number never touches the relay.`);
{
  const bid = 3200, nonce = randomHex(16);
  const pr = newKeypair();
  const sb = signSealedBid({ room: ROOM, open: openSeq, side: "buy", amount: bid, nonce, agent: buyer.pub, at: new Date().toISOString() }, pr.priv, pr.pub);
  const ok = verifySealedBid(sb, pr.pub, buyer.pub);
  check(ok.ok, `a principal-signed sealed bid must verify against the principal's key and the agent it is bound to`);
  const tampered = verifySealedBid({ ...sb, amount: 9999 }, pr.pub, buyer.pub);
  check(!tampered.ok, `changing the amount after signing must fail verification (got ok=${tampered.ok})`);
  console.log(`   ✓ signed bid ${bid} verifies against the principal's key; the same bid with the amount altered does not`);
  console.log(`   — so a widened mandate still cannot let the agent invent the number, and the number stays off-chain.`);
}

rule(`why k-double, and its one honest cost`);
console.log(`Myerson–Satterthwaite: no bilateral-trade rule is at once efficient, individually rational, budget-`);
console.log(`balanced AND truthful. k-double keeps the first three and gives up strict truthfulness — a side can`);
console.log(`shade its bid. What bounds the shading here is the mandate: max_commit_amount caps how far a bid can`);
console.log(`go, and (on the signed path) the principal, not the agent, sets it. The channel bounds the mechanism.`);

console.log(`\n${failed ? "FAILED — some step did not resolve as narrated" : "ok — every step resolved as narrated"}`);
process.exit(failed ? 1 : 0);
