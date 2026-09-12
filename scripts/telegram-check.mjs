// v0.15.0 — the Telegram webhook, end to end, without Telegram: forged Updates carrying the dev webhook secret
// (TELEGRAM_WEBHOOK_SECRET in .dev.vars) are posted to /telegram/webhook. With no TELEGRAM_BOT_TOKEN the relay cannot
// send, so every answer falls back to the push queue and is read back from /bridge/debug/pushes (kind "reply").
// Needs a local relay with DEBUG_ROUTES=1 and the dev secret:
//   RELAY=http://127.0.0.1:8787 BRIDGE_KEY=devbridge node scripts/telegram-check.mjs
import { randomBytes } from "node:crypto";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const BRIDGE_KEY = process.env.BRIDGE_KEY ?? "devbridge";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "devtelegramsecret0000";
const BOT_USER = process.env.TELEGRAM_BOT_USERNAME ?? "can2cup_bot";
const VERBOSE = !!process.env.VERBOSE;
const num = () => Number.parseInt(randomBytes(4).toString("hex"), 16);
const UID = process.env.USER_ID ?? String(1_000_000_000 + num() % 1_000_000_000);
const GID = process.env.CHAT_ID ?? String(-1_000_000_000_000 - num()); // supergroup ids are negative
const U = `tg:u:${UID}`, G = `tg:c:${GID}`;
let fails = 0;
const expect = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let updateId = 900_000_000 + num() % 1_000_000;

async function post(body, { secret = SECRET, raw } = {}) {
  const r = await fetch(`${RELAY}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(secret != null ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: raw ?? JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const from = { id: Number(UID), is_bot: false, first_name: "測試員", username: "tester", language_code: "zh-hant" };
const bot = { id: 8863296557, is_bot: true, first_name: "can2cup", username: BOT_USER };
const chatDm = { id: Number(UID), type: "private", first_name: "測試員", username: "tester" };
const chatGroup = { id: Number(GID), type: "supergroup", title: "測試群" };
/** A forged Update. `where`: "dm" | "group". */
function update(fields, id = updateId++) { return { update_id: id, ...fields }; }
function msg(text, where = "dm", extra = {}, id) {
  const chat = where === "dm" ? chatDm : chatGroup;
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : [];
  return update({ message: { message_id: num() % 100000, from, chat, date: Math.floor(Date.now() / 1000), text, entities, ...extra } }, id);
}
const callback = (data, where = "dm") => update({ callback_query: { id: String(num()), from, chat_instance: "x", message: { message_id: num() % 100000, from: bot, chat: where === "dm" ? chatDm : chatGroup, date: 0, text: "…" }, data } });
const member = (where, status) => update({ my_chat_member: { chat: where === "dm" ? chatDm : chatGroup, from, date: 0, old_chat_member: { user: bot, status: status === "member" ? "left" : "member" }, new_chat_member: { user: bot, status } } });
const bridge = async (path, body, method = body ? "POST" : "GET") => (await fetch(`${RELAY}${path}`, { method, headers: { "content-type": "application/json", "x-parley-bridge-key": BRIDGE_KEY }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const seen = new Map();
async function replies(to) {
  const { pushes } = await bridge("/bridge/debug/pushes");
  const mine = pushes.filter((p) => p.kind === "reply" && p.to === to);
  const fresh = mine.slice(seen.get(to) ?? 0); seen.set(to, mine.length);
  if (VERBOSE) for (const p of fresh) console.log("   ↳", JSON.stringify(p.text).slice(0, 200));
  return fresh.map((p) => p.text);
}
/** Post, expect 200, then wait for the DO (it runs after the Worker answered) to record the reply. */
async function send(body, to = U) {
  const r = await post(body);
  expect(r.status === 200, `200 for update ${body.update_id}`);
  let out = [];
  for (let i = 0; i < 12 && !out.length; i++) { await sleep(250); out = await replies(to); }
  return { r, out };
}

// 0. the endpoint itself
let r = await post(msg("/help"), { secret: null });
expect(r.status === 401, "a webhook without the secret header is refused (401)");
r = await post(msg("/help"), { secret: "wrong-secret-of-the-same-length" });
expect(r.status === 401, "a wrong secret is refused (401)");
r = await post(null, { raw: "{not json" });
expect(r.status === 200 && r.json.ignored, "bad JSON with the right secret answers 200 (Telegram must not redeliver it)");

// 1. unbound person, in a private chat
let { out } = await send(msg("/help"));
expect(out.some((t) => t.includes("傳聲罐罐") && t.includes("/advance")), "/help answers the help text");
expect(out.some((t) => t.includes("用 Telegram 遙控") && !t.includes("LINE") && !t.includes("{chat}")), "…worded for Telegram, not LINE, no placeholder left");
({ out } = await send(msg("/start")));
expect(out.some((t) => t.includes("歡迎")), "/start (no payload) is the first hello");
({ out } = await send(msg("/start getlink")));
expect(out.some((t) => t.includes("碼是")), "/start getlink (the consent page's Telegram link) hands out a link code");
({ out } = await send(msg("/start link_ZZZZ-ZZZZ")));
expect(out.some((t) => t.includes("不存在或過期")), "/start link_CODE deep link becomes /link CODE");
({ out } = await send(msg("/status")));
expect(out.some((t) => t.includes("還沒接上 agent")), "/status while unbound says 先接上");
({ out } = await send(msg("/setup")));
expect(out.length === 2 && /can2cup setup --relay \S+ --name "[^"]*" --link [A-Z0-9]{4}-[A-Z0-9]{4}/.test(out[1]), "/setup returns two messages, the second with a 30-min --link code");
({ out } = await send(msg("/link ZZZZ-ZZZZ")));
expect(out.some((t) => t.includes("不存在或過期")), "/link with a wrong code says so");
({ out } = await send(msg(`/setup@${BOT_USER}`, "group"), G));
expect(out.some((t) => t.includes("1 對 1")), "/setup@bot in a group: the @bot suffix is stripped and the DM-only refusal answers");
const dupId = updateId++;
await post(msg("/help", "dm", {}, dupId)); await post(msg("/help", "dm", {}, dupId)); await sleep(900);
out = await replies(U);
expect(out.length === 1, `the same update_id twice is handled once (${out.length} replies)`);
({ out } = await send(msg("哈囉")));
expect(out.some((t) => t.includes("還沒接上 agent")), "a plain sentence while unbound → 先接上 (the same answer LINE gives)");
({ out } = await send(update({ message: { message_id: 1, from, chat: chatDm, date: 0, sticker: { file_id: "x" } } })));
expect(out.some((t) => t.includes("只看得懂文字")), "a sticker in DM → the non-text reply");

// 2. the "type here" button: the Worker answers it (no token here, so nothing is sent) and does not forward it
r = await post(callback("fl:/a "));
expect(r.status === 200 && r.json.ok === true, "fl: button is answered by the Worker hop (200)");
await sleep(600);
expect((await replies(U)).length === 0, "…and produces no console reply (the ForceReply prompt is the adapter's own)");
// the answer to that prompt: a reply to the bot's "✍️ /a" message
({ out } = await send(msg("測試句", "dm", { reply_to_message: { message_id: 5, from: bot, chat: chatDm, date: 0, text: "✍️ /a\n（直接回覆這則訊息…）" } })));
expect(out.some((t) => t.includes("還沒接上 agent")), "a reply to the ForceReply prompt becomes '/a 測試句' → 先接上 while unbound");

// 3. bind a (hosted) agent to this Telegram user via the debug route, then the bound commands
const h = await bridge("/bridge/debug/hosted", { userId: U });
expect(!!h.pub, "debug: hosted agent bound to the Telegram user");
({ out } = await send(msg("/status")));
expect(out.some((t) => t.includes("還沒接上任何群") && t.includes("拉進一個群組")), "/status bound, no groups → hint worded for Telegram groups");
({ out } = await send(msg("/link")));
expect(out.some((t) => /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(t) && t.includes("connector")), "/link while bound hands out a code for a connector's consent page instead of refusing");
({ out } = await send(msg("/a 今天進度如何")));
expect(out.some((t) => /已交給你的 agent|已排隊/.test(t)), "/a lands in the inbox and answers with a receipt");
const inbox = await bridge(`/bridge/debug/inbox/${U}`);
expect(inbox.items.some((i) => i.text.startsWith("今天進度如何") && i.via === "telegram"), "…the inbox holds it, via telegram");
({ out } = await send(callback("tx:/status")));
expect(out.some((t) => t.includes("還沒接上任何群")), "tx: button runs the command it carries");
({ out } = await send(msg("/agent on")));
expect(out.some((t) => t.includes("agent 模式")), "/agent on");
({ out } = await send(msg("/pause")));
expect(out.some((t) => t.includes("已暫停")), "/pause");
expect((await bridge(`/bridge/user/${U}`)).paused === true, "…and the bridge says paused");
({ out } = await send(msg("/resume")));
expect(out.some((t) => t.includes("已恢復")), "/resume");
({ out } = await send(msg("/quota")));
expect(out.some((t) => /本月 push:\d+/.test(t) && t.includes("沒有月上限")), "/quota shows this channel's own count and says it has no monthly allowance (that is LINE's)");

// 4. a group: the bot is added, /status@bot, the wire button, /a, quiet, ask
({ out } = await send(member("group", "member"), G));
expect(out.some((t) => t.includes("/status")), "added to a group (my_chat_member) → the group hello");
({ out } = await send(msg(`/status@${BOT_USER}`, "group"), G));
expect(out.some((t) => t.includes("還沒接上 agent")), "group /status@bot → unwired card (alt text recorded)");
({ out } = await send(callback("pb:parley:wire", "group"), G));
expect(out.some((t) => t.includes("正在接上") || t.includes("已排隊")), "接上這個群 button → room request queued");
const inbox2 = await bridge(`/bridge/debug/inbox/${U}`);
expect(inbox2.items.some((i) => /OPEN A CAN2CUP ROOM .*Telegram group/.test(i.text) && i.via === "telegram-group"), "…the agent's inbox names a Telegram group, via telegram-group");
({ out } = await send(msg("/a 群組裡的一句", "group"), G));
expect(out.some((t) => /已交給你的 agent|已排隊/.test(t)), "/a from the group is received");
({ out } = await send(msg(`@${BOT_USER} 你在嗎`, "group", { entities: [{ type: "mention", offset: 0, length: BOT_USER.length + 1 }] }), G));
expect(out.some((t) => t.includes("只看得懂指令")), "an @mention with plain text in a group → the command hint (mention stripped, mentioned=true)");
r = await post(msg("/pause@other_bot", "group")); await sleep(600);
expect(r.status === 200 && (await replies(G)).length === 0, "a command addressed to ANOTHER bot (/pause@other_bot) is not ours: 200, no reply, nothing paused");
expect((await bridge(`/bridge/user/${U}`)).paused !== true, "…and the agent is not paused by it");
({ out } = await send(msg("/a 字面上的 {chat} 要原樣送到", "group"), G));
expect(out.some((t) => /已交給你的 agent|已排隊/.test(t)), "/a with a literal {chat} in it is received…");
expect((await bridge(`/bridge/debug/inbox/${U}`)).items.some((i) => i.text.includes("{chat}")), "…and reaches the inbox untouched (no output-time rewriting of what people wrote)");
({ out } = await send(msg("/quiet", "group"), G));
expect(out.some((t) => t.includes("安靜")), "/quiet in the group");
({ out } = await send(msg("/ask 週末有空嗎", "group"), G));
expect(out.some((t) => t.includes("還沒接上任何 agent")), "/ask in an unwired group says so");
r = await post(member("group", "left"));
expect(r.status === 200, "removed from the group (my_chat_member left) → 200, nothing to say");

// 5. decision buttons
({ out } = await send(callback("pb:parley:ok:000000000000:3")));
expect(out.some((t) => t.includes("已同意")), "同意 button → APPROVE written to the inbox");
({ out } = await send(callback("pb:parley:no:000000000000:4")));
expect(out.some((t) => t.includes("已拒絕")), "拒絕 button → REJECT");

// 6. the way out
({ out } = await send(msg("/unbind")));
expect(out.some((t) => t.includes("/unbind 確定") && t.includes("你的 Telegram ↔") && !t.includes("LINE")), "/unbind asks for the word, worded for Telegram");
seen.set(U, 0); // erase purges the push log for this user
({ out } = await send(msg("/unbind 確定")));
expect(out.some((t) => t.includes("已解除")), "/unbind 確定 unbinds");
expect((await bridge(`/bridge/user/${U}`)).bound === false, "…and the bridge agrees");
r = await post(member("dm", "kicked"));
expect(r.status === 200, "the person blocks the bot (my_chat_member kicked in private) → 200 (unfollow)");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
