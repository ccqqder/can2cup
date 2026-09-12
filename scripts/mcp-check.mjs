// End-to-end for the remote MCP connector: LINE binding -> OAuth (DCR + PKCE) -> MCP tools.
// Usage: RELAY=http://127.0.0.1:8788 RELAY_KEY=... BRIDGE_KEY=... node scripts/mcp-check.mjs
import { pubFromPriv, randomHex, signRequestHeaders } from "../dist/protocol/index.js";
import { createHash, randomBytes } from "node:crypto";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8788";
const BRIDGE_KEY = process.env.BRIDGE_KEY ?? "devbridge";
const USER = "Umcpprobe" + randomHex(3);
const REDIRECT = "http://localhost:9999/cb";

let failed = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- 1. an agent exists and its principal is linked on LINE -------------------
const priv = randomHex(32), pub = pubFromPriv(priv);
const linkBody = JSON.stringify({ name: "mcp probe" });
const linkRes = await j(await fetch(`${RELAY}/p/link`, {
  method: "POST",
  headers: { "content-type": "application/json", ...signRequestHeaders("POST", "/p/link", linkBody, { pub, priv }) },
  body: linkBody,
}));
ok(!!linkRes.code, "agent got a link code", linkRes.code ?? JSON.stringify(linkRes));

const bound = await j(await fetch(`${RELAY}/bridge/link`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY },
  body: JSON.stringify({ code: linkRes.code, userId: USER }),
}));
ok(bound.ok === true && bound.pub === pub, "principal bound to the agent pubkey");

const pcode = await j(await fetch(`${RELAY}/bridge/link-code`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY },
  body: JSON.stringify({ userId: USER }),
}));
ok(!!pcode.code, "principal has a /link code to paste", pcode.code);

// --- 2. discovery -------------------------------------------------------------
// The relay derives every public URL from the request origin, and under `wrangler dev`
// with a route configured that origin is the custom domain, not the local address.
// Ask the relay what it thinks it is rather than assuming.
const health = await j(await fetch(`${RELAY}/`));
const ORIGIN = new URL(health.a2a).origin;
const prm = await j(await fetch(`${RELAY}/.well-known/oauth-protected-resource`));
ok(prm.resource === `${ORIGIN}/mcp` && Array.isArray(prm.authorization_servers), "protected-resource metadata", ORIGIN);
const asm = await j(await fetch(`${RELAY}/.well-known/oauth-authorization-server`));
ok(asm.code_challenge_methods_supported?.[0] === "S256", "auth-server metadata requires PKCE S256");

const un = await fetch(`${RELAY}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok(un.status === 401 && (un.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
  "unauthenticated /mcp answers 401 + WWW-Authenticate");

// --- 3. OAuth: dynamic registration, consent, PKCE token ----------------------
const reg = await j(await fetch(`${RELAY}/oauth/register`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Probe Connector", redirect_uris: [REDIRECT] }),
}));
ok(!!reg.client_id, "dynamic client registration");

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const q = new URLSearchParams({
  client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code",
  code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
});

const consent = await fetch(`${RELAY}/oauth/authorize?${q}`);
const html = await consent.text();
ok(consent.status === 200 && html.includes("QQder"), "consent page renders and asks for the LINE code");

const badPkce = await fetch(`${RELAY}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`);
ok(badPkce.status === 400, "authorize without PKCE is refused");

const wrongCode = await fetch(`${RELAY}/oauth/authorize?${q}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code: "ZZZZ-ZZZZ" }),
});
ok(wrongCode.status === 400, "a bogus LINE code is refused");

const granted = await fetch(`${RELAY}/oauth/authorize?${q}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code: pcode.code }), redirect: "manual",
});
const loc = new URL(granted.headers.get("location") ?? "http://x/");
const authCode = loc.searchParams.get("code");
ok(granted.status === 302 && !!authCode && loc.searchParams.get("state") === "xyz",
  "consent redirects back with an authorization code + state");

const replay = await fetch(`${RELAY}/oauth/authorize?${q}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code: pcode.code }),
});
ok(replay.status === 400, "the LINE code cannot be replayed");

const wrongVerifier = await j(await fetch(`${RELAY}/oauth/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: "wrong" }),
}));
ok(wrongVerifier.error === "invalid_grant", "PKCE mismatch is rejected");

// that attempt consumed the code, so run the real exchange on a fresh one
const g2 = await fetch(`${RELAY}/oauth/authorize?${q}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code: (await j(await fetch(`${RELAY}/bridge/link-code`, { method: "POST", headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY }, body: JSON.stringify({ userId: USER }) }))).code }),
  redirect: "manual",
});
const code2 = new URL(g2.headers.get("location")).searchParams.get("code");
const tok = await j(await fetch(`${RELAY}/oauth/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier }),
}));
ok(tok.token_type === "Bearer" && !!tok.access_token, "PKCE exchange returns an access token");

// --- 4. MCP ------------------------------------------------------------------
const rpc = async (method, params, id = 1) => j(await fetch(`${RELAY}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
}));

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
ok(init.result?.serverInfo?.name === "can2cup" && init.result?.protocolVersion === "2025-06-18",
  "initialize", `protocol=${init.result?.protocolVersion}`);

const list = await rpc("tools/list", undefined, 2);
const names = (list.result?.tools ?? []).map((t) => t.name);
ok(names.length === 7 && ["can2cup_whoami","can2cup_rooms","can2cup_join","can2cup_send","can2cup_history","can2cup_create_room","can2cup_invite"].every((n) => names.includes(n)),
  "tools/list", names.join(", "));

const who = await rpc("tools/call", { name: "can2cup_whoami", arguments: {} }, 3);
const whoText = who.result?.content?.[0]?.text ?? "";
ok(whoText.includes(pub) && whoText.includes('"keyCustody": "local'), "tools/call can2cup_whoami reports local custody");

const rooms = await rpc("tools/call", { name: "can2cup_rooms", arguments: {} }, 4);
ok((rooms.result?.content?.[0]?.text ?? "").includes("not in any can2cup room"), "tools/call can2cup_rooms (none yet)");

const nope = await rpc("tools/call", { name: "can2cup_nonesuch", arguments: {} }, 5);
ok(nope.error?.code === -32602, "an unknown tool is rejected");

const notif = await fetch(`${RELAY}/mcp`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
ok(notif.status === 202, "a notification gets 202 with no body");

const badTok = await fetch(`${RELAY}/mcp`, {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
});
ok(badTok.status === 401, "a bogus access token is refused");


// --- 5. the local-key tier may not write through this surface ----------------
const refusedJoin = await rpc("tools/call", { name: "can2cup_join", arguments: { invite: "x" } }, 10);
ok((refusedJoin.result?.content?.[0]?.text ?? "").includes("owner's machine"),
  "a local-key agent is refused write tools with the reason");

// --- 6. a person with NOTHING installed can finish the flow ------------------
const NEWUSER = "Ufresh" + randomHex(3);
const freshCode = await j(await fetch(`${RELAY}/bridge/link-code`, {
  method: "POST", headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY },
  body: JSON.stringify({ userId: NEWUSER }),
}));
const reg2 = await j(await fetch(`${RELAY}/oauth/register`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Fresh", redirect_uris: [REDIRECT] }),
}));
const v2 = b64url(randomBytes(32));
const q2 = new URLSearchParams({
  client_id: reg2.client_id, redirect_uri: REDIRECT, response_type: "code",
  code_challenge: b64url(createHash("sha256").update(v2).digest()), code_challenge_method: "S256",
});
const grant2 = await fetch(`${RELAY}/oauth/authorize?${q2}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code: freshCode.code }), redirect: "manual",
});
ok(grant2.status === 302, "a LINE user with no agent still gets through consent");
const tok2 = await j(await fetch(`${RELAY}/oauth/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code", code: new URL(grant2.headers.get("location")).searchParams.get("code"),
    client_id: reg2.client_id, redirect_uri: REDIRECT, code_verifier: v2,
  }),
}));
const rpc2 = async (method, params, id = 1) => j(await fetch(`${RELAY}/mcp`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok2.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
}));

const who2 = JSON.parse((await rpc2("tools/call", { name: "can2cup_whoami", arguments: {} }, 20)).result.content[0].text);
ok(who2.keyCustody.startsWith("hosted") && String(who2.canCommit).includes("mandate"),
  "an agent was created for them, custody disclosed as hosted");
const disclosure = await j(await fetch(`${RELAY}/hosted/${who2.pubkey}`));
ok(disclosure.hosted === true && !!disclosure.since, "custody is publicly checkable at /hosted/:pub");
const localDisclosure = await j(await fetch(`${RELAY}/hosted/${pub}`));
ok(localDisclosure.hosted === false, "a local-key agent reports hosted:false");

// --- 7. the hosted agent can actually be used --------------------------------
const room = await j(await fetch(`${RELAY}/rooms`, {
  method: "POST", headers: { "content-type": "application/json", "x-parley-key": process.env.RELAY_KEY },
  body: JSON.stringify({ name: "hosted probe", creator: { pubkey: pub, name: "local side" } }),
}));
const joined = await rpc2("tools/call", { name: "can2cup_join", arguments: { invite: `${RELAY}/j/${room.id}#${room.secret}` } }, 21);
ok((joined.result?.content?.[0]?.text ?? "").includes(`Joined room ${room.id}`), "hosted agent joins from an invite link");

const said = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: room.id, type: "text", text: "hello from a hosted agent" } }, 22);
ok((said.result?.content?.[0]?.text ?? "").includes("Sent as text"), "hosted agent sends a signed message");

const committed = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: room.id, type: "accept", text: "we agree" } }, 23);
ok((committed.result?.content?.[0]?.text ?? "").includes("Sent as accept"), "hosted agent may accept when the mandate allows it");

const badGrant = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: room.id, type: "grant", text: "you may deploy", scope: "deploy:prod", expiresHours: 1 } }, 231);
ok((badGrant.result?.content?.[0]?.text ?? "").includes("may_grant"), "mandate blocks a grant outside may_grant");

const longGrant = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: room.id, type: "grant", text: "x", scope: "read:logs/*" } }, 232);
ok((longGrant.result?.content?.[0]?.text ?? "").includes("may_grant"), "an empty may_grant blocks every scope");

const leaked = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: room.id, type: "text", text: "the key is sk-live-abc123" } }, 24);
ok((leaked.result?.content?.[0]?.text ?? "").includes("NOT SENT"), "mandate blocks a never_disclose string");

const overCommit = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: room.id, type: "proposal", text: "how about this", amount: 5000 } }, 25);
ok((overCommit.result?.content?.[0]?.text ?? "").includes("max_commit_amount"), "mandate blocks an amount over the ceiling");

const hist = await rpc2("tools/call", { name: "can2cup_history", arguments: { room: room.id } }, 26);
const histText = hist.result?.content?.[0]?.text ?? "";
ok(histText.includes("hello from a hosted agent") && !histText.includes("sk-live-"),
  "history shows what was sent and nothing that was blocked");


// --- 8. a hosted agent can start a conversation, not only join one ------------
const opened = await rpc2("tools/call", { name: "can2cup_create_room", arguments: { name: "opened by a hosted agent" } }, 30);
const openedText = opened.result?.content?.[0]?.text ?? "";
const newRoom = (/Room ([0-9a-f]{12}) is open/.exec(openedText) ?? [])[1];
ok(!!newRoom && openedText.includes("#"), "hosted agent opens a room and gets an invite link", newRoom ?? openedText.slice(0, 80));

const inv = await rpc2("tools/call", { name: "can2cup_invite", arguments: { room: newRoom } }, 31);
ok((inv.result?.content?.[0]?.text ?? "").includes(`/j/${newRoom}#`), "can2cup_invite returns the link for a room it is in");

const saidThere = await rpc2("tools/call", { name: "can2cup_send", arguments: { room: newRoom, text: "first words in my own room" } }, 32);
ok((saidThere.result?.content?.[0]?.text ?? "").includes("Sent as text"), "hosted agent can speak in the room it opened");

// v0.5.0: an E2E invite (#secret.key) must be refused — joining would hand this relay the room key.
const e2eJoin = await rpc2("tools/call", { name: "can2cup_join", arguments: { invite: `${RELAY}/j/aaaaaaaaaaaa#${"ab".repeat(12)}.${"cd".repeat(32)}` } }, 33);
ok((e2eJoin.result?.content?.[0]?.text ?? "").includes("END-TO-END"), "hosted agent refuses to join an E2E room (custody honesty)");


// --- 9. operator ban switch ---------------------------------------------------
const banNoKey = await fetch(`${RELAY}/admin/ban`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pub: who2.pubkey }) });
ok(banNoKey.status === 401, "admin/ban without the relay key is refused");

const ban = await j(await fetch(`${RELAY}/admin/ban`, { method: "POST", headers: { "content-type": "application/json", "x-parley-key": process.env.RELAY_KEY }, body: JSON.stringify({ pub: who2.pubkey, reason: "probe" }) }));
ok(ban.ok === true, "operator bans the hosted identity");

const bannedCall = await rpc2("tools/call", { name: "can2cup_whoami", arguments: {} }, 40);
ok((bannedCall.error?.message ?? "").includes("banned"), "a banned identity is refused at the connector");

const bans = await j(await fetch(`${RELAY}/admin/bans`, { headers: { "x-parley-key": process.env.RELAY_KEY } }));
ok(Object.keys(bans.bans ?? {}).some((k) => k.includes(who2.pubkey)), "the ban shows in the operator list");

const unban = await j(await fetch(`${RELAY}/admin/unban`, { method: "POST", headers: { "content-type": "application/json", "x-parley-key": process.env.RELAY_KEY }, body: JSON.stringify({ pub: who2.pubkey }) }));
ok(unban.ok === true, "unban");
const restored = await rpc2("tools/call", { name: "can2cup_whoami", arguments: {} }, 41);
ok(!!restored.result, "after unban the identity works again");

// --- 10. per-identity daily room quota (dev relay sets ROOMS_PER_DAY=3) --------
let createdMore = 0, refusal = "";
for (let i = 0; i < 6; i++) {
  const r = await rpc2("tools/call", { name: "can2cup_create_room", arguments: { name: "quota probe " + i } }, 50 + i);
  const t = r.result?.content?.[0]?.text ?? "";
  if (/Room [0-9a-f]{12} is open/.test(t)) createdMore++;
  else { refusal = t; break; }
}
ok(refusal.includes("quota") && createdMore >= 1, `daily room quota bites after ${createdMore} more rooms`, refusal.slice(0, 70));

// --- 11. terms are published ---------------------------------------------------
const tos = await fetch(`${RELAY}/terms`);
const tosHtml = await tos.text();
ok(tos.status === 200 && tosHtml.includes("服務條款") && tosHtml.includes("每分鐘"), "GET /terms serves the policy with live quota numbers");

console.log("");
console.log(failed ? failed + " FAILED" : "all checks passed");
process.exit(failed ? 1 : 0);
