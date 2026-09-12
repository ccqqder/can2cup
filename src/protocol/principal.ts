/**
 * Principal-signed messages — the principal → agent channel, end to end.
 *
 * v0.2 and earlier: whatever the bridge put in an agent's inbox was shown to the model as
 * "principal instructions", and the only thing standing between an attacker and that label
 * was the bot's shared BRIDGE_KEY (2026-08-19 review, F1/F7). v0.3 gives the principal an
 * ed25519 keypair of their own (`~/.parley/principal.json`). An instruction or a pause that
 * carries a valid signature by THAT key — addressed to THIS agent, with a fresh nonce — is
 * the only thing the MCP server will ever label as verified. The relay and the bot can still
 * write unsigned items; those stay explicitly unverified.
 *
 * The signature covers `agent`, so a message signed for one agent cannot be replayed to
 * another; `nonce` lets the receiver refuse the same message twice; `at` orders pauses.
 * `approve` binds an approval to a concrete envelope (room, seq, hash), so an approval can
 * never be re-aimed at a different decision than the one the principal looked at (F6).
 */
import { canon } from "./canon.js";
import { randomHex, signHex, verifyHex } from "./crypto.js";

export interface ApproveRef { room: string; seq: number; hash: string; ok: boolean }

export interface PrincipalMsg {
  kind: "say" | "pause";
  agent: string;   // the agent's pubkey this is addressed to
  at: string;      // ISO-8601
  nonce: string;   // random hex; receivers keep a seen-set
  text?: string;   // say
  paused?: boolean; // pause
  approve?: ApproveRef; // say: this text is a decision on one specific envelope
}
export interface SignedPrincipalMsg extends PrincipalMsg { pub: string; sig: string }

export function principalSigningBytes(m: PrincipalMsg): string {
  const { kind, agent, at, nonce, text, paused, approve } = m;
  return canon({ kind, agent, at, nonce, text, paused, approve });
}

export function signPrincipal(m: Omit<PrincipalMsg, "at" | "nonce"> & Partial<Pick<PrincipalMsg, "at" | "nonce">>, priv: string, pub: string): SignedPrincipalMsg {
  const full: PrincipalMsg = { ...m, at: m.at ?? new Date().toISOString(), nonce: m.nonce ?? randomHex(16) };
  return { ...full, pub, sig: signHex(principalSigningBytes(full), priv) };
}

/** Structural + cryptographic check. `expectedPub` = the principal key the verifier trusts
 *  (the agent pins its own principal.json pubkey; the bridge pins what the agent registered);
 *  `expectedAgent` = the verifier's own agent pubkey. */
export function verifyPrincipal(s: SignedPrincipalMsg, expectedPub: string, expectedAgent: string): { ok: boolean; error?: string } {
  if (!s || typeof s !== "object") return { ok: false, error: "not a message" };
  if (s.kind !== "say" && s.kind !== "pause") return { ok: false, error: "bad kind" };
  if (!/^[0-9a-f]{64}$/.test(s.pub ?? "")) return { ok: false, error: "bad pub" };
  if (s.pub !== expectedPub) return { ok: false, error: "signed by a key that is not your principal's" };
  if (s.agent !== expectedAgent) return { ok: false, error: "addressed to a different agent" };
  if (typeof s.nonce !== "string" || s.nonce.length < 16) return { ok: false, error: "bad nonce" };
  if (!Number.isFinite(Date.parse(s.at ?? ""))) return { ok: false, error: "bad timestamp" };
  if (s.kind === "say" && typeof s.text !== "string") return { ok: false, error: "say without text" };
  if (s.kind === "pause" && typeof s.paused !== "boolean") return { ok: false, error: "pause without paused flag" };
  if (!verifyHex(s.sig, principalSigningBytes(s), s.pub)) return { ok: false, error: "bad principal signature" };
  return { ok: true };
}

// ------------------------------------------------ sealed-bid authorisation ---

/**
 * The principal's authorisation of ONE sealed bid for the brokerage layer (protocol/mechanism.ts).
 *
 * The bid must never travel on the chain (that would show the counterparty your reservation value
 * before the sealed mechanism even runs) and must never be the agent's own choice under a widened
 * mandate (that is the exact hole the commit gate closes). So the principal signs the figure with
 * ~/.parley/principal.json on the agent's OWN machine — the file is stored locally and read by the
 * agent's commit; nothing goes through the relay. `agent` binds it to one agent (no cross-agent
 * replay); `nonce` both hides the bid inside sealDigest and is the seal's nonce, so one signed
 * object is both the authorisation and the secret the reveal later opens.
 */
export interface SealedBid {
  room: string; open: number; side: "buy" | "sell"; amount: number; nonce: string;
  agent: string; // the agent pubkey this authorises
  at: string;    // ISO-8601
}
export interface SignedSealedBid extends SealedBid { pub: string; sig: string }

export function sealedBidSigningBytes(b: SealedBid): string {
  const { room, open, side, amount, nonce, agent, at } = b;
  return canon({ room, open, side, amount, nonce, agent, at });
}

export function signSealedBid(b: Omit<SealedBid, "at" | "nonce"> & Partial<Pick<SealedBid, "at" | "nonce">>, priv: string, pub: string): SignedSealedBid {
  const full: SealedBid = { ...b, at: b.at ?? new Date().toISOString(), nonce: b.nonce ?? randomHex(16) };
  return { ...full, pub, sig: signHex(sealedBidSigningBytes(full), priv) };
}

/** Structural + cryptographic check. `expectedPub` = the agent's own principal.json pubkey;
 *  `expectedAgent` = the agent's own pubkey (a bid must authorise THIS agent). */
export function verifySealedBid(s: SignedSealedBid, expectedPub: string, expectedAgent: string): { ok: boolean; error?: string } {
  if (!s || typeof s !== "object") return { ok: false, error: "not a sealed bid" };
  if (typeof s.room !== "string" || !s.room) return { ok: false, error: "bad room" };
  if (!Number.isInteger(s.open) || s.open < 1) return { ok: false, error: "bad open seq" };
  if (s.side !== "buy" && s.side !== "sell") return { ok: false, error: "bad side" };
  if (typeof s.amount !== "number" || !Number.isFinite(s.amount) || s.amount < 0 || !Number.isInteger(s.amount)) return { ok: false, error: "amount must be a non-negative whole number" };
  if (typeof s.nonce !== "string" || s.nonce.length < 16) return { ok: false, error: "bad nonce" };
  if (!/^[0-9a-f]{64}$/.test(s.pub ?? "")) return { ok: false, error: "bad pub" };
  if (s.pub !== expectedPub) return { ok: false, error: "signed by a key that is not your principal's" };
  if (s.agent !== expectedAgent) return { ok: false, error: "authorises a different agent" };
  if (!Number.isFinite(Date.parse(s.at ?? ""))) return { ok: false, error: "bad timestamp" };
  if (!verifyHex(s.sig, sealedBidSigningBytes(s), s.pub)) return { ok: false, error: "bad principal signature" };
  return { ok: true };
}

// ------------------------------------------------ signed HTTP requests ---

/** Requests that must prove possession of a key (agent → bridge, agent → room admin ops,
 *  principal → bridge) carry three headers and sign "METHOD\nPATH\nTS\nBODY". The relay
 *  checks the timestamp is within ±5 minutes. Same scheme for every key role, so one helper. */
export const REQ_SIG_SKEW_MS = 5 * 60 * 1000;

export function requestSigningBytes(method: string, path: string, ts: string, body: string): string {
  return `${method}\n${path}\n${ts}\n${body}`;
}

export function signRequestHeaders(method: string, path: string, body: string, key: { pub: string; priv: string }, prefix = "x-parley"): Record<string, string> {
  const ts = new Date().toISOString();
  return {
    [`${prefix}-pub`]: key.pub,
    [`${prefix}-ts`]: ts,
    [`${prefix}-sig`]: signHex(requestSigningBytes(method, path, ts, body), key.priv),
  };
}

export function verifyRequestHeaders(
  h: (name: string) => string | undefined, method: string, path: string, body: string, prefix = "x-parley", now = Date.now(),
): { ok: true; pub: string } | { ok: false; error: string } {
  const pub = h(`${prefix}-pub`) ?? "";
  const ts = h(`${prefix}-ts`) ?? "";
  const sig = h(`${prefix}-sig`) ?? "";
  if (!/^[0-9a-f]{64}$/.test(pub) || !ts || !sig) return { ok: false, error: "missing signature headers" };
  if (Math.abs(now - Date.parse(ts)) > REQ_SIG_SKEW_MS) return { ok: false, error: "signature timestamp too old" };
  if (!verifyHex(sig, requestSigningBytes(method, path, ts, body), pub)) return { ok: false, error: "bad signature" };
  return { ok: true, pub };
}

// ---- v0.15.2: "this agent is mine" — the registration proof behind the principal-scoped dashboard ----------
//
// /p/principal used to take a self-asserted principalPub: any agent could register anyone's key. The claim below
// is signed by the PRINCIPAL key over the agent it vouches for, the relay it is meant for and a timestamp, so a
// stranger's agent cannot list itself under your principal, a claim cannot be moved to another agent or replayed
// at another relay, and an old claim cannot be re-registered (±AGENT_CLAIM_SKEW_MS at registration time; a claim
// the relay has already verified stays valid until the principal changes). A dedicated format, deliberately not a
// PrincipalMsg: those are instructions to the agent and carry a nonce ledger on the client side; this is a fact
// about custody, verified once on the relay.
export interface AgentClaim { kind: "claim-agent"; agent: string; principalPub: string; relayPub: string; at: string; nonce: string }
export interface SignedAgentClaim extends AgentClaim { pub: string; sig: string }
export const AGENT_CLAIM_SKEW_MS = 5 * 60 * 1000;

export function agentClaimSigningBytes(c: AgentClaim): string {
  const { kind, agent, principalPub, relayPub, at, nonce } = c;
  return canon({ kind, agent, principalPub, relayPub, at, nonce });
}
export function signAgentClaim(c: { agent: string; principalPub: string; relayPub: string }, priv: string, pub: string): SignedAgentClaim {
  const full: AgentClaim = { kind: "claim-agent", agent: c.agent, principalPub: c.principalPub, relayPub: c.relayPub, at: new Date().toISOString(), nonce: randomHex(16) };
  return { ...full, pub, sig: signHex(agentClaimSigningBytes(full), priv) };
}
/** `expected.agent` = the caller the relay authenticated (the /p/* signature); `expected.relayPub` = this relay's own
 *  signing key ("" for a legacy unsigned relay). The signer IS the principal: s.pub must equal s.principalPub. */
export function verifyAgentClaim(s: SignedAgentClaim, expected: { agent: string; relayPub: string; now?: number }): { ok: boolean; error?: string } {
  if (!s || typeof s !== "object") return { ok: false, error: "not a claim" };
  if (s.kind !== "claim-agent") return { ok: false, error: "bad kind" };
  for (const k of ["pub", "principalPub", "agent"] as const) if (!/^[0-9a-f]{64}$/.test(String(s[k] ?? ""))) return { ok: false, error: `bad ${k}` };
  if (s.pub !== s.principalPub) return { ok: false, error: "the claim must be signed by the principal key it names" };
  if (s.agent !== expected.agent) return { ok: false, error: "claim is for a different agent" };
  if (typeof s.relayPub !== "string" || s.relayPub !== expected.relayPub) return { ok: false, error: "claim is for a different relay" };
  if (typeof s.nonce !== "string" || s.nonce.length < 16) return { ok: false, error: "bad nonce" };
  const at = Date.parse(s.at ?? "");
  if (!Number.isFinite(at)) return { ok: false, error: "bad timestamp" };
  if (Math.abs((expected.now ?? Date.now()) - at) > AGENT_CLAIM_SKEW_MS) return { ok: false, error: "claim is not fresh (±5 min)" };
  if (!verifyHex(s.sig, agentClaimSigningBytes(s), s.pub)) return { ok: false, error: "bad principal signature" };
  return { ok: true };
}
