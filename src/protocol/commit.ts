// v0.11.1 (third opinion #6): what an `accept` commits to, resolved ONCE and shared by the local client
// (mcp/core.ts) and the hosted surface (relay/mcp-http.ts). Two implementations of "which proposal, what
// amount" is how the hosted path kept the zero-money bypass after the local one had closed it.
import type { Envelope } from "./envelope.js";
import { isEncrypted } from "./e2e.js";
import { nestedField } from "./terms.js";

/** The proposal/counter an accept agrees to: body.ref if given, else the newest one from somebody else. */
export function envelopeBeingAccepted(msgs: Envelope[], mePub: string, ref: unknown): Envelope | undefined {
  return typeof ref === "number" ? msgs.find((m) => m.seq === ref) : [...msgs].reverse().find((m) => m.from !== mePub && (m.type === "proposal" || m.type === "counter"));
}

/** Bind the outgoing accept to the target's terms (sets body.ref, inherits body.amount). Returns the refusal
 *  reason, or null when the body is now the accept of exactly that proposal as it stands. */
export function bindAcceptTerms(target: Envelope | undefined, body: Record<string, unknown>, room: string): string | null {
  if (!target) return `nothing to accept: no proposal or counter from the other side in room ${room} (give ref=<seq> if it is an older one).`;
  if (target.type !== "proposal" && target.type !== "counter") return `#${target.seq} is a ${target.type}, not a proposal or counter — an accept must point at one.`;
  if (isEncrypted(target.body)) return `#${target.seq} is encrypted and this side cannot read its terms — an accept must know what it agrees to.`;
  body.ref = target.seq;
  const tb = (target.body ?? {}) as Record<string, unknown>;
  // v0.11.2 (fourth opinion #1): a proposal whose amount is not a number states terms this side cannot read — refuse,
  // do not accept it "without an amount". Currency is a term too: inherited, and not restated differently.
  if (tb.amount !== undefined && typeof tb.amount !== "number") return `#${target.seq} carries a malformed amount (${JSON.stringify(tb.amount)}) — an accept cannot agree to a figure it cannot read; ask for the proposal again with a numeric amount.`;
  // v0.14.5 (seventh opinion #4/#5): the same rule for the other terms. A currency that is not a string used to be
  // dropped (so an accept inherited none and a TWD mandate never saw the USD), and terms hidden in a nested structure
  // ({items:[{amount}]}) were terms the cap could not read at all. Neither is something this side can agree to.
  if (tb.currency !== undefined && typeof tb.currency !== "string") return `#${target.seq} carries a malformed currency (${JSON.stringify(tb.currency).slice(0, 40)}) — an accept cannot agree to terms it cannot read; ask for the proposal again with a currency code.`;
  const nested = nestedField(tb);
  if (nested) return `#${target.seq} states terms inside a nested field "${nested.slice(0, 40)}" that the mandate cap does not read — an accept must know the whole price it agrees to; ask for the proposal again with a top-level amount and currency.`;
  if (typeof tb.currency === "string") {
    if (typeof body.currency === "string" && body.currency.trim().toUpperCase() !== tb.currency.trim().toUpperCase()) return `this accept says ${body.currency} but #${target.seq} proposes ${tb.currency}; an accept agrees to the proposal as it stands.`;
    body.currency = tb.currency;
  }
  if (typeof tb.amount === "number") {
    if (typeof body.amount === "number" && body.amount !== tb.amount) return `this accept says ${String(body.amount)} but #${target.seq} proposes ${tb.amount}; an accept agrees to the proposal as it stands (send a counter for a different figure).`;
    body.amount = tb.amount;
  }
  return null;
}
