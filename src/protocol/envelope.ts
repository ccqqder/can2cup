import { canon } from "./canon.js";
import { sha256Hex, signHex, verifyHex } from "./crypto.js";

export const PROTOCOL_VERSION = 1;

/** Closed set. `accept` and `grant` create commitments; `system` is relay-authored.
 *  grant      = a scoped, expiring permission (body: scope, expires, text) — for
 *               collaboration rooms where one side authorises the other to act.
 *  revoke     = withdraws an earlier grant (body: ref = seq of the grant).
 *  attachment = a pointer to material that does not fit in a message
 *               (body: name, url, sha256?) — the relay never stores the bytes.
 *  mechanism  = the brokerage layer (protocol/mechanism.ts): a sealed-bid k-double
 *               settlement carried in the body's `phase` (open / commit / reveal).
 *               Added after the original set — a room using it needs new clients on
 *               both sides, which it inherently does; an old client verifying such a
 *               room's chain would reject the unknown type. */
export const MSG_TYPES = [
  "text", "question", "proposal", "counter", "accept", "reject",
  "withdraw", "escalate", "grant", "revoke", "attachment", "close", "system",
  "mechanism",
] as const;
export const COMMITMENT_TYPES: readonly MsgType[] = ["accept", "grant"];
export type MsgType = (typeof MSG_TYPES)[number];

export const RELAY_SENDER = "relay";

/** What a participant signs. `prev` is the hash of the last stored envelope
 *  the sender has seen (or the genesis marker), which is what chains them. */
export interface Unsigned {
  v: number;
  room: string;
  from: string; // hex ed25519 pubkey, or "relay" for system events
  ts: string;   // ISO-8601 with offset
  type: MsgType;
  body: unknown;
  prev: string;
}

/** What the relay stores and returns. seq and hash are relay-assigned. */
export interface Envelope extends Unsigned {
  sig: string; // hex; for relay system events: the relay's signature (v0.3+) or "" (legacy relays)
  seq: number;
  hash: string;
}

export type Submitted = Unsigned & { sig: string };

export function genesis(room: string): string {
  return `genesis:${room}`;
}

export function signingBytes(u: Unsigned): string {
  const { v, room, from, ts, type, body, prev } = u;
  return canon({ v, room, from, ts, type, body, prev });
}

export function sign(u: Unsigned, privHex: string): Submitted {
  return { ...u, sig: signHex(signingBytes(u), privHex) };
}

export function computeHash(e: Omit<Envelope, "hash">): string {
  const { v, room, from, ts, type, body, prev, sig, seq } = e;
  return sha256Hex(canon({ v, room, from, ts, type, body, prev, sig, seq }));
}

export interface VerifyResult { ok: boolean; errors: string[]; note?: EnvelopeNote }

/** Why an envelope passed without being fully checked. Not an error — a gap in what was proven,
 *  which the chain-level verdict has to carry rather than swallow. */
export type EnvelopeNote = "system-unchecked" | "system-past-relay-key";

export interface VerifyOpts {
  /** The relay's ed25519 pubkey, once pinned. When set, every `system` event must carry a
   *  signature by it — an unsigned or wrongly-signed system event is an error. When unset
   *  (legacy relay / not yet pinned) the relay's signature is not checked either way. */
  relayPub?: string;
  /** Portable rooms (v0.4.15): relay keys this room lived under BEFORE a migration.
   *  System events from the old relay verify against any of these; participant
   *  signatures are unaffected — only the relay's own annotations change custody. */
  pastRelayPubs?: string[];
}

/** Verify one envelope against the previous hash. Used identically by the
 *  relay on ingest and by clients on receipt / on full-history audit. */
export function verifyEnvelope(e: Envelope, expectedPrev: string, opts: VerifyOpts = {}): VerifyResult {
  const errors: string[] = [];
  let note: EnvelopeNote | undefined;
  if (e.v !== PROTOCOL_VERSION) errors.push(`unsupported version ${e.v}`);
  if (!MSG_TYPES.includes(e.type)) errors.push(`unknown type ${e.type}`);
  if (e.prev !== expectedPrev) errors.push(`chain break: prev=${e.prev.slice(0, 12)} expected=${expectedPrev.slice(0, 12)}`);
  if (computeHash(e) !== e.hash) errors.push("hash mismatch");
  if (e.from === RELAY_SENDER) {
    if (e.type !== "system") errors.push("relay may only author system events");
    if (opts.relayPub) {
      const keys = [opts.relayPub, ...(opts.pastRelayPubs ?? [])];
      if (!e.sig) errors.push("unsigned system event (relay signing key is pinned)");
      else if (verifyHex(e.sig, signingBytes(e), opts.relayPub)) { /* current key: fully checked */ }
      else if (keys.some((k) => verifyHex(e.sig, signingBytes(e), k))) note = "system-past-relay-key";
      else errors.push("bad relay signature on system event");
    } else note = "system-unchecked"; // no pinned key: the relay's annotations are taken on trust
  } else {
    if (e.type === "system") errors.push("participants may not author system events");
    if (!verifyHex(e.sig, signingBytes(e), e.from)) errors.push("bad signature");
  }
  return { ok: errors.length === 0, errors, ...(note ? { note } : {}) };
}

/** v0.13.0: a verdict with three values instead of two.
 *
 *  A binary `ok` had to call the uncertain cases something, and it called them all `true`: a room whose
 *  relay key was never pinned (system events not checked at all), a room migrated between relays (system
 *  events verifying only against a PAST custodian's key), a transcript from a pre-signing relay. Those
 *  are not clean — they are unproven, and reporting them as clean overstates what was checked.
 *
 *  The asymmetry that matters: a false CLEAN is the worst outcome, a false REFUTED is second worst,
 *  INCONCLUSIVE is always safe. So any path that did not actually prove something says so. */
export type Verdict = "CLEAN" | "REFUTED" | "INCONCLUSIVE";

/** How much of the transcript the verdict actually covers. "Verified" without "how much of it" is not
 *  a claim anyone can act on: `envelopes_checked` vs `participant_sigs_verified` is the honest number. */
export interface Coverage {
  envelopes_checked: number;
  participant_sigs_verified: number;
  system_events_verified: number;
  system_events_unchecked: number;
  system_events_past_relay_key: number;
  relay_pub_pinned: boolean;
}

export interface ChainResult {
  /** Unchanged meaning: no hard failure. CLEAN and INCONCLUSIVE are both `true` — this is an added
   *  axis, not a replacement, so no existing caller changes behaviour by upgrading. */
  ok: boolean;
  verdict: Verdict;
  /** One sentence a human can act on. Empty for CLEAN. */
  explanation: string;
  coverage: Coverage;
  failedAt?: number;
  errors: string[];
}

/** Verify a whole transcript from genesis. */
export function verifyChain(room: string, msgs: Envelope[], opts: VerifyOpts = {}): ChainResult {
  let prev = genesis(room);
  let expectSeq = 1;
  const cov: Coverage = {
    envelopes_checked: 0, participant_sigs_verified: 0,
    system_events_verified: 0, system_events_unchecked: 0, system_events_past_relay_key: 0,
    relay_pub_pinned: !!opts.relayPub,
  };
  const refuted = (failedAt: number, errors: string[]): ChainResult =>
    ({ ok: false, verdict: "REFUTED", explanation: errors[0] ?? "chain verification failed", coverage: cov, failedAt, errors });
  for (const m of msgs) {
    if (m.seq !== expectSeq) return refuted(m.seq, [`seq gap: got ${m.seq} expected ${expectSeq}`]);
    // v0.14.5 (seventh opinion #9): the envelope must belong to THIS room. The relay's append path checks it; the
    // read/import paths that trust this function did not, so a validly signed message from room B chained onto
    // room A's genesis verified CLEAN as room A.
    if (m.room !== room) return refuted(m.seq, [`envelope.room mismatch: ${String(m.room).slice(0, 16)} in a transcript of ${room.slice(0, 16)}`]);
    const r = verifyEnvelope(m, prev, opts);
    if (!r.ok) return refuted(m.seq, r.errors);
    cov.envelopes_checked++;
    if (m.from === RELAY_SENDER) {
      if (r.note === "system-unchecked") cov.system_events_unchecked++;
      else if (r.note === "system-past-relay-key") { cov.system_events_past_relay_key++; cov.system_events_verified++; }
      else cov.system_events_verified++;
    } else cov.participant_sigs_verified++;
    prev = m.hash;
    expectSeq++;
  }
  const gaps: string[] = [];
  if (cov.system_events_unchecked) gaps.push(`${cov.system_events_unchecked} system event(s) were not checked at all: this room has no pinned relay signing key, so the relay's own annotations are taken on trust`);
  if (cov.system_events_past_relay_key) gaps.push(`${cov.system_events_past_relay_key} system event(s) verify only against a PREVIOUS relay key — this room was migrated, which is a change of custody`);
  if (!gaps.length) return { ok: true, verdict: "CLEAN", explanation: "", coverage: cov, errors: [] };
  return {
    ok: true, verdict: "INCONCLUSIVE", coverage: cov, errors: [],
    explanation: `${gaps.join("; ")}. Every participant signature and the hash chain itself do check out (${cov.participant_sigs_verified}/${cov.envelopes_checked} envelopes authored by participants) — but the gap means no CLEAN verdict can be issued over the whole room.`,
  };
}

// ---------------------------------------------------------- signed head ---

/** The relay's periodic commitment to a room's transcript: "at `at`, the chain ended at
 *  (seq, hash)". Signed with the relay key. A client that keeps the newest head it has
 *  seen can later prove tail-truncation (relay serves seq < head.seq) or a fork (relay's
 *  hash at head.seq ≠ head.hash). It does not stop the relay from doing either — it makes
 *  it provable. */
export interface Head { room: string; seq: number; hash: string; at: string; sig: string }

export function headSigningBytes(h: Omit<Head, "sig">): string {
  const { room, seq, hash, at } = h;
  return canon({ room, seq, hash, at });
}
export function signHead(h: Omit<Head, "sig">, relayPriv: string): Head {
  return { ...h, sig: signHex(headSigningBytes(h), relayPriv) };
}
export function verifyHead(h: Head, relayPub: string): boolean {
  return !!h && typeof h.sig === "string" && verifyHex(h.sig, headSigningBytes(h), relayPub);
}
