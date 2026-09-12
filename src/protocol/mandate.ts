/**
 * The mandate rule set — ONE implementation for both enforcement points.
 *
 * The same brake guards two floors: the local client checks the principal's
 * full mandate.json before anything is signed on their machine, and the hosted
 * surface (relay/mcp-http.ts) checks the relay-held mandate for agents whose
 * keys never leave the relay. A rule that exists on one floor and not the
 * other is a hole, not a feature — so the rules live here, in protocol/, the
 * layer both the Node client and the Worker may import. What stays with the
 * callers, by design: pause state (different sources) and message framing
 * (the hosted surface appends "NOT SENT." to blocked verdicts).
 */
import { canon } from "./canon.js";
import type { MsgType } from "./envelope.js";
import { checkTermsShape } from "./terms.js";

/** The enforceable subset of a mandate. The local Mandate and the hosted
 *  mandate both satisfy it structurally; extra fields (may_share, brief…) are
 *  advisory and never enforced here. */
export interface MandateRules {
  never_disclose: string[];
  may_grant: string[];
  max_commit_amount: number | null;
  currency?: string;
  max_grant_hours: number;
  /** Self-preservation list (parenting-agent §1): message TYPES the agent must never send on its own,
   *  even fully within every numeric bound above — each is HELD for the principal's own go-ahead. This
   *  raises the brake from "how much" to "what KIND of decision". Values are MsgType strings; an unknown
   *  string simply never matches (a typo is a safe no-op). Optional; absent/[] = only the caps bite. */
  require_confirm?: string[];
}

/** Coerce a raw, possibly-malformed mandate object into safe enforceable rules — FAIL-CLOSED (sixth opinion
 *  #1/#7). A cap that is not a finite number >= 0 (a typo like "500", NaN, undefined) must NOT read as "no
 *  limit": it collapses to the most restrictive value, never a silent pass. Only an explicit `null` means
 *  "no amount cap". `require_confirm` entries are trimmed + lower-cased so a case/space typo cannot silently
 *  disable the hold. Used at BOTH floors (checkMandate here, and the hosted widened check) so a bad config
 *  cannot open a hole on either. */
export function normalizeMandateRules(raw: Record<string, unknown> | null | undefined): MandateRules {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    never_disclose: strArr(r.never_disclose),
    may_grant: strArr(r.may_grant),
    // explicit null = no cap; a finite non-negative number = that cap; ANYTHING else = 0 (block all commits).
    max_commit_amount: r.max_commit_amount === null ? null : (nonNeg(r.max_commit_amount) ? r.max_commit_amount : 0),
    currency: typeof r.currency === "string" ? r.currency : undefined,
    // a malformed max_grant_hours becomes 0 (no grant lifetime allowed), never a widened window.
    max_grant_hours: nonNeg(r.max_grant_hours) ? r.max_grant_hours : 0,
    require_confirm: strArr(r.require_confirm).map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

/** A strict ISO-8601 instant WITH a timezone — what `new Date().toISOString()` produces. Date.parse alone
 *  accepts `"01/02/2000"` and other locale formats (sixth opinion #10), so a grant expiry is matched here first. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Glob-ish scope match: `*` matches any run of characters. Case-insensitive. */
export function scopeAllowed(scope: string, patterns: string[]): boolean {
  const s = scope.trim().toLowerCase();
  return patterns.some((p) => {
    const re = new RegExp("^" + p.trim().toLowerCase().split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(s);
  });
}

/** Returns the reason a send must be blocked, or null when the mandate allows it.
 *  Checks the OUTBOUND body — for E2E rooms this must run on the plaintext,
 *  before encryption. */
export function checkMandate(rawM: MandateRules, type: MsgType, body: Record<string, unknown>): string | null {
  // Normalise first (sixth opinion #1): a malformed cap must fail closed, not silently pass. Runs on both
  // floors because this is the one place both call.
  const m = normalizeMandateRules(rawM as unknown as Record<string, unknown>);
  // The brokerage layer (mechanism.ts): a `reveal` opens a sealed bid the principal already authorised
  // (the commit that bound it went through the commit gate, bound to an approved escalate that named the
  // figure). So the bid is authorised disclosure — never_disclose is scanned over the rest of the body,
  // never over the bid itself — while the cap still applies: you cannot reveal a bid above max_commit_amount.
  const isReveal = type === "mechanism" && (body as { phase?: unknown }).phase === "reveal";
  const flat = canon(isReveal ? { ...body, bid: undefined } : body).toLowerCase();
  for (const s of m.never_disclose) {
    if (s && flat.includes(s.toLowerCase())) return `blocked by mandate: outbound body contains a never_disclose string.`;
  }
  if (isReveal) {
    const bid = body.bid;
    // Number.isSafeInteger (sixth opinion #9): a value past 2^53 is not a trustworthy integer for a cap compare.
    if (typeof bid !== "number" || !Number.isSafeInteger(bid) || bid < 0) return `blocked by mandate: a sealed bid must be a non-negative whole number within the safe-integer range, got ${JSON.stringify(bid)}.`;
    if (m.max_commit_amount != null && bid > m.max_commit_amount) return `blocked by mandate: sealed bid ${bid} exceeds max_commit_amount ${m.max_commit_amount}${m.currency ? " " + m.currency : ""}.`;
  }
  // v0.11.2 (fourth opinion #1): an amount is a finite non-negative number or absent — a string "1000" smuggled in
  // through free-form data used to pass every cap unread. A currency, when the mandate names one, must be that one.
  if (body.amount !== undefined && (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount < 0)) return `blocked by mandate: amount must be a non-negative number, got ${JSON.stringify(body.amount)}.`;
  if (body.currency !== undefined && typeof body.currency !== "string") return `blocked by mandate: currency must be a string, got ${JSON.stringify(body.currency)}.`;
  if (typeof body.currency === "string" && m.currency && body.currency.trim().toUpperCase() !== m.currency.trim().toUpperCase()) return `blocked by mandate: currency ${body.currency} is not the mandate's ${m.currency}.`;
  // v0.14.5 (seventh opinion #4): terms are flat. A nested structure in a proposal/counter/accept can carry a price
  // this cap never reads ({items:[{amount: 9000}]} under a 0 cap) — refused on both floors, whatever it contains.
  const shape = checkTermsShape(type, body);
  if (shape) return shape;
  if (["proposal", "counter", "accept"].includes(type) && m.max_commit_amount != null && typeof body.amount === "number") {
    if (body.amount > m.max_commit_amount) return `blocked by mandate: amount ${body.amount} exceeds max_commit_amount ${m.max_commit_amount}${m.currency ? " " + m.currency : ""}.`;
  }
  if (type === "grant") {
    const scope = typeof body.scope === "string" ? body.scope.trim() : "";
    if (!scope) return `grant needs a scope (e.g. "read:logs/*", "deploy:staging").`;
    if (!scopeAllowed(scope, m.may_grant)) return `blocked by mandate: scope "${scope}" is not in may_grant ${JSON.stringify(m.may_grant)} — escalate to your principal instead.`;
    // sixth opinion #10: require a real ISO instant with a timezone (Date.parse alone takes "01/02/2000",
    // arrays via String(), and expired dates), and the expiry must be in the future.
    if (typeof body.expires !== "string" || !ISO_INSTANT_RE.test(body.expires)) return `grant needs an ISO-8601 expiry with a timezone (use expiresHours).`;
    const exp = Date.parse(body.expires);
    if (!Number.isFinite(exp)) return `grant expiry is not a valid date.`;
    // v0.14.5 (seventh opinion #7): a zero lifetime means NO grant at all (that is also what a malformed cap
    // normalises to), and the cap is compared exactly — the old "+0.01h" tolerance let a 36-second grant through
    // a mandate that allowed none.
    if (m.max_grant_hours <= 0) return `blocked by mandate: max_grant_hours is 0 — this mandate allows no grant lifetime at all.`;
    const hours = (exp - Date.now()) / 3.6e6;
    if (hours <= 0) return `blocked by mandate: grant expiry ${body.expires} is in the past.`;
    if (hours > m.max_grant_hours) return `blocked by mandate: grant expiry ${hours.toFixed(2)}h exceeds max_grant_hours ${m.max_grant_hours}.`;
  }
  if (type === "revoke" && !(typeof body.ref === "number" && Number.isSafeInteger(body.ref) && body.ref >= 1)) return `revoke needs ref = a positive seq of the grant being revoked.`;
  if (type === "attachment") {
    // sixth opinion #11: https only, and a real host — "https://" and http URLs used to pass.
    const url = typeof body.url === "string" ? body.url : "";
    let ok = /^https:\/\//i.test(url);
    if (ok) { try { const u = new URL(url); ok = u.protocol === "https:" && u.hostname.length > 0; } catch { ok = false; } }
    if (!ok) return `attachment needs a valid https URL with a host (the relay never stores bytes).`;
  }
  // Self-preservation list (parenting-agent §1): the brake raised from AMOUNT to DECISION TYPE. Reached
  // last, so a hard breach above (over-cap, out-of-scope, literal disclosure) reports first — "you cannot",
  // before "go ask". Everything that survives here is within the mandate's numbers; the hold exists for what
  // a numeric cap cannot see: an in-bounds-but-unwise trade, and a category (e.g. every `counter`) whose text
  // could paraphrase a secret a literal never_disclose scan would miss. Structure cannot read meaning — but it
  // can force the principal's eyes onto the decision type before it leaves. That is the honest half it CAN do.
  if ((m.require_confirm ?? []).includes(type)) {
    return `held for principal confirmation: "${type}" is on your self-preservation list — the numbers are within your mandate, but this decision type is never sent on your own. Escalate to your principal for a signed go-ahead.`;
  }
  return null;
}
