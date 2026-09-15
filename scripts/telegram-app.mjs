// v0.15.0 (Telegram adapter, Phase 2 tooling — started early to set the bot's profile) — configure the Telegram bot
// from here instead of typing into @BotFather.
//   node scripts/telegram-app.mjs show                    getMe + getWebhookInfo + current description / commands
//   node scripts/telegram-app.mjs describe --relay URL    name, description (its guide link is <relay>/guide), short description (zh-TW)
//   node scripts/telegram-app.mjs commands                (re)register the command menu from src/relay/commands.ts (needs npm run build)
//   node scripts/telegram-app.mjs app --relay URL [--drop-pending]   setWebhook with the secret token + allowed_updates
//   node scripts/telegram-app.mjs say "/status" --relay URL [--user ID] [--chat ID] [--bot-username NAME]   forge an Update as that person (webhook secret) —
//   node scripts/telegram-app.mjs tap "pb:parley:wire" --relay URL [--user ID] [--chat ID] [--bot-username NAME]  the relay answers in the REAL Telegram chat
//     `say` / `tap` test the production path without a phone (the same trick as the LINE forged-webhook self-test): the relay
//     verifies the secret, runs the console and replies through the real bot token to chat <chat> (default: the person's DM).
//     --user defaults to TELEGRAM_TEST_USER_ID in the env file. A bogus id still exercises verify → console → reply attempt.
//     --bot-username (else TELEGRAM_BOT_USERNAME from the environment or the env file) names the bot in a forged `tap`.
// There is no default relay: describe / app / say / tap need --relay.
// Reads TELEGRAM_BOT_TOKEN (and TELEGRAM_BOT_USERNAME) from .env.telegram — never in this repo. CAN2CUP_ENV_DIR
// names the directory that holds it; TELEGRAM_ENV_FILE overrides the whole path.
// The token is the bot: never print it, never commit it (docs/telegram-adapter.md §4, ~/.claude/tos/telegram.md).
import fs from "node:fs";

const args = process.argv.slice(2);
const what = args[0] ?? "show";
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const relayArg = flag("--relay");
if (["describe", "app", "say", "tap"].includes(what) && (!relayArg || !/^https?:\/\//.test(relayArg))) {
  console.error(`usage: node scripts/telegram-app.mjs ${what} … --relay https://<relay>\n--relay is required: the relay this bot belongs to`);
  process.exit(2);
}
const relay = (relayArg ?? "").replace(/\/+$/, "");

const envFile = process.env.TELEGRAM_ENV_FILE ?? `${(process.env.CAN2CUP_ENV_DIR ?? ".").replace(/[\\/]+$/, "")}/.env.telegram`;
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const TOKEN = env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error(`${envFile}: TELEGRAM_BOT_TOKEN required`); process.exit(2); }

async function api(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) { console.error(`${method} → ${r.status}: ${j.description ?? JSON.stringify(j)}`); process.exit(1); }
  return j.result;
}

// The bot's profile, in the console's own words (bot.ts vocabulary for Telegram: can2cup / 群組).
const NAME = "can2cup";
const SHORT = "把你電腦上的 AI 接上 Telegram:手機遙控它,讓它跟別人的 AI 對談。"; // ≤ 120 chars, shown on the profile page
const DESCRIPTION = [ // ≤ 512 chars, shown in the empty chat before /start
  "can2cup 傳聲罐罐 — 一個罐頭、一個紙杯、一條線。",
  "把你電腦上的 AI(Claude Code、Codex、Cursor…)接上 Telegram:用 /a 對它說一句、/status 看它在不在線、/pause 煞車;",
  "拉進群組打 /room,大家的 AI 就能在這裡對談,每句都有簽章、每筆承諾都要你點頭。",
  "只收指令,不讀群裡其他訊息;資料只留運作必要的部分,/forgetme 隨時刪光。",
  `開始:/setup。說明:${relay.replace(/^https?:\/\//, "")}/guide`,
].join("\n");

if (what === "show") {
  const me = await api("getMe");
  console.log(JSON.stringify({ id: me.id, username: me.username, first_name: me.first_name, can_join_groups: me.can_join_groups, can_read_all_group_messages: me.can_read_all_group_messages, supports_inline_queries: me.supports_inline_queries }, null, 2));
  console.log("webhook:", JSON.stringify(await api("getWebhookInfo")));
  console.log("name:", JSON.stringify(await api("getMyName")));
  console.log("short:", JSON.stringify(await api("getMyShortDescription")));
  console.log("description:", JSON.stringify(await api("getMyDescription")));
  console.log("commands:", (await api("getMyCommands")).map((c) => `/${c.command}`).join(" ") || "(none)");
} else if (what === "describe") {
  if (SHORT.length > 120 || DESCRIPTION.length > 512) { console.error(`too long: short ${SHORT.length}/120, description ${DESCRIPTION.length}/512`); process.exit(2); }
  await api("setMyName", { name: NAME });
  await api("setMyShortDescription", { short_description: SHORT });
  await api("setMyDescription", { description: DESCRIPTION });
  console.log(`set: name "${NAME}", short (${SHORT.length} chars), description (${DESCRIPTION.length} chars)`);
} else if (what === "commands") {
  const { PUBLIC_COMMANDS } = await import("../dist/relay/commands.js");
  // Telegram: command 1–32 chars [a-z0-9_], description 1–256 chars; no argument schema — the description says it.
  // v0.17.0: the menu in English by default, and in Chinese for people whose Telegram is set to Chinese.
  const menu = (lang) => PUBLIC_COMMANDS.map((c) => ({ command: c.name, description: (lang === "zh" ? (c.arg ? `${c.zh}(${c.arg.zh})` : c.zh) : (c.arg ? `${c.en} (${c.arg.en})` : c.en)).slice(0, 256) }));
  const commands = menu("en");
  await api("setMyCommands", { commands, scope: { type: "default" } });
  await api("setMyCommands", { commands: menu("zh"), scope: { type: "default" }, language_code: "zh" });
  console.log(`registered ${commands.length} commands: ${commands.map((c) => "/" + c.command).join(" ")}`);
} else if (what === "app") {
  // setWebhook: the relay's /telegram/webhook, the secret the relay verifies (TELEGRAM_WEBHOOK_SECRET — the same value,
  // set as a wrangler secret first), and only the update types the adapter reads. Telegram validates the URL on the spot.
  // guest_message (v0.18.0) only ever arrives once Guest Mode is turned on for this bot in @BotFather's Mini App —
  // listing it here is harmless either way, it just means nothing is sent until that separate manual step is done.
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) { console.error(`${envFile}: TELEGRAM_WEBHOOK_SECRET required (16–256 chars of A-Za-z0-9_-; the same value as the wrangler secret)`); process.exit(2); }
  const r = await api("setWebhook", { url: `${relay}/telegram/webhook`, secret_token: secret, allowed_updates: ["message", "callback_query", "my_chat_member", "guest_message"], drop_pending_updates: args.includes("--drop-pending"), max_connections: 20 });
  console.log(`setWebhook → ${r}; now:`, JSON.stringify(await api("getWebhookInfo")));
} else if (what === "say" || what === "tap") {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) { console.error(`${envFile}: TELEGRAM_WEBHOOK_SECRET required`); process.exit(2); }
  const payload = args[1];
  if (!payload || payload.startsWith("--")) { console.error(`usage: telegram-app.mjs ${what} "<text or callback data>" --relay URL [--user ID] [--chat ID]`); process.exit(2); }
  const userId = Number(flag("--user") ?? env.TELEGRAM_TEST_USER_ID);
  if (!Number.isSafeInteger(userId)) { console.error("--user <telegram numeric id> required (or TELEGRAM_TEST_USER_ID in the env file)"); process.exit(2); }
  const chatId = Number(flag("--chat") ?? userId);
  // no forged display name: the relay caches names it sees, and this Update must not rename the real person
  const from = { id: userId, is_bot: false, language_code: "zh-hant" };
  const chat = chatId === userId ? { id: chatId, type: "private" } : { id: chatId, type: "supergroup", title: "forged group" };
  if (what === "say" && /^\/(unbind|forgetme|erase|link)/i.test(payload) && !args.includes("--force")) { console.error(`refusing to forge "${payload.split(/\s/)[0]}" — it unbinds, erases or re-binds the real person; add --force if you really mean it`); process.exit(2); }
  const updateId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000); // far above Telegram's real sequence, so the relay's dedup never collides
  // the relay recognises its own bot by the token's id; the username is decoration here and is left out when unknown
  const botUsername = (flag("--bot-username") ?? process.env.TELEGRAM_BOT_USERNAME ?? env.TELEGRAM_BOT_USERNAME)?.replace(/^@/, "");
  const bot = { id: Number(TOKEN.split(":")[0]), is_bot: true, first_name: NAME, ...(botUsername ? { username: botUsername } : {}) };
  const update = what === "say"
    ? { update_id: updateId, message: { message_id: updateId % 100000, from, chat, date: Math.floor(Date.now() / 1000), text: payload, entities: payload.startsWith("/") ? [{ type: "bot_command", offset: 0, length: payload.split(/\s/)[0].length }] : [] } }
    : { update_id: updateId, callback_query: { id: String(updateId), from, chat_instance: "forged", message: { message_id: updateId % 100000, from: bot, chat, date: 0, text: "…" }, data: payload } };
  const r = await fetch(`${relay}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) });
  console.log(`${what} → ${relay}/telegram/webhook: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  console.log(`the relay now runs the console for user ${userId} in chat ${chatId} and answers through the real bot; look at the Telegram chat (or wrangler tail --status error for a refused send).`);
} else {
  console.error(`unknown: ${what} (show | describe | commands | app | say | tap)`); process.exit(2);
}
