#!/usr/bin/env node
/**
 * The self-preservation list — raising the brake from AMOUNT to DECISION TYPE.
 *
 * parenting-agent §1 names three missing safeguards; this is the first: a persuaded agent's damage is
 * capped not only by "how much money" but by "what KIND of decision it is allowed to make alone." The
 * adversarial demo (demo:adversarial) showed the amount/scope/currency brake. It also named an honest
 * residual the numeric caps CANNOT touch:
 *   • a trade that is within the cap but simply unwise, and
 *   • a `counter` whose free text paraphrases a secret a LITERAL never_disclose scan misses.
 *
 * The self-preservation list is the structural answer to the CATEGORY problem. The principal writes down
 * the decision TYPES the agent must never do on its own — e.g. never CLOSE a deal, never GRANT authority,
 * and (to catch the paraphrase risk) never send a COUNTER without a human seeing it first. Those types are
 * then HELD: within every number, but not sent until the principal gives a signed go-ahead.
 *
 * The honest boundary stays honest: structure still cannot READ the meaning of the counter's text. What it
 * CAN do is force the principal's eyes onto the decision type before it leaves. That is the half structure
 * owns; advisory review owns the other half. This demo makes both the win and the boundary concrete.
 *
 * Uses the REAL shipped `checkMandate` from dist/protocol — not a reimplementation.
 *
 *   npm run demo:self-preservation      # builds, then runs
 */
import { checkMandate } from "../dist/protocol/index.js";

// Same stroller mandate as the adversarial demo — every numeric bound is generous enough that the messages
// below would ALL pass the caps. What changes here is `require_confirm`: the principal's self-preservation
// list. They are content to let the agent haggle, but no DEAL is closed, no AUTHORITY is handed out, and no
// COUNTER-OFFER leaves, without their own sign-off.
const mandate = {
  never_disclose: ["2400", "reserve"],
  may_grant: ["read:logs/*"],
  max_commit_amount: 5000,
  currency: "TWD",
  max_grant_hours: 24,
  require_confirm: ["accept", "grant", "counter"],
};

const isHold = (v) => typeof v === "string" && v.startsWith("held for principal confirmation");

console.log("Self-preservation list — the brake rises from amount to DECISION TYPE\n");
console.log(`Mandate self-preservation list: ${JSON.stringify(mandate.require_confirm)}`);
console.log("(every message below is WITHIN the numeric caps — the hold is about the kind of decision)\n");

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("  ✗", m); process.exit(1); } pass++; console.log("  ok:", m); };

console.log("1) decisions ON the list are HELD, even fully within the mandate's numbers");
{
  // a) closing a deal the agent was talked into — in-cap, but irreversible: held
  const v = checkMandate(mandate, "accept", { amount: 3000, note: "deal at 3000, let's close" });
  ok(isHold(v), `an in-cap accept (3000 ≤ 5000) is HELD — no deal closes on the agent's own say-so\n         → ${v}`);
}
{
  // b) granting authority within may_grant + within max_grant_hours — still held, because it is authority
  const v = checkMandate(mandate, "grant", { scope: "read:logs/app", expires: new Date(Date.now() + 3.6e6).toISOString() });
  ok(isHold(v), "a grant that satisfies may_grant AND max_grant_hours is still HELD — handing out authority is on the list");
}
{
  // c) THE RESIDUAL, now structurally caught by category: a counter whose text PARAPHRASES the floor.
  // A literal never_disclose scan for "2400" would MISS "twenty-four hundred" (demo:adversarial §3). But
  // `counter` is on the self-preservation list, so this never leaves autonomously — the principal sees the
  // text first. Structure did not READ the meaning; it forced a human onto the category that carries the risk.
  const v = checkMandate(mandate, "counter", { amount: 3000, note: "between us, we can go as low as twenty-four hundred" });
  ok(isHold(v), "a paraphrased-leak counter is HELD by CATEGORY — the semantic residual gets a human checkpoint");
  console.log("     ⚠ Structure still cannot read that 'twenty-four hundred' means the floor. What it did:");
  console.log("       put the whole `counter` category behind the principal's eyes, so the paraphrase cannot");
  console.log("       leave unseen. The list caps the decision type; advisory review judges the meaning.");
}

console.log("\n2) decisions NOT on the list still flow — the agent is not frozen, only bounded");
{
  // A plain factual text is not a commitment type and is not listed: it goes.
  const v = checkMandate(mandate, "text", { note: "the stroller looks in good condition, sending photos" });
  ok(v === null, "a plain `text` (not on the list, not a commitment) passes — the agent still works the conversation");
}
{
  // A proposal (opening ask) is deliberately NOT on this principal's list: they let the agent open, just not close.
  const v = checkMandate(mandate, "proposal", { amount: 2800, note: "opening at 2800" });
  ok(v === null, "an in-cap `proposal` passes — this principal lets the agent OPEN a haggle, only not CLOSE it");
}

console.log("\n3) the hard caps still bite first — 'you cannot' outranks 'go ask'");
{
  // A counter that is BOTH over-cap and on the list reports the cap breach, not the hold: a hard limit is
  // more actionable than a checkpoint. The list adds a floor of caution; it never softens the ceiling.
  const v = checkMandate(mandate, "counter", { amount: 9999, note: "seller wants 9999" });
  ok(typeof v === "string" && v.includes("max_commit_amount"), "an over-cap counter reports the CAP breach first — the hold never softens a hard limit");
}

console.log(`\n${pass} checks passed.`);
console.log("\nWhat this proves (parenting-agent §1, concretely):");
console.log("  • The brake is no longer only 'how much'. The principal names the decision TYPES that are never");
console.log("    theirs to make alone — closing a deal, granting authority, countering with a figure — and those");
console.log("    are HELD for a signed go-ahead, however persuaded the agent is and however in-bounds the numbers.");
console.log("  • This is the structural half of the semantic-disclosure residual: a substring rule cannot read a");
console.log("    paraphrase, but the self-preservation list forces the whole risky CATEGORY behind the principal's");
console.log("    eyes before it leaves. Structure caps the decision type; advisory review judges the meaning.");
console.log("  • It does not freeze the agent: types off the list still flow, so it keeps doing the work — the");
console.log("    list bounds WHAT it may finish alone, not WHETHER it may act.");
process.exit(0);
