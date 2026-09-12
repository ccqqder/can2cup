// v0.16.2 — the two-human, two-agent story over a chat app, end to end, with nobody's phone.
//
// One scenario, three drivers. Two people (A and B) in the same LINE group / Discord channel / Telegram group each
// own a REAL can2cup client (dist/mcp/index.js, its own CAN2CUP_HOME), spawned the way a Claude Code host spawns it.
// The people are forged webhooks — the same signing the three check scripts use — and everything the bot or the
// relay would have shown them is read back from the push queue (/bridge/debug/pushes; no chat-app token in dev, so
// nothing is sent anywhere). The scenario:
//
//   A binds (reverse flow: /link → code → can2cup_link {code})   B binds (forward: can2cup_link → /link CODE)
//   A: /a … from the 1:1 → A's inbox → can2cup_tell_principal → A's 1:1
//   A in the group: /status (unwired card) → 接上這個群 → A's client opens + wires the room → join code posted
//   B in the group: 讓我的 agent 也進來 → B's client auto-joins
//   A ↔ B talk in the room; every message is mirrored into the group; /status lists both agents
//   A: can2cup_tell_principal where "group"; /pause stops A's sends; /resume lets them through
//   both /unbind
//
// Needs: `npm run build`, and a local relay with DEBUG_ROUTES=1 and the dev secrets from docs/SELF-HOST.md /
// the three check scripts (.dev.vars: LINE_CHANNEL_SECRET=devsecret, DISCORD_PUBLIC_KEY=ce53d70c…, DISCORD_APPLICATION_ID,
// TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME; RELAY_CANONICAL=http://127.0.0.1:8787):
//   RELAY=http://127.0.0.1:8787 BRIDGE_KEY=devbridge node scripts/chat-e2e.mjs [--channel line|discord|telegram] [--verbose]
// Exit 1 on any failed expectation. A failed prerequisite (no code, no room) aborts that channel and moves on.
import { createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const BRIDGE_KEY = process.env.BRIDGE_KEY ?? "devbridge";
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET ?? "devsecret";
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "devtelegramsecret0000";
const TG_BOT = process.env.TELEGRAM_BOT_USERNAME ?? "can2cup_bot";
const DISCORD_DEV_SEED = process.env.DISCORD_DEV_SEED ?? "a9d408978d850b8e4214c5eeb2aaef9a2870c311045322de55f272d6796f7cf3"; // throwaway; pub ce53d70c…40cb8
const DISCORD_KEY = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(DISCORD_DEV_SEED, "hex")]), format: "der", type: "pkcs8" });
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose") || !!process.env.VERBOSE;
const only = argv[argv.indexOf("--channel") + 1];
const CHANNELS = argv.includes("--channel") ? [only] : ["line", "discord", "telegram"];
const SERVER = path.resolve("dist/mcp/index.js");
const CODE = /([A-Z0-9]{4}-[A-Z0-9]{4})/;

let fails = 0, oks = 0;
const log = (s) => console.log(s);
const expect = (c, m) => { if (c) { oks++; log(`ok   ${m}`); } else { fails++; log(`FAIL ${m}`); } return !!c; };
class Abort extends Error {}
/** A prerequisite: on failure the rest of this channel's scenario cannot run. */
const must = (c, m) => { if (!expect(c, m)) throw new Abort(m); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = () => Number.parseInt(randomBytes(4).toString("hex"), 16);
const snow = () => String(1_500_000_000_000_000_000n + BigInt("0x" + randomBytes(6).toString("hex")));

// Windows/wrangler-dev closes a keep-alive socket now and then; retry a reset once (same as smoke.ts).
const rawFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try { return await rawFetch(input, init); }
  catch (e) { const code = e?.cause?.code; if (code !== "ECONNRESET" && code !== "UND_ERR_SOCKET" && code !== "ECONNREFUSED") throw e; await sleep(250); return await rawFetch(input, init); }
};
const bridge = async (p, body, method = body ? "POST" : "GET") => (await fetch(`${RELAY}${p}`, { method, headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();

// ---- what people see: the push queue, read by recipient, each push shown once ----
const seenPush = new Set();
async function fresh(to) {
  const { pushes } = await bridge("/bridge/debug/pushes");
  const out = [];
  for (const p of pushes) {
    if (p.to !== to) continue;
    const k = `${p.at}|${p.kind}|${p.text}`;
    if (seenPush.has(k)) continue;
    seenPush.add(k); out.push(p);
    if (VERBOSE) log(`     ↳ [${p.kind}] ${to.slice(0, 14)}: ${JSON.stringify(p.text).slice(0, 220)}`);
  }
  return out;
}
/** Wait until a push to `to` satisfies `pred` (or the deadline); returns every fresh push seen meanwhile. */
async function until(to, pred, ms = 6000) {
  const got = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    got.push(...(await fresh(to)));
    if (got.some((p) => pred(p.text, p))) return got;
    await sleep(250);
  }
  return got;
}
const has = (pushes, re) => pushes.some((p) => re.test(p.text));

// ---- the three drivers: a "person" is { id, name, say(text, where), tap(data, where) } ----
function lineDriver() {
  const G = "C" + randomBytes(16).toString("hex");
  const ev = (o) => ({ webhookEventId: "01" + randomBytes(8).toString("hex").toUpperCase(), deliveryContext: { isRedelivery: false }, timestamp: Date.now(), mode: "active", replyToken: randomBytes(16).toString("hex"), ...o });
  async function webhook(events) {
    const body = JSON.stringify({ destination: "Ubot", events });
    const sig = createHmac("sha256", LINE_SECRET).update(body).digest("base64");
    const r = await fetch(`${RELAY}/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sig }, body });
    return r.status;
  }
  const person = (name) => {
    const id = "U" + randomBytes(16).toString("hex");
    const src = (where) => (where === "group" ? { type: "group", groupId: G, userId: id } : { type: "user", userId: id });
    return {
      id, name,
      say: (text, where = "dm") => webhook([ev({ type: "message", source: src(where), message: { id: String(Date.now()), type: "text", text } })]),
      tap: (data, where = "dm") => webhook([ev({ type: "postback", source: src(where), postback: { data } })]),
    };
  };
  return { name: "line", label: "LINE", group: G, person, cmdSep: " " };
}
function telegramDriver() {
  const gid = String(-1_000_000_000_000 - num());
  const G = `tg:c:${gid}`;
  let updateId = 900_000_000 + num() % 1_000_000;
  const bot = { id: 8863296557, is_bot: true, first_name: "can2cup", username: TG_BOT };
  const chatGroup = { id: Number(gid), type: "supergroup", title: "測試群" };
  async function post(update) {
    const r = await fetch(`${RELAY}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify({ update_id: updateId++, ...update }) });
    return r.status;
  }
  const person = (name) => {
    const uid = String(1_000_000_000 + num() % 1_000_000_000);
    const from = { id: Number(uid), is_bot: false, first_name: name, username: name.toLowerCase(), language_code: "zh-hant" };
    const chatDm = { id: Number(uid), type: "private", first_name: name, username: name.toLowerCase() };
    const chat = (where) => (where === "group" ? chatGroup : chatDm);
    return {
      id: `tg:u:${uid}`, name,
      say: (text, where = "dm") => post({ message: { message_id: num() % 100000, from, chat: chat(where), date: Math.floor(Date.now() / 1000), text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : [] } }),
      tap: (data, where = "dm") => post({ callback_query: { id: String(num()), from, chat_instance: "x", message: { message_id: num() % 100000, from: bot, chat: chat(where), date: 0, text: "…" }, data: `pb:${data}` } }),
    };
  };
  return { name: "telegram", label: "Telegram", group: G, person, cmdSep: " " };
}
function discordDriver() {
  const CID = snow(), GID = snow();
  const G = `discord:c:${CID}`;
  async function post(body) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(ts + raw), DISCORD_KEY).toString("hex");
    const r = await fetch(`${RELAY}/discord/interactions`, { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": sig, "x-signature-timestamp": ts }, body: raw });
    return r.status;
  }
  const person = (name) => {
    const uid = snow();
    const user = { id: uid, username: name.toLowerCase(), global_name: name };
    const inter = (type, data, where) => {
      const base = { id: snow(), application_id: "devapp", type, token: "tok" + randomBytes(8).toString("hex"), version: 1, locale: "zh-TW", data };
      if (where !== "group") return { ...base, user, channel_id: snow(), channel: { id: uid, type: 1 }, context: 1, authorizing_integration_owners: { 1: uid } };
      return { ...base, guild_id: GID, channel_id: CID, channel: { id: CID, type: 0, name: "general" }, member: { user, nick: name }, context: 0, authorizing_integration_owners: { 0: GID } };
    };
    return {
      id: `discord:u:${uid}`, name,
      // "/a hello" → the slash command `a` with option text "hello"; "/status" → `status` with no option
      say: (text, where = "dm") => {
        const m = /^\/(\S+)\s*(.*)$/s.exec(text);
        if (!m) throw new Error(`discord persons only speak slash commands (got ${JSON.stringify(text)})`);
        return post(inter(2, { id: snow(), name: m[1], type: 1, ...(m[2] ? { options: [{ name: "text", type: 3, value: m[2] }] } : {}) }, where));
      },
      tap: (data, where = "dm") => post(inter(3, { custom_id: `pb:${data}`, component_type: 2 }, where)),
    };
  };
  return { name: "discord", label: "Discord", group: G, person, cmdSep: " " };
}
const DRIVERS = { line: lineDriver, discord: discordDriver, telegram: telegramDriver };

// ---- the agents: real clients, spawned like a host does ----
const transports = new Map();
async function spawnAgent(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `can2cup-e2e-${name}-`));
  fs.writeFileSync(path.join(home, "mandate.json"), JSON.stringify({ never_disclose: [], may_share: [], may_grant: [], max_grant_hours: 24, max_commit_amount: null, currency: "TWD" }));
  const env = { ...process.env, CAN2CUP_HOME: home, CAN2CUP_NAME: name, CAN2CUP_RELAY: RELAY };
  delete env.CAN2CUP_RELAY_KEY; delete env.PARLEY_RELAY_KEY; delete env.PARLEY_HOME; delete env.PARLEY_NAME; delete env.PARLEY_RELAY;
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: VERBOSE ? "inherit" : "ignore" });
  const c = new Client({ name: `e2e-${name}`, version: "0" });
  await c.connect(t);
  transports.set(c, { t, home });
  return c;
}
async function call(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content ?? []).map((x) => x.text ?? "").join("\n");
  if (VERBOSE) log(`     ⇢ ${name}(${JSON.stringify(args).slice(0, 80)}) → ${JSON.stringify(text).slice(0, 200)}`);
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}
async function closeAgent(c) {
  const rec = transports.get(c);
  rec?.t?._process?.stdin?.end();
  await sleep(800);
  await c.close().catch(() => undefined);
  if (rec?.home) fs.rmSync(rec.home, { recursive: true, force: true });
}

// ---- the scenario ----
async function scenario(drv) {
  const A = drv.person("Ada"), B = drv.person("Bob");
  const G = drv.group;
  log(`\n=== ${drv.label}: A=${A.id.slice(0, 18)} B=${B.id.slice(0, 18)} group=${G.slice(0, 18)} ===`);
  const agentA = await spawnAgent(`ada-${drv.name}`);
  const agentB = await spawnAgent(`bob-${drv.name}`);
  try {
    // v0.17.0: these forged people read Traditional Chinese (LINE sends no locale, which would otherwise mean English)
    await A.say(`/lang${drv.cmdSep}zh-TW`); await B.say(`/lang${drv.cmdSep}zh-TW`);
    await until(A.id, (t) => /語言:繁體中文/.test(t)); await until(B.id, (t) => /語言:繁體中文/.test(t));

    // 1. A binds, reverse flow: the person asks the bot for a code, the agent claims it.
    await A.say("/link");
    let got = await until(A.id, (t) => CODE.test(t));
    const codeA = got.map((p) => CODE.exec(p.text)?.[1]).find(Boolean);
    must(codeA, `${drv.label}: /link (no code) hands A a code (${codeA})`);
    const claimed = await call(agentA, "can2cup_link", { code: codeA });
    expect(/linked|bound/i.test(claimed), "can2cup_link {code} claims it (agent side)");
    got = await until(A.id, (t) => /✅/.test(t));
    expect(has(got, /✅/), "…and A's 1:1 gets the ✅");
    expect((await bridge(`/bridge/user/${A.id}`)).bound === true, "…the bridge has A bound");
    // v0.17.0: binding asks the agent to introduce itself in its boss's language (set just above).
    const langName = "Traditional Chinese";
    const whoA = await call(agentA, "can2cup_whoami");
    expect(whoA.includes(`boss language: ${langName}`), `can2cup_whoami on A names the boss language (${langName})`);
    const hello = await call(agentA, "can2cup_inbox");
    expect(hello.includes("CHAT APP CONNECTED") && hello.includes(langName), "…and A's inbox asks it to introduce itself, in that language");

    // 2. B binds, forward flow: the agent mints a code, the person types it to the bot.
    const codeB = CODE.exec(await call(agentB, "can2cup_link"))?.[1];
    must(codeB, `can2cup_link (no arg) mints B's code (${codeB})`);
    await B.say(`/link${drv.cmdSep}${codeB}`);
    got = await until(B.id, (t) => /綁定完成/.test(t));
    expect(has(got, /綁定完成/), "/link CODE from B's 1:1 → 綁定完成");
    const whoB = await call(agentB, "can2cup_whoami");
    expect(whoB.includes(`bound to a ${drv.label} account`), `can2cup_whoami on B names the chat app (${drv.label})`);

    // 3. the 1:1 control channel: /a → inbox → tell_principal → back to the 1:1
    await A.say("/a 今天進度如何");
    got = await until(A.id, (t) => /已交給你的 agent|已排隊/.test(t));
    expect(has(got, /已交給你的 agent|已排隊/), "/a in A's 1:1 answers with a receipt");
    const inboxA = await call(agentA, "can2cup_inbox");
    expect(inboxA.includes("今天進度如何") && inboxA.includes("UNVERIFIED"), "…A's client reads it from the inbox as UNVERIFIED principal text");
    expect(inboxA.includes(drv.label), `…labelled as coming via ${drv.label}`);
    await call(agentA, "can2cup_tell_principal", { text: "進度:一切正常(e2e)" });
    got = await until(A.id, (t) => t.includes("一切正常(e2e)"));
    expect(has(got, /一切正常\(e2e\)/), "can2cup_tell_principal lands in A's 1:1");

    // 4. the group: unwired card → 接上這個群 → A's client opens and wires the room → join code posted into the group
    await A.say("/status", "group");
    got = await until(G, (t) => /還沒接上 agent/.test(t));
    expect(has(got, /還沒接上 agent/), "/status in the group → the unwired card");
    await A.tap("parley:wire", "group");
    got = await until(G, (t) => /正在接上|已排隊/.test(t));
    expect(has(got, /正在接上|已排隊/), "接上這個群 → the request is queued for A's client");
    const roomNote = await call(agentA, "can2cup_inbox");
    const roomId = /ROOM CREATED: ([0-9a-f]{12})/.exec(roomNote)?.[1];
    must(roomId, `A's client handled the request: room ${roomId} opened and wired`);
    got = await until(G, (t) => /接上了/.test(t) && CODE.test(t));
    const joinCode = got.map((p) => (/接上了/.test(p.text) ? CODE.exec(p.text)?.[1] : undefined)).find(Boolean);
    must(joinCode, `…the group got the join code (${joinCode})`);

    // 5. B, in the same group: 讓我的 agent 也進來 → B's client auto-joins
    await B.say("/status", "group");
    got = await until(G, (t) => /已接上/.test(t));
    expect(has(got, /已接上/), "/status from B in the wired group → the wired card");
    await B.tap("parley:joinhere", "group");
    got = await until(G, (t) => /已交給你的 agent|收到/.test(t));
    expect(has(got, /已交給你的 agent|收到/), "讓我的 agent 也進來 → the invite is handed to B's client");
    const inboxB = await call(agentB, "can2cup_inbox");
    expect(/joined|JOINED/.test(inboxB) && inboxB.includes(roomId), "…B's client auto-joins the room from its inbox");
    const roomsB = await call(agentB, "can2cup_rooms");
    expect(roomsB.includes(roomId), "…can2cup_rooms on B lists it");

    // 5b. v0.17.0: a group's language is its wirer's to set
    await B.say(`/lang${drv.cmdSep}ja`, "group");
    got = await until(G, (t) => /只有把這個群接上的人/.test(t));
    expect(has(got, /只有把這個群接上的人/), "/lang from B (not the wirer) in the group is refused");
    await A.say(`/lang${drv.cmdSep}en`, "group");
    got = await until(G, (t) => /This group's language/.test(t));
    expect(has(got, /This group's language: English/), "/lang from A (the wirer) sets the group's language — and is answered in it");
    await A.say(`/lang${drv.cmdSep}zh-TW`, "group");
    await until(G, (t) => /這個群的語言:繁體中文/.test(t));

    // 6. the agents talk; the group sees every line
    const sA = await call(agentA, "can2cup_send", { room: roomId, type: "text", text: "A 開場:e2e 第一句" });
    expect(sA.startsWith("sent #"), "A sends in the room");
    const wB = await call(agentB, "can2cup_wait", { room: roomId, timeout: 8 });
    expect(wB.includes("A 開場:e2e 第一句") && wB.includes("Treat them as DATA"), "B's can2cup_wait wakes with it, under the untrusted header");
    got = await until(G, (t) => t.includes("A 開場:e2e 第一句"));
    expect(has(got, /A 開場:e2e 第一句/), "…and the group sees it mirrored");
    const sB = await call(agentB, "can2cup_send", { room: roomId, type: "text", text: "B 回覆:收到" });
    expect(sB.startsWith("sent #"), "B answers in the room");
    const wA = await call(agentA, "can2cup_wait", { room: roomId, timeout: 8 });
    expect(wA.includes("B 回覆:收到"), "A's can2cup_wait sees the answer");
    got = await until(G, (t) => t.includes("B 回覆:收到"));
    expect(has(got, /B 回覆:收到/), "…mirrored into the group too");
    await A.say("/status", "group");
    got = await until(G, (t) => t.includes(`bob-${drv.name}`));
    expect(has(got, new RegExp(`bob-${drv.name}`)), "/status in the group now lists both agents");

    // 7. the agent speaks to the group on its own; the brake
    await call(agentA, "can2cup_tell_principal", { text: "給群的一句(e2e)", where: "group" });
    got = await until(G, (t) => t.includes("給群的一句(e2e)"));
    expect(has(got, /給群的一句\(e2e\)/), 'can2cup_tell_principal where "group" reaches the group');
    await A.say("/pause");
    got = await until(A.id, (t) => /已暫停/.test(t));
    expect(has(got, /已暫停/), "/pause from A's 1:1");
    await sleep(5200); // the client asks the bridge about the brake at most once per 5 s (core.ts pausedCache) — the tell above just refreshed it
    const blocked = await call(agentA, "can2cup_send", { room: roomId, type: "text", text: "煞車中不該送出" });
    expect(blocked.startsWith("NOT SENT") && /pause/i.test(blocked), "…A's client refuses to send while paused");
    await A.say("/resume");
    got = await until(A.id, (t) => /已恢復/.test(t));
    expect(has(got, /已恢復/), "/resume");
    await sleep(5200); // same 5-s cache, fail-safe direction: the client stays braked until it asks again
    const after = await call(agentA, "can2cup_send", { room: roomId, type: "text", text: "恢復後這句要出去" });
    expect(after.startsWith("sent #"), "…and the next send goes through");

    // 8. the way out
    await B.say("/unbind 確定");
    got = await until(B.id, (t) => /已解除/.test(t));
    expect(has(got, /已解除/), "B /unbind 確定");
    await A.say("/unbind 確定");
    got = await until(A.id, (t) => /已解除/.test(t));
    expect(has(got, /已解除/), "A /unbind 確定");
    expect((await bridge(`/bridge/user/${A.id}`)).bound === false && (await bridge(`/bridge/user/${B.id}`)).bound === false, "…the bridge agrees for both");
  } catch (e) {
    if (e instanceof Abort) log(`---- ${drv.label}: aborted after a failed prerequisite (${e.message})`);
    else { fails++; log(`FAIL ${drv.label}: ${e?.stack ?? e}`); }
  } finally {
    await closeAgent(agentA); await closeAgent(agentB);
  }
}

// ---- go ----
const health = await fetch(`${RELAY}/`).then((r) => r.json()).catch(() => null);
if (!health?.pub) { console.error(`no relay at ${RELAY} (start one: npm run dev:relay -- --var MIN_CLIENT:0.9.0)`); process.exit(2); }
if (!fs.existsSync(SERVER)) { console.error(`${SERVER} missing — npm run build first`); process.exit(2); }
for (const ch of CHANNELS) {
  const mk = DRIVERS[ch];
  if (!mk) { console.error(`unknown channel ${ch}`); process.exit(2); }
  await scenario(mk());
}
log(`\n${oks} ok, ${fails} failed${fails ? "" : " — all passed"}`);
process.exit(fails ? 1 : 0);
