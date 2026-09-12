/**
 * The brokerage layer — sealed-bid settlement, tier 1 (v0.14 draft).
 *
 * WHY THIS EXISTS. The channel (rooms, chain, mandate, commit gate) lets two agents *talk* and
 * makes what they commit to enforceable. It does NOT decide how the surplus is split. Iterative
 * haggling — proposal → counter → counter → accept — lands the price wherever the sequence of
 * counters happens to stop, which in the 100-second experiment meant "whoever concedes slower
 * wins": the ZOPA [2400, 3500] was 1100 wide and the deal sat at 2900 for no reason but patience.
 * That is the allocation problem, and cheap communication does not touch it.
 *
 * WHAT THIS DOES. A one-shot sealed-bid k-double auction, run inside an existing room:
 *   - buyer submits a bid b (the most it will pay); seller submits s (the least it will take);
 *   - if b >= s there is a deal at price  p = s + k*(b - s)   (k = 0.5 → split the difference);
 *   - if b < s there is no deal.
 * Because both bids are submitted SIMULTANEOUSLY (see the sealing invariant below), "concede
 * slower" stops being a lever: there is nothing to concede, you state your number once. What
 * remains is static misrepresentation (a buyer shading its bid below its true value), and that
 * is bounded above by the mandate's max_commit_amount — you cannot bid past your own cap.
 *
 * WHAT THIS DOES NOT DO (tier 1, honest limits). This is not strategy-proof, and it cannot be:
 * Myerson–Satterthwaite says no mechanism for bilateral trade with private values is at once
 * efficient, individually rational, budget-balanced AND truthful. k-double keeps IR and budget
 * balance and gives up truthfulness. And on NO DEAL both reservation values have been revealed
 * to the other side for nothing — a leak that only tier 2 (secure comparison / range proofs,
 * revealing only the outcome) removes. Tier 1 ships first because it is the shortest path that
 * actually kills "who concedes slower"; tier 2 is the roadmap, not this file.
 *
 * ---------------------------------------------------------------------- the wire ---
 *
 * One new message type, `mechanism`, carrying a `phase` in its body. Three phases:
 *
 *   open   { phase:"open", side, rule:"k-double", k, currency?, deadline? }
 *          One side proposes to settle by mechanism and states the rules and which side it takes.
 *          The counterparty "agrees" simply by committing under the same open (opposite side);
 *          a side that dislikes k does not commit and opens again with a different k.
 *
 *   commit { phase:"commit", ref:<open seq>, side, h }
 *          h = sealDigest(room, ref, side, bid, nonce). Hides the bid (the nonce defeats a
 *          dictionary sweep over low-entropy prices) and BINDS the sender: once h is on the
 *          chain the outcome is fixed by the other side's bid, which the sender cannot influence.
 *          THIS is the commitment. Under a widened mandate it must carry a principal-signed
 *          approval bound to a prior escalate that named {side, bid, k} — the bid is the
 *          principal's move, not the agent's, which is also why revealing it later is authorised
 *          disclosure and not a never_disclose leak (see mandate coupling below).
 *
 *   reveal { phase:"reveal", ref:<open seq>, side, bid, nonce }
 *          Opens the commitment. Mechanical, not discretionary: you MUST reveal the bid you
 *          committed (the hash binds you), so reveal needs no fresh approval — but the bid is now
 *          plaintext, so the mandate cap is checked HERE (bid <= max_commit_amount) and the bid
 *          field is the one place never_disclose is not applied to (the principal authorised it).
 *
 * THE SEALING INVARIANT (the whole point). A valid mechanism requires that BOTH commits appear
 * on the chain BEFORE EITHER reveal:  max(commitSeq) < min(revealSeq). The relay's Durable Object
 * gives every message a total order and the chain is signed, so this is verifiable after the fact
 * by anyone. If a reveal is seen before the other side's commit, that side got to choose its bid
 * knowing the other's number — the first-mover leak the layer exists to remove — and the whole
 * instance is VOID. resolveMechanism enforces this; the settling side must check it before
 * treating the price as binding.
 *
 * The resolved price is deterministic from the two reveals, so it is DERIVED, never trusted from
 * a message: `resolveMechanism` is the authority, and any human-facing `settle`/`close` that
 * restates a price must match it.
 */
import { canon } from "./canon.js";
import { sha256Hex } from "./crypto.js";
import type { Envelope } from "./envelope.js";

export const MECH_TYPE = "mechanism" as const;
export const MECH_RULE = "k-double" as const;
export type Side = "buy" | "sell";
export const SIDES: readonly Side[] = ["buy", "sell"];
export const otherSide = (s: Side): Side => (s === "buy" ? "sell" : "buy");

export type MechPhase = "open" | "commit" | "reveal";

/** A bid is a finite, non-negative amount in whole currency units (integers only: a hash must be
 *  reproduced exactly, and half-cents invite rounding disputes between the two sides). */
export function isBid(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isInteger(v);
}

/** The preimage every commitment hashes. Every field binds the commitment against a replay:
 *  `room` (not reusable in another room), `mech` = the open's seq (not reusable across instances
 *  in the same room), `side` (a buy commit cannot be replayed as a sell), and `nonce` (hides a
 *  low-entropy bid). Canonical JSON so the relay (Workers) and client (Node) agree byte for byte. */
export function sealDigest(room: string, mech: number, side: Side, bid: number, nonce: string): string {
  return sha256Hex(canon({ room, mech, side, bid, nonce }));
}

/** Does a reveal open the commitment it claims to? */
export function revealMatches(room: string, mech: number, side: Side, bid: number, nonce: string, commitH: string): boolean {
  return typeof commitH === "string" && !!nonce && isBid(bid) && sealDigest(room, mech, side, bid, nonce) === commitH;
}

/** The k-double auction rule. k in [0,1]: k=0 gives the whole surplus to the buyer (price = seller's
 *  ask), k=1 to the seller (price = buyer's bid), k=0.5 splits it. No deal unless the bids cross. */
export function settlePrice(buyBid: number, sellBid: number, k: number): { deal: boolean; price: number | null } {
  if (!isBid(buyBid) || !isBid(sellBid) || typeof k !== "number" || !(k >= 0 && k <= 1)) return { deal: false, price: null };
  if (buyBid < sellBid) return { deal: false, price: null };
  return { deal: true, price: Math.round(sellBid + k * (buyBid - sellBid)) };
}

export interface OpenRules { side: Side; rule: "k-double"; k: number; currency?: string; deadline?: string }

/** Read and validate an `open` body → the rule set, or an error string. */
export function parseOpen(body: unknown): OpenRules | string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.phase !== "open") return `not an open (phase=${JSON.stringify(b.phase)})`;
  if (b.side !== "buy" && b.side !== "sell") return `open needs side "buy" or "sell", got ${JSON.stringify(b.side)}`;
  if (b.rule !== MECH_RULE) return `open needs rule "${MECH_RULE}", got ${JSON.stringify(b.rule)}`;
  if (typeof b.k !== "number" || !(b.k >= 0 && b.k <= 1)) return `open needs k in [0,1], got ${JSON.stringify(b.k)}`;
  if (b.currency !== undefined && typeof b.currency !== "string") return `open currency must be a string`;
  if (b.deadline !== undefined && (typeof b.deadline !== "string" || !Number.isFinite(Date.parse(b.deadline)))) return `open deadline must be an ISO timestamp`;
  return { side: b.side, rule: MECH_RULE, k: b.k, currency: typeof b.currency === "string" ? b.currency : undefined, deadline: typeof b.deadline === "string" ? b.deadline : undefined };
}

/** One side's commit/reveal, as read off the chain. */
interface Leg { side: Side; from: string; commitSeq: number; commitH: string; revealSeq?: number; bid?: number; nonce?: string }

export type MechStatus =
  | "no-open" | "awaiting-commits" | "awaiting-reveals" | "settled" | "void";

export interface MechResolution {
  status: MechStatus;
  /** Set when the instance is provably broken (sealing invariant, side/rule conflict, bad reveal).
   *  A void instance must never be treated as a settlement. */
  voidReason?: string;
  rules?: OpenRules;
  buy?: Leg;
  sell?: Leg;
  /** Only when status === "settled": the derived, authoritative outcome. */
  deal?: boolean;
  price?: number | null;
  /** Human-facing, always safe to show. */
  explanation: string;
}

/**
 * Resolve a mechanism instance from a room's (already chain-VERIFIED) messages and the seq of its
 * `open`. Callers must pass messages whose chain has verified — this reads terms, and unverified
 * bodies are not terms (same rule the commit gate follows).
 *
 * Precedence rules, so a flooder cannot rewrite an outcome: for each side the FIRST valid commit
 * counts and the FIRST matching reveal counts; later ones are ignored. Both legs must come from
 * distinct pubkeys taking opposite sides under the same open. The sealing invariant is enforced.
 */
export function resolveMechanism(msgs: Envelope[], openSeq: number, room: string): MechResolution {
  const open = msgs.find((m) => m.seq === openSeq && m.type === MECH_TYPE);
  if (!open) return { status: "no-open", explanation: `no mechanism open at seq ${openSeq}` };
  const rules = parseOpen(open.body);
  if (typeof rules === "string") return { status: "void", voidReason: rules, explanation: `mechanism #${openSeq} is void: ${rules}` };

  const inThis = msgs.filter((m) => m.type === MECH_TYPE && m.seq > openSeq);
  const legs: Partial<Record<Side, Leg>> = {};
  // First valid commit per side wins.
  for (const m of inThis) {
    const b = (m.body ?? {}) as Record<string, unknown>;
    if (b.phase !== "commit" || b.ref !== openSeq) continue;
    if ((b.side !== "buy" && b.side !== "sell") || typeof b.h !== "string" || !/^[0-9a-f]{64}$/.test(b.h)) continue;
    const side = b.side as Side;
    if (legs[side]) continue; // first commit for this side already taken
    // The opener stated its own side; the counterparty must take the other side. Both commits from
    // the same pubkey, or two commits on the same side, cannot form a two-party sealed bid.
    const otherLeg = legs[otherSide(side)];
    if (otherLeg && otherLeg.from === m.from) return void0Res(rules, legs, `both commits are from the same key ${m.from.slice(0, 12)} — a sealed bid needs two parties`);
    legs[side] = { side, from: m.from, commitSeq: m.seq, commitH: b.h };
  }
  const buy = legs.buy, sell = legs.sell;
  if (!buy || !sell) return { status: "awaiting-commits", rules, buy, sell, explanation: `mechanism #${openSeq}: ${[buy ? null : "buy", sell ? null : "sell"].filter(Boolean).join(" and ")} side has not committed yet` };

  // The sealing invariant: both commits must precede either reveal. Compute the reveal boundary from
  // the FIRST matching reveal on each side, then check ordering.
  const bothCommittedBy = Math.max(buy.commitSeq, sell.commitSeq);
  for (const leg of [buy, sell] as Leg[]) {
    for (const m of inThis) {
      const b = (m.body ?? {}) as Record<string, unknown>;
      if (b.phase !== "reveal" || b.ref !== openSeq || b.side !== leg.side || m.from !== leg.from) continue;
      if (m.seq <= bothCommittedBy) return void0Res(rules, legs, `a ${leg.side} reveal at seq ${m.seq} landed before both sides had committed (both committed by seq ${bothCommittedBy}) — the sealing invariant is broken, so this side could have chosen its bid knowing the other's`);
      if (leg.revealSeq !== undefined) continue; // first matching reveal already taken
      if (!isBid(b.bid) || typeof b.nonce !== "string") continue;
      if (!revealMatches(room, openSeq, leg.side, b.bid, b.nonce, leg.commitH)) return void0Res(rules, legs, `the ${leg.side} reveal at seq ${m.seq} does not open its commit (hash mismatch) — a party tried to change its bid after committing`);
      leg.revealSeq = m.seq; leg.bid = b.bid; leg.nonce = b.nonce;
    }
  }
  if (buy.revealSeq === undefined || sell.revealSeq === undefined) {
    return { status: "awaiting-reveals", rules, buy, sell, explanation: `mechanism #${openSeq}: both committed; waiting for ${[buy.revealSeq === undefined ? "buy" : null, sell.revealSeq === undefined ? "sell" : null].filter(Boolean).join(" and ")} to reveal` };
  }
  const { deal, price } = settlePrice(buy.bid!, sell.bid!, rules.k);
  const cur = rules.currency ? " " + rules.currency : "";
  return {
    status: "settled", rules, buy, sell, deal, price,
    explanation: deal
      ? `mechanism #${openSeq} settled: DEAL at ${price}${cur} (buy ${buy.bid} / sell ${sell.bid}, k=${rules.k})`
      : `mechanism #${openSeq} settled: NO DEAL (buy ${buy.bid} < sell ${sell.bid}) — both reservation values are now on the record`,
  };
}

function void0Res(rules: OpenRules, legs: Partial<Record<Side, Leg>>, reason: string): MechResolution {
  return { status: "void", voidReason: reason, rules, buy: legs.buy, sell: legs.sell, explanation: `mechanism is void: ${reason}` };
}
