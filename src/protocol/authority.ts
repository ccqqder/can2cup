// v0.14.5 (seventh opinion #6): the authority ledger, ONE implementation.
//
// "What does the counterparty hold from me right now" = grants − revokes − expired, replayed IN SEQ ORDER over a
// verified transcript. The local `history` used to compute it as "the set of every revoke's ref, then filter
// grants" — no order, no author: a revoke at seq 1 naming a grant that only appears at seq 2 hid that grant, and
// any participant could "revoke" another participant's grant. The demo (demo/revoke-and-audit.mjs) replayed a
// Map in order and got a different answer from the client. Both now call this.
//
// Rules, each a structural fact the signed chain proves:
//   · a grant is live from its seq until it expires or is revoked
//   · a revoke withdraws a grant only if it names an EARLIER seq (ref < its own seq) that IS a live grant
//   · only the grant's author may withdraw it — a peer cannot revoke what they did not give
// Anything else (a ref to a non-grant, a forward ref, a stranger's revoke) is a no-op, never an error: the
// chain verified it, it just does not change who holds what.
import type { Envelope } from "./envelope.js";

export interface LiveGrant { seq: number; from: string; scope: string; expires: string }

/** Live grants at `now`, from a transcript in the decrypted view (bodies readable). Order-independent input:
 *  messages are replayed by seq whatever order they arrive in. */
export function liveGrants(msgs: Envelope[], now = Date.now()): LiveGrant[] {
  const live = new Map<number, LiveGrant>();
  for (const m of [...msgs].sort((a, b) => a.seq - b.seq)) {
    const b = (m.body ?? {}) as Record<string, unknown>;
    if (m.type === "grant") {
      live.set(m.seq, { seq: m.seq, from: m.from, scope: typeof b.scope === "string" ? b.scope : "", expires: typeof b.expires === "string" ? b.expires : "" });
    } else if (m.type === "revoke") {
      const ref = b.ref;
      if (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref >= m.seq) continue;
      const g = live.get(ref);
      if (!g || g.from !== m.from) continue;
      live.delete(ref);
    }
  }
  return [...live.values()].filter((g) => { const t = Date.parse(g.expires); return Number.isFinite(t) && t > now; });
}
