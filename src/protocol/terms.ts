// v0.14.5 (seventh opinion #4/#5): the send arguments and the shape of terms, ONE implementation for both floors.
//
// Two holes with one cause. The hosted send builder copied only a numeric `amount`, so `amount: "1000"` went out as
// an amount-less proposal (the local client refused the same input); and the cap read only the top-level `amount`,
// so a proposal whose price sat in `{items:[{amount: 9000}]}` — spread in through free-form `data` — was a figure
// the mandate never saw, and an accept of it passed a zero cap. The fix is structural, not a smarter parser:
//   · readSendFields: every field is either absent, or of the one type it may have. Provided-but-wrong-typed is
//     REFUSED, never dropped — a silently dropped amount is how an over-cap number becomes an unpriced deal.
//   · checkTermsShape: a proposal / counter / accept carries its terms as top-level scalars, full stop. A nested
//     object or array in such a body is refused by the mandate on both floors, so no structure can state a price
//     the cap does not read; and an accept refuses a target with nested terms (commit.ts) for the same reason.
import type { MsgType } from "./envelope.js";

export interface SendFields {
  text: string; amount?: number; currency?: string; scope?: string; expiresHours?: number; revocable?: boolean;
  ref?: number; url?: string; sha256?: string; name?: string; data?: Record<string, unknown>;
}

/** The keys a send may carry, on either floor. Anything else is refused up front (the hosted surface had
 *  `additionalProperties: false` in its advertised schema but enforced nothing). */
export const SEND_FIELD_KEYS = ["room", "type", "text", "amount", "currency", "scope", "expiresHours", "revocable", "ref", "url", "sha256", "name", "data", "rationale"] as const;

const show = (v: unknown) => { try { return JSON.stringify(v).slice(0, 60); } catch { return String(v).slice(0, 60); } };

export function readSendFields(args: Record<string, unknown>): { ok: true; f: SendFields } | { ok: false; reason: string } {
  const bad = (k: string, want: string) => ({ ok: false as const, reason: `${k} must be ${want}, got ${show(args[k])} — a provided-but-wrong-typed field is refused, not dropped.` });
  for (const k of Object.keys(args)) if (!(SEND_FIELD_KEYS as readonly string[]).includes(k)) return { ok: false, reason: `unknown send field "${k.slice(0, 40)}" — a send carries only ${SEND_FIELD_KEYS.join(", ")}.` };
  if (args.text !== undefined && typeof args.text !== "string") return bad("text", "a string");
  const f: SendFields = { text: typeof args.text === "string" ? args.text : "" };
  if (args.amount !== undefined) { if (typeof args.amount !== "number" || !Number.isFinite(args.amount) || args.amount < 0) return bad("amount", "a finite non-negative number"); f.amount = args.amount; }
  if (args.currency !== undefined) { if (typeof args.currency !== "string" || args.currency.length > 10) return bad("currency", "a short currency code string"); f.currency = args.currency; }
  if (args.scope !== undefined) { if (typeof args.scope !== "string") return bad("scope", "a string"); f.scope = args.scope; }
  if (args.expiresHours !== undefined) { if (typeof args.expiresHours !== "number" || !Number.isFinite(args.expiresHours) || args.expiresHours <= 0) return bad("expiresHours", "a positive number of hours"); f.expiresHours = args.expiresHours; }
  if (args.revocable !== undefined) { if (typeof args.revocable !== "boolean") return bad("revocable", "true or false"); f.revocable = args.revocable; }
  if (args.ref !== undefined) { if (typeof args.ref !== "number" || !Number.isSafeInteger(args.ref) || args.ref < 1) return bad("ref", "a positive whole seq"); f.ref = args.ref; }
  for (const k of ["url", "sha256", "name"] as const) { if (args[k] !== undefined) { if (typeof args[k] !== "string") return bad(k, "a string"); f[k] = args[k] as string; } }
  if (args.data !== undefined) { if (!args.data || typeof args.data !== "object" || Array.isArray(args.data)) return bad("data", "an object of extra fields"); f.data = args.data as Record<string, unknown>; }
  return { ok: true, f };
}

/** The wire body for a send, built the same way on both floors. Explicit fields win over `data`. */
export function buildSendBody(type: MsgType, f: SendFields, now = Date.now()): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(f.data ?? {}), text: f.text };
  if (f.amount !== undefined) body.amount = f.amount;
  if (f.currency !== undefined) body.currency = f.currency;
  if (f.ref !== undefined) body.ref = f.ref;
  if (type === "grant") {
    body.scope = f.scope ?? "";
    body.expires = new Date(now + (f.expiresHours ?? 24) * 3.6e6).toISOString();
    if (f.revocable === false) body.revocable = false;
  }
  // v0.11.0: an escalate states the terms it asks approval for, so the approval can be bound to them (commit gate).
  if (type === "escalate") { if (f.scope) body.scope = f.scope; if (f.expiresHours !== undefined) body.expiresHours = f.expiresHours; if (f.revocable === false) body.revocable = false; }
  if (type === "attachment") { if (f.url) body.url = f.url; if (f.sha256) body.sha256 = f.sha256; if (f.name) body.name = f.name; }
  return body;
}

/** Message types whose body IS a set of terms the cap must be able to read whole. */
export const TERM_TYPES: readonly MsgType[] = ["proposal", "counter", "accept"];

/** The name of the first nested (object / array) field in a body, or null when every value is a scalar. */
export function nestedField(body: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(body)) if (v !== null && typeof v === "object") return k;
  return null;
}

/** Refusal reason when a terms-bearing message hides structure the cap does not read; null when it is flat. */
export function checkTermsShape(type: MsgType, body: Record<string, unknown>): string | null {
  if (!TERM_TYPES.includes(type)) return null;
  const k = nestedField(body);
  return k ? `blocked by mandate: a ${type} carries a nested field "${k.slice(0, 40)}" — terms must be top-level scalars (amount, currency, text) so the cap reads the whole price; a structure like {items:[{amount}]} states a figure the mandate never sees.` : null;
}
