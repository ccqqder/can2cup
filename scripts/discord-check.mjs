// v0.12.1 — the Discord interactions endpoint, end to end, without Discord: forged interactions signed with a
// throwaway dev key (its public half is DISCORD_PUBLIC_KEY in .dev.vars) are posted to /discord/interactions. With
// no DISCORD_BOT_TOKEN the relay cannot fill the deferred reply in, so every answer falls back to the push queue and
// is read back from /bridge/debug/pushes (kind "reply"). Needs a local relay with DEBUG_ROUTES=1 and the dev key:
//   RELAY=http://127.0.0.1:8787 BRIDGE_KEY=devbridge node scripts/discord-check.mjs
// The dev private key below is NOT a secret worth anything: it verifies nothing but a local wrangler dev.
import { createPrivateKey, randomBytes, sign } from "node:crypto";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const BRIDGE_KEY = process.env.BRIDGE_KEY ?? "devbridge";
const DEV_SEED = process.env.DISCORD_DEV_SEED ?? "a9d408978d850b8e4214c5eeb2aaef9a2870c311045322de55f272d6796f7cf3"; // pub ce53d70c…40cb8
const KEY = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(DEV_SEED, "hex")]), format: "der", type: "pkcs8" });
const VERBOSE = !!process.env.VERBOSE;
const snow = () => String(1_500_000_000_000_000_000n + BigInt("0x" + randomBytes(6).toString("hex")));
const UID = process.env.USER_ID ?? snow();
const CID = process.env.CHANNEL_ID ?? snow();
const GID = process.env.GUILD_ID ?? snow();
const U = `discord:u:${UID}`, C = `discord:c:${CID}`;
let fails = 0;
const expect = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, { signIt = true, badSig = false } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = badSig ? randomBytes(64).toString("hex") : sign(null, Buffer.from(ts + raw), KEY).toString("hex");
  const r = await fetch(`${RELAY}/discord/interactions`, { method: "POST", headers: { "content-type": "application/json", ...(signIt ? { "x-signature-ed25519": sig, "x-signature-timestamp": ts } : {}) }, body: raw });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const user = { id: UID, username: "tester", global_name: "測試員" };
/** A forged interaction. `where`: "dm" | "guild" (bot installed) | "guild-user" (user install only) */
function inter(type, data, where = "dm", id = snow()) {
  const base = { id, application_id: "devapp", type, token: "tok" + randomBytes(8).toString("hex"), version: 1, locale: "zh-TW", data };
  if (where === "dm") return { ...base, user, channel_id: snow(), channel: { id: CID, type: 1 }, context: 1, authorizing_integration_owners: { 1: UID } };
  const owners = where === "guild" ? { 0: GID } : { 1: UID };
  return { ...base, guild_id: GID, channel_id: CID, channel: { id: CID, type: 0, name: "general" }, member: { user, nick: "小測" }, context: 0, authorizing_integration_owners: owners };
}
const cmd = (name, text, where, id) => inter(2, { id: snow(), name, type: 1, ...(text != null ? { options: [{ name: "text", type: 3, value: text }] } : {}) }, where, id);
const button = (custom_id, where) => inter(3, { custom_id, component_type: 2 }, where);
const modal = (custom_id, value, where) => inter(5, { custom_id, components: [{ type: 1, components: [{ type: 4, custom_id: "text", value }] }] }, where);
const bridge = async (path, body, method = body ? "POST" : "GET") => (await fetch(`${RELAY}${path}`, { method, headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const seen = new Map();
async function replies(to) {
  const { pushes } = await bridge("/bridge/debug/pushes");
  const mine = pushes.filter((p) => p.kind === "reply" && p.to === to);
  const fresh = mine.slice(seen.get(to) ?? 0); seen.set(to, mine.length);
  if (VERBOSE) for (const p of fresh) console.log("   ↳", JSON.stringify(p.text).slice(0, 200));
  return fresh.map((p) => p.text);
}
/** Post, expect the deferred ack, then wait for the DO (it runs after the Worker answered) to record the reply. */
async function send(body, to = U, { expectAck = 5 } = {}) {
  const r = await post(body);
  if (expectAck != null) expect(r.status === 200 && r.json.type === expectAck, `ack type ${expectAck} for ${body.data?.name ?? body.data?.custom_id ?? body.type}`);
  let out = [];
  for (let i = 0; i < 12 && !out.length; i++) { await sleep(250); out = await replies(to); }
  return { r, out };
}

// 0. the endpoint itself
let r = await post({ type: 1 });
expect(r.status === 200 && r.json.type === 1, "PING answers PONG");
r = await post({ type: 1 }, { signIt: false });
expect(r.status === 401, "unsigned interaction is refused (401)");
r = await post({ type: 1 }, { badSig: true });
expect(r.status === 401, "wrong signature is refused (401)");
r = await post({ type: 99 });
expect(r.status === 400, "unknown interaction type → 400");
r = await post(inter(4, { name: "a", options: [] }));
expect(r.status === 200 && r.json.type === 8, "autocomplete → empty choices");

// 1. unbound person, in DMs
let { out } = await send(cmd("help"));
expect(out.some((t) => t.includes("傳聲罐罐") && t.includes("/advance")), "/help answers the help text");
expect(out.some((t) => t.includes("用 Discord 遙控") && !t.includes("LINE")), "…worded for Discord, not LINE");
({ out } = await send(cmd("status")));
expect(out.some((t) => t.includes("還沒接上 agent")), "/status while unbound says 先接上");
({ out } = await send(cmd("setup")));
expect(out.length === 2 && /can2cup setup --relay \S+ --name "[^"]*" --link [A-Z0-9]{4}-[A-Z0-9]{4}/.test(out[1]), "/setup returns two messages, the second with a 30-min --link code");
({ out } = await send(cmd("link", "ZZZZ-ZZZZ")));
expect(out.some((t) => t.includes("不存在或過期")), "/link with a wrong code says so");
({ out } = await send(cmd("setup", null, "guild"), C));
expect(out.some((t) => t.includes("1 對 1")), "/setup in a server channel is refused (the code would be visible)");
const dupId = snow();
await post(cmd("help", null, "dm", dupId)); await post(cmd("help", null, "dm", dupId)); await sleep(900);
out = await replies(U);
expect(out.length === 1, `the same interaction id twice is handled once (${out.length} replies)`);

// 2. the "type here" button → a modal, answered by the Worker on the spot; the modal's text → /a
r = await post(button("fl:/a "));
expect(r.status === 200 && r.json.type === 9 && r.json.data?.custom_id === "modal:/a", "fl: button opens a modal (type 9) carrying its prefix");
({ out } = await send(modal("modal:/a", "測試句")));
expect(out.some((t) => t.includes("還沒接上 agent")), "modal text while unbound → /a → 先接上");

// 3. bind a (hosted) agent to this Discord user via the debug route, then the bound commands
const h = await bridge("/bridge/debug/hosted", { userId: U });
expect(!!h.pub, "debug: hosted agent bound to the Discord user");
({ out } = await send(cmd("status")));
expect(out.some((t) => t.includes("還沒接上任何群") && t.includes("裝進一個伺服器")), "/status bound, no groups → hint worded for servers");
({ out } = await send(cmd("a", "今天進度如何")));
expect(out.some((t) => /已交給你的 agent|已排隊/.test(t)), "/a lands in the inbox and answers with a receipt");
const inbox = await bridge(`/bridge/debug/inbox/${U}`);
expect(inbox.items.some((i) => i.text.startsWith("今天進度如何") && i.via === "discord"), "…the inbox holds it, via discord");
({ out } = await send(button("tx:/status")));
expect(out.some((t) => t.includes("還沒接上任何群")), "tx: button runs the command it carries");
({ out } = await send(modal("modal:/a", "從對話框來的")));
expect(out.some((t) => /已交給你的 agent|已排隊/.test(t)), "modal text while bound → inbox");
({ out } = await send(cmd("agent", "on")));
expect(out.some((t) => t.includes("agent 模式")), "/agent on");
({ out } = await send(cmd("pause")));
expect(out.some((t) => t.includes("已暫停")), "/pause");
expect((await bridge(`/bridge/user/${U}`)).paused === true, "…and the bridge says paused");
({ out } = await send(cmd("resume")));
expect(out.some((t) => t.includes("已恢復")), "/resume");
({ out } = await send(cmd("keep", "永久")));
expect(out.some((t) => t.includes("不會自動解除")), "/keep 永久");
({ out } = await send(cmd("quota")));
expect(out.some((t) => /本月 push:\d+/.test(t) && t.includes("沒有月上限")), "/quota shows this channel's own count and says it has no monthly allowance (that is LINE's)");
({ out } = await send(cmd("show")));
expect(out.some((t) => t.includes("沒有進行中的對話")), "/show with no open room");

// 4. a server that has the app as a user install only: the bot could not post there later
({ out } = await send(cmd("status", null, "guild-user"), C));
expect(out.some((t) => t.includes("還沒把 can2cup 裝進來") && t.includes("discord.com/oauth2/authorize")), "/status in a user-install-only server → install hint");
({ out } = await send(cmd("help", null, "guild-user"), C));
expect(out.some((t) => t.includes("傳聲罐罐")), "/help still answers there");

// 5. a server with the bot installed: the unwired card, the wire button, /a, quiet, ask
({ out } = await send(cmd("status", null, "guild"), C));
expect(out.some((t) => t.includes("還沒接上 agent")), "channel /status → unwired card (alt text recorded)");
({ out } = await send(button("pb:parley:wire", "guild"), C));
expect(out.some((t) => t.includes("正在接上") || t.includes("已排隊")), "接上這個群 button → room request queued");
const inbox2 = await bridge(`/bridge/debug/inbox/${U}`);
expect(inbox2.items.some((i) => /OPEN A CAN2CUP ROOM .*Discord channel/.test(i.text)), "…the agent's inbox names a Discord channel");
({ out } = await send(cmd("a", "頻道裡的一句", "guild"), C));
expect(out.some((t) => /已交給你的 agent|已排隊/.test(t)), "/a from the channel is received");
({ out } = await send(cmd("quiet", null, "guild"), C));
expect(out.some((t) => t.includes("安靜")), "/quiet in the channel");
({ out } = await send(cmd("ask", "週末有空嗎", "guild"), C));
expect(out.some((t) => t.includes("還沒接上任何 agent")), "/ask in an unwired channel says so");

// 6. decision buttons
({ out } = await send(button("pb:parley:ok:000000000000:3")));
expect(out.some((t) => t.includes("已同意")), "同意 button → APPROVE written to the inbox");
({ out } = await send(button("pb:parley:no:000000000000:4")));
expect(out.some((t) => t.includes("已拒絕")), "拒絕 button → REJECT");

// 7. the way out
({ out } = await send(cmd("unbind")));
expect(out.some((t) => t.includes("/unbind 確定") && t.includes("你的 Discord ↔") && !t.includes("LINE")), "/unbind asks for the word, worded for Discord");
seen.set(U, 0); // erase purges the push log for this user
({ out } = await send(cmd("unbind", "確定")));
expect(out.some((t) => t.includes("已解除")), "/unbind 確定 unbinds");
expect((await bridge(`/bridge/user/${U}`)).bound === false, "…and the bridge agrees");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
