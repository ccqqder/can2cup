/**
 * Pure unit test for the brokerage layer (protocol/mechanism.ts). No relay, no network:
 * it builds signed, chained envelopes in memory and drives resolveMechanism through the
 * cases that matter — the k-double price, the commit/reveal hash binding, and above all the
 * sealing invariant (both commits before either reveal).
 *
 *   npm run build && node dist/scripts/mechanism-test.js
 */
import {
  newKeypair, sign, computeHash, genesis, randomHex, type Envelope, type Submitted,
  sealDigest, revealMatches, settlePrice, resolveMechanism, MECH_TYPE, isBid,
  checkMandate, normalizeMandateRules, type MandateRules,
  signSealedBid, verifySealedBid,
  bindAcceptTerms, liveGrants, readSendFields, buildSendBody, verifyChain, canon, verifyManifest, signHex,
} from "../protocol/index.js";

let passed = 0;
function expect(cond: unknown, msg: string): void {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  passed++;
}

const ROOM = "room-mech-test";
const seller = newKeypair();
const buyer = newKeypair();

/** Build a verified chain from a script of messages authored by given keys. */
function chain(items: { key: { priv: string; pub: string }; type: string; body: unknown }[]): Envelope[] {
  const out: Envelope[] = [];
  let prev = genesis(ROOM);
  let seq = 1;
  for (const it of items) {
    const u = { v: 1, room: ROOM, from: it.key.pub, ts: new Date().toISOString(), type: it.type as Envelope["type"], body: it.body, prev };
    const s: Submitted = sign(u, it.key.priv);
    const hash = computeHash({ ...s, seq });
    const e: Envelope = { ...s, seq, hash };
    out.push(e);
    prev = hash; seq++;
  }
  return out;
}

const commitBody = (side: "buy" | "sell", openSeq: number, bid: number, nonce: string) =>
  ({ phase: "commit", ref: openSeq, side, h: sealDigest(ROOM, openSeq, side, bid, nonce) });
const revealBody = (side: "buy" | "sell", openSeq: number, bid: number, nonce: string) =>
  ({ phase: "reveal", ref: openSeq, side, bid, nonce });
const openBody = (side: "buy" | "sell", k = 0.5) => ({ phase: "open", side, rule: "k-double", k, currency: "TWD" });

// ---------------------------------------------------------------- pure functions ---

expect(isBid(2900) && !isBid(2900.5) && !isBid(-1) && !isBid("2900"), "isBid: non-negative integers only");

const nb = randomHex(16);
expect(revealMatches(ROOM, 1, "buy", 3000, nb, sealDigest(ROOM, 1, "buy", 3000, nb)), "revealMatches: correct opening verifies");
expect(!revealMatches(ROOM, 1, "buy", 3001, nb, sealDigest(ROOM, 1, "buy", 3000, nb)), "revealMatches: a changed bid does not open the commit");
expect(!revealMatches(ROOM, 1, "buy", 3000, randomHex(16), sealDigest(ROOM, 1, "buy", 3000, nb)), "revealMatches: a changed nonce does not open the commit");
expect(sealDigest(ROOM, 1, "buy", 3000, nb) !== sealDigest(ROOM, 1, "sell", 3000, nb), "sealDigest: side is bound (buy != sell)");
expect(sealDigest(ROOM, 1, "buy", 3000, nb) !== sealDigest(ROOM, 2, "buy", 3000, nb), "sealDigest: mech instance is bound (open seq)");

expect(JSON.stringify(settlePrice(3500, 2400, 0.5)) === JSON.stringify({ deal: true, price: 2950 }), "settlePrice: k=0.5 splits the difference");
expect(settlePrice(3500, 2400, 0).price === 2400, "settlePrice: k=0 gives the buyer the whole surplus (price = ask)");
expect(settlePrice(3500, 2400, 1).price === 3500, "settlePrice: k=1 gives the seller the whole surplus (price = bid)");
expect(settlePrice(2000, 2500, 0.5).deal === false, "settlePrice: no deal when bids do not cross");
expect(settlePrice(2401, 2400, 0.5).price === 2401, "settlePrice: rounds to a whole unit");

// ---------------------------------------------------------------- happy path ---

{
  const nS = randomHex(16), nB = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },              // 1 open
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2400, nS) }, // 2 sell commit
    { key: buyer, type: MECH_TYPE, body: commitBody("buy", 1, 3500, nB) },   // 3 buy commit
    { key: buyer, type: MECH_TYPE, body: revealBody("buy", 1, 3500, nB) },   // 4 buy reveal
    { key: seller, type: MECH_TYPE, body: revealBody("sell", 1, 2400, nS) }, // 5 sell reveal
  ]);
  const r = resolveMechanism(msgs, 1, ROOM);
  expect(r.status === "settled", `happy path settles (got ${r.status}: ${r.explanation})`);
  expect(r.deal === true && r.price === 2950, `happy path deals at midpoint 2950 (got ${r.price})`);
}

// ---------------------------------------------------------------- awaiting states ---

{
  const nS = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2400, nS) },
  ]);
  expect(resolveMechanism(msgs, 1, ROOM).status === "awaiting-commits", "one commit → awaiting-commits");
}
{
  const nS = randomHex(16), nB = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2400, nS) },
    { key: buyer, type: MECH_TYPE, body: commitBody("buy", 1, 3500, nB) },
    { key: buyer, type: MECH_TYPE, body: revealBody("buy", 1, 3500, nB) },
  ]);
  expect(resolveMechanism(msgs, 1, ROOM).status === "awaiting-reveals", "both commit, one reveal → awaiting-reveals");
}

// ---------------------------------------------------------------- the sealing invariant ---

{
  // buy reveals at seq 3, BEFORE sell commits at seq 4 → the seal is broken.
  const nS = randomHex(16), nB = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },               // 1
    { key: buyer, type: MECH_TYPE, body: commitBody("buy", 1, 3500, nB) },   // 2 buy commit
    { key: buyer, type: MECH_TYPE, body: revealBody("buy", 1, 3500, nB) },   // 3 buy reveal (too early)
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2400, nS) }, // 4 sell commit
    { key: seller, type: MECH_TYPE, body: revealBody("sell", 1, 2400, nS) }, // 5 sell reveal
  ]);
  const r = resolveMechanism(msgs, 1, ROOM);
  expect(r.status === "void", `early reveal voids the instance (got ${r.status})`);
  expect(/sealing invariant/.test(r.voidReason ?? ""), "void reason names the sealing invariant");
}

// ---------------------------------------------------------------- tamper: changed bid ---

{
  const nB = randomHex(16), nS = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2400, nS) },
    { key: buyer, type: MECH_TYPE, body: commitBody("buy", 1, 3500, nB) },  // committed 3500
    { key: buyer, type: MECH_TYPE, body: revealBody("buy", 1, 2500, nB) },  // reveals 2500 — a lie
    { key: seller, type: MECH_TYPE, body: revealBody("sell", 1, 2400, nS) },
  ]);
  const r = resolveMechanism(msgs, 1, ROOM);
  expect(r.status === "void" && /hash mismatch/.test(r.voidReason ?? ""), "revealing a different bid than committed voids the instance");
}

// ---------------------------------------------------------------- two commits, same key ---

{
  const n1 = randomHex(16), n2 = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2400, n1) },
    { key: seller, type: MECH_TYPE, body: commitBody("buy", 1, 3500, n2) }, // same key takes both sides
  ]);
  const r = resolveMechanism(msgs, 1, ROOM);
  expect(r.status === "void" && /two parties/.test(r.voidReason ?? ""), "one key cannot hold both sides");
}

// ---------------------------------------------------------------- no deal ---

{
  const nS = randomHex(16), nB = randomHex(16);
  const msgs = chain([
    { key: seller, type: MECH_TYPE, body: openBody("sell") },
    { key: seller, type: MECH_TYPE, body: commitBody("sell", 1, 2500, nS) },
    { key: buyer, type: MECH_TYPE, body: commitBody("buy", 1, 2000, nB) },
    { key: buyer, type: MECH_TYPE, body: revealBody("buy", 1, 2000, nB) },
    { key: seller, type: MECH_TYPE, body: revealBody("sell", 1, 2500, nS) },
  ]);
  const r = resolveMechanism(msgs, 1, ROOM);
  expect(r.status === "settled" && r.deal === false, "bids that do not cross settle as NO DEAL");
}

// ---------------------------------------------------------------- mandate coupling ---

const mand = (over: Partial<MandateRules> = {}): MandateRules =>
  ({ never_disclose: [], may_grant: [], max_commit_amount: 3000, currency: "TWD", max_grant_hours: 24, ...over });

// A reveal above the cap is blocked — the bid is plaintext by now, so the cap bites here.
expect(checkMandate(mand(), "mechanism", { phase: "reveal", ref: 1, side: "buy", bid: 3100, nonce: "aa" }) !== null,
  "mandate: a revealed bid over max_commit_amount is blocked");
expect(checkMandate(mand(), "mechanism", { phase: "reveal", ref: 1, side: "buy", bid: 2900, nonce: "aa" }) === null,
  "mandate: a revealed bid within the cap passes");

// The bid is authorised disclosure: a reveal whose bid equals a never_disclose value is NOT blocked for that,
// while the same string elsewhere in the body still is.
expect(checkMandate(mand({ never_disclose: ["2400"], max_commit_amount: null }), "mechanism", { phase: "reveal", ref: 1, side: "sell", bid: 2400, nonce: "bb" }) === null,
  "mandate: never_disclose does not fire on the sealed bid itself");
expect(checkMandate(mand({ never_disclose: ["2400"], max_commit_amount: null }), "mechanism", { phase: "reveal", ref: 1, side: "sell", bid: 2500, nonce: "cc", note: "our floor is 2400" }) !== null,
  "mandate: never_disclose still fires on a never_disclose string elsewhere in a reveal");

// A commit body is just a hash — nothing to cap, and it passes even with a low cap.
expect(checkMandate(mand({ max_commit_amount: 1 }), "mechanism", { phase: "commit", ref: 1, side: "buy", h: "ab".repeat(32) }) === null,
  "mandate: a commit (hash only) is not capped");

// open carries the currency term; a foreign currency is refused.
expect(checkMandate(mand(), "mechanism", { phase: "open", side: "sell", rule: "k-double", k: 0.5, currency: "USD" }) !== null,
  "mandate: an open in a currency other than the mandate's is blocked");

// ---------------------------------------------------------------- self-preservation list (§1) ---
// The brake rises from AMOUNT to DECISION TYPE: a message within every numeric bound is still HELD when
// its type is on require_confirm, and that hold is worded distinctly from a hard block so callers can tell
// "you cannot" from "go ask your principal".
expect(checkMandate(mand({ require_confirm: ["accept"] }), "accept", { amount: 2000 }) !== null,
  "self-preservation: an in-cap accept is HELD when 'accept' is on the list");
expect(checkMandate(mand({ require_confirm: ["accept"] }), "accept", { amount: 2000 })?.startsWith("held for principal confirmation") === true,
  "self-preservation: the hold reads as a confirmation hold, not a hard block");
expect(checkMandate(mand({ require_confirm: ["accept"] }), "counter", { amount: 2000 }) === null,
  "self-preservation: a type NOT on the list still passes (the list is per decision type)");
expect(checkMandate(mand({ require_confirm: [] }), "accept", { amount: 2000 }) === null,
  "self-preservation: empty list = current behaviour, nothing held");
expect(checkMandate(mand(), "accept", { amount: 2000 }) === null,
  "self-preservation: absent list (undefined) is a safe no-op, not a crash");
// A message BOTH over-cap and on the list reports the hard cap first — "you cannot" before "go ask".
expect(checkMandate(mand({ require_confirm: ["counter"], max_commit_amount: 3000 }), "counter", { amount: 9999 })?.includes("max_commit_amount") === true,
  "self-preservation: a hard cap breach outranks the confirmation hold");
// An unknown string on the list never fires — a principal's typo cannot silently freeze a real type.
expect(checkMandate(mand({ require_confirm: ["acccept"] }), "accept", { amount: 2000 }) === null,
  "self-preservation: an unrecognised type string is a safe no-op");

// ------------------------------------------------------- sixth opinion: mandate config hardening ---
const raw = (over: Record<string, unknown>): MandateRules => ({ never_disclose: [], may_grant: [], max_commit_amount: 3000, currency: "TWD", max_grant_hours: 24, ...over }) as unknown as MandateRules;

// #1 FAIL-CLOSED: a malformed cap must NOT read as "no limit". A string cap → coerced to 0 → any amount blocked.
expect(checkMandate(raw({ max_commit_amount: "oops" }), "proposal", { amount: 1000 }) !== null,
  "sixth #1: a non-number max_commit_amount fails CLOSED (blocks), never opens the cap");
expect(normalizeMandateRules({ max_commit_amount: "oops" }).max_commit_amount === 0,
  "sixth #1: normalizeMandateRules collapses a malformed cap to 0 (most restrictive)");
expect(normalizeMandateRules({ max_commit_amount: null }).max_commit_amount === null,
  "sixth #1: an explicit null is preserved as 'no cap' (only null means unlimited)");
// #1 grant hours: a string max_grant_hours must not widen the window (string concat used to allow "10.01" etc.).
expect(checkMandate(raw({ may_grant: ["read:*"], max_grant_hours: "1" }), "grant", { scope: "read:logs", expires: new Date(Date.now() + 2 * 3.6e6).toISOString() }) !== null,
  "sixth #1: a non-number max_grant_hours fails closed (0h), so a 2h grant is blocked");

// #7 require_confirm normalisation: a case/space typo must still hold, not fail open.
expect(checkMandate(raw({ require_confirm: ["ACCEPT"] }), "accept", { amount: 100 })?.startsWith("held") === true,
  "sixth #7: require_confirm is case-insensitive — [\"ACCEPT\"] still holds an accept");
expect(checkMandate(raw({ require_confirm: [" accept "] }), "accept", { amount: 100 })?.startsWith("held") === true,
  "sixth #7: require_confirm entries are trimmed — [\" accept \"] still holds");

// #9 reveal bid must be a SAFE integer (a value past 2^53 is not a trustworthy cap compare).
expect(checkMandate(raw({ max_commit_amount: null }), "mechanism", { phase: "reveal", ref: 1, side: "buy", bid: Number.MAX_SAFE_INTEGER + 2, nonce: "aa" }) !== null,
  "sixth #9: a reveal bid beyond MAX_SAFE_INTEGER is refused");

// #10 grant expiry must be a real ISO instant with a timezone, and in the future.
const futureISO = new Date(Date.now() + 2 * 3.6e6).toISOString();
expect(checkMandate(raw({ may_grant: ["read:*"], max_grant_hours: 24 }), "grant", { scope: "read:logs", expires: futureISO }) === null,
  "sixth #10: a valid future ISO grant within the window passes");
expect(checkMandate(raw({ may_grant: ["read:*"] }), "grant", { scope: "read:logs", expires: "01/02/2000" }) !== null,
  "sixth #10: a non-ISO locale date is refused");
expect(checkMandate(raw({ may_grant: ["read:*"] }), "grant", { scope: "read:logs", expires: "2000-01-01T00:00:00Z" }) !== null,
  "sixth #10: an expiry in the past is refused");
expect(checkMandate(raw({ may_grant: ["read:*"] }), "grant", { scope: "read:logs", expires: [futureISO] as unknown as string }) !== null,
  "sixth #10: an array expiry (String()-coerced before) is refused");

// #11 minor field validation.
expect(checkMandate(raw({}), "revoke", { ref: -1 }) !== null, "sixth #11: a negative revoke ref is refused");
expect(checkMandate(raw({}), "revoke", { ref: 1.5 }) !== null, "sixth #11: a non-integer revoke ref is refused");
expect(checkMandate(raw({}), "revoke", { ref: 3 }) === null, "sixth #11: a positive integer revoke ref passes");
expect(checkMandate(raw({ may_grant: ["read:*"] }), "grant", { scope: "   ", expires: futureISO }) !== null, "sixth #11: an all-whitespace scope is refused");
expect(checkMandate(raw({}), "attachment", { url: "https://" }) !== null, "sixth #11: 'https://' with no host is refused");
expect(checkMandate(raw({}), "attachment", { url: "http://example.com/x" }) !== null, "sixth #11: a plain http URL is refused (https only)");
expect(checkMandate(raw({}), "attachment", { url: "https://example.com/x" }) === null, "sixth #11: a valid https URL passes");

// ---------------------------------------------------------------- sealed-bid authorisation ---

{
  const principal = newKeypair();     // the human's principal key
  const agent = newKeypair();         // the agent this bid authorises
  const stranger = newKeypair();
  const sb = signSealedBid({ room: ROOM, open: 1, side: "buy", amount: 3000, agent: agent.pub }, principal.priv, principal.pub);

  expect(verifySealedBid(sb, principal.pub, agent.pub).ok, "sealed bid: verifies for its principal and agent");
  expect(!verifySealedBid(sb, stranger.pub, agent.pub).ok, "sealed bid: a key that is not the principal's is rejected");
  expect(!verifySealedBid(sb, principal.pub, stranger.pub).ok, "sealed bid: a bid for another agent is rejected");
  expect(!verifySealedBid({ ...sb, amount: 3500 }, principal.pub, agent.pub).ok, "sealed bid: tampering with the amount breaks the signature");
  // The commit hash the agent will send is reproducible from the signed bid — this is what couples the
  // principal's authorisation to the on-chain commitment.
  expect(sealDigest(sb.room, sb.open, sb.side, sb.amount, sb.nonce).length === 64, "sealed bid: its digest is the commit hash the agent sends");
}

// ------------------------------------------------------------ seventh opinion (0.14.5) ---
{
  // #1 canon: an own "__proto__" key (what JSON.parse produces) is IN the signed bytes, not swallowed.
  expect(canon(JSON.parse('{"b":1,"__proto__":"x","a":2}')) === '{"__proto__":"x","a":2,"b":1}', "seventh #1: canon keeps an own __proto__ key");
  expect(canon({ a: 1 }) === '{"a":1}' && canon({ b: [{ d: 1, c: 2 }], a: undefined }) === '{"b":[{"c":2,"d":1}]}', "seventh #1: canonical form is otherwise unchanged (existing signatures still verify)");
  const proto = JSON.parse('{"a":1,"__proto__":{"amount":9000}}') as Record<string, unknown>;
  expect(checkMandate(raw({ never_disclose: ["9000"] }), "text", proto) !== null, "seventh #1: never_disclose scans a __proto__ field too");
  // #1 manifest: the file table is a strict schema; the hash checked is the can2cup.tgz entry's.
  const relKey = newKeypair();
  const good = { v: 1, version: "1.0.0", date: "2026-09-10", files: { "can2cup.tgz": "a".repeat(64) } };
  expect(verifyManifest(good, signHex(canon(good), relKey.priv), [relKey.pub]).ok, "seventh #1: a well-formed signed manifest verifies");
  const injected = JSON.parse(JSON.stringify(good).replace('"files":{', '"files":{"__proto__":"' + "b".repeat(64) + '",')) as unknown;
  expect(!verifyManifest(injected, signHex(canon(good), relKey.priv), [relKey.pub]).ok, "seventh #1: an injected __proto__ file entry is refused (schema), and its bytes no longer match the signature either");
  expect(!verifyManifest({ ...good, files: { "can2cup.tgz": "zz" } }, signHex(canon({ ...good, files: { "can2cup.tgz": "zz" } }), relKey.priv), [relKey.pub]).ok, "seventh #1: a non-sha256 hash value is refused");
  expect(!verifyManifest({ ...good, files: { "parley.tgz": "a".repeat(64) } }, signHex(canon({ ...good, files: { "parley.tgz": "a".repeat(64) } }), relKey.priv), [relKey.pub]).ok, "seventh #1: a manifest without the can2cup.tgz entry is refused");

  // #4 terms are flat: a nested price is refused by the mandate on both floors, and an accept refuses such a target.
  expect(checkMandate(raw({ max_commit_amount: 0 }), "proposal", { text: "x", items: [{ amount: 9000 }] }) !== null, "seventh #4: a proposal with a nested amount structure is refused under a 0 cap");
  expect(checkMandate(raw({ max_commit_amount: 0 }), "accept", { text: "x", ref: 1, terms: { price: 9000 } }) !== null, "seventh #4: an accept carrying a nested object is refused");
  expect(checkMandate(raw({ max_commit_amount: 0 }), "text", { text: "x", items: [{ amount: 9000 }] }) === null, "seventh #4: a plain text with structured fields is not a commitment and still passes");
  const nestedChain = chain([{ key: seller, type: "proposal", body: { text: "deal", items: [{ amount: 9000, currency: "USD" }] } }]);
  const acc: Record<string, unknown> = { text: "ok" };
  expect(/nested field "items"/.test(bindAcceptTerms(nestedChain[0], acc, ROOM) ?? ""), "seventh #4: an accept of a proposal whose price sits in a nested field is refused — it cannot know the whole price");
  const arrCur = chain([{ key: seller, type: "proposal", body: { text: "deal", amount: 0, currency: ["USD"] } }]);
  expect(/malformed currency/.test(bindAcceptTerms(arrCur[0], { text: "ok" }, ROOM) ?? ""), "seventh #5: an accept of a proposal with a non-string currency is refused, not inherited as 'no currency'");

  // #5 one argument reader for both floors: provided-but-wrong-typed is refused, never dropped.
  expect(!readSendFields({ room: "r", type: "proposal", text: "x", amount: "1000" }).ok, "seventh #5: amount \"1000\" is refused (the hosted builder used to drop it and send an unpriced proposal)");
  expect(!readSendFields({ room: "r", text: "x", currency: ["USD"] }).ok && !readSendFields({ room: "r", text: "x", ref: 0 }).ok && !readSendFields({ room: "r", text: "x", expiresHours: "2" }).ok, "seventh #5: wrong-typed currency / ref / expiresHours are refused");
  expect(!readSendFields({ room: "r", text: "x", bogus: 1 }).ok, "seventh #5: an unknown field is refused (the hosted schema said additionalProperties:false and enforced nothing)");
  const rf = readSendFields({ room: "r", type: "proposal", text: "x", amount: 100, currency: "TWD", data: { note: "n" } });
  expect(rf.ok && rf.f.amount === 100 && rf.f.currency === "TWD", "seventh #5: well-typed fields read through");
  if (rf.ok) { const b = buildSendBody("proposal", rf.f); expect(b.amount === 100 && b.currency === "TWD" && b.note === "n" && b.text === "x", "seventh #5: the shared body builder carries amount, currency and data"); }
  const gb = buildSendBody("grant", { text: "g", scope: "read:*", expiresHours: 1 }, 0);
  expect(gb.scope === "read:*" && gb.expires === new Date(3.6e6).toISOString(), "seventh #5: a grant body gets scope + expires from expiresHours");

  // #6 the authority ledger replays by seq, and only the grantor withdraws.
  const exp = new Date(Date.now() + 3.6e6).toISOString();
  const early = chain([
    { key: seller, type: "revoke", body: { ref: 2 } },
    { key: seller, type: "grant", body: { scope: "read:logs", expires: exp } },
  ]);
  expect(liveGrants(early).length === 1, "seventh #6: a revoke that names a LATER seq does not hide the grant that follows it");
  const stranger = chain([
    { key: seller, type: "grant", body: { scope: "read:logs", expires: exp } },
    { key: buyer, type: "revoke", body: { ref: 1 } },
  ]);
  expect(liveGrants(stranger).length === 1, "seventh #6: a peer cannot revoke a grant they did not give");
  const own = chain([
    { key: seller, type: "grant", body: { scope: "read:logs", expires: exp } },
    { key: seller, type: "revoke", body: { ref: 1 } },
  ]);
  expect(liveGrants(own).length === 0, "seventh #6: the grantor's own revoke withdraws it");
  expect(liveGrants([...own].reverse()).length === 0 && liveGrants([...early].reverse()).length === 1, "seventh #6: replay order is by seq, whatever order the messages arrive in");
  expect(liveGrants(chain([{ key: seller, type: "grant", body: { scope: "read:logs", expires: new Date(Date.now() - 1000).toISOString() } }])).length === 0, "seventh #6: an expired grant is not live");

  // #7 a zero grant lifetime means no grant, and the cap is exact (no +0.01h tolerance).
  expect(checkMandate(raw({ may_grant: ["read:*"], max_grant_hours: 0 }), "grant", { scope: "read:logs", expires: new Date(Date.now() + 30_000).toISOString() }) !== null, "seventh #7: max_grant_hours 0 refuses a 30-second grant (the +0.01h tolerance let it through)");
  expect(checkMandate(raw({ may_grant: ["read:*"], max_grant_hours: 1 }), "grant", { scope: "read:logs", expires: new Date(Date.now() + 3.6e6 + 20_000).toISOString() }) !== null, "seventh #7: 1h00m20s exceeds a 1h cap");
  expect(checkMandate(raw({ may_grant: ["read:*"], max_grant_hours: 1 }), "grant", { scope: "read:logs", expires: new Date(Date.now() + 3.6e6 - 20_000).toISOString() }) === null, "seventh #7: 59m40s is within a 1h cap");

  // #9 verifyChain refuses an envelope from another room, however well it chains and signs.
  const foreign = chain([{ key: seller, type: "text", body: { text: "hi" } }]);
  expect(verifyChain(ROOM, foreign).verdict === "CLEAN", "seventh #9: the room's own transcript is CLEAN");
  const u = { v: 1, room: "other-room", from: seller.pub, ts: new Date().toISOString(), type: "text" as const, body: { text: "hi" }, prev: genesis(ROOM) };
  const s: Submitted = sign(u, seller.priv); const cross: Envelope = { ...s, seq: 1, hash: computeHash({ ...s, seq: 1 }) };
  const cv = verifyChain(ROOM, [cross]);
  expect(cv.verdict === "REFUTED" && /room mismatch/.test(cv.errors[0] ?? ""), "seventh #9: a validly signed message of room B chained onto room A's genesis is REFUTED as room A");
}

console.log(`mechanism-test: ${passed} checks passed`);
process.exit(0);
