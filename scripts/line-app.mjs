// Read a LINE bot's configuration from the Messaging API instead of clicking through two consoles.
//   node scripts/line-app.mjs show     the bot's profile and response mode, the webhook endpoint, this month's message
//                                      allowance and usage, every rich menu (name, size, chat bar text, what each area
//                                      does), the default menu and the aliases
// Read-only. Settings that live only in LINE Official Account Manager (auto-reply, greeting message, joining groups)
// and webhook redelivery have no read API; `show` names them so a person checks them by hand.
//
// Credentials, from .env.line — never in this repo. CAN2CUP_ENV_DIR names the directory that holds it; LINE_ENV_FILE
// overrides the whole path. Either of:
//   LINE_CHANNEL_ACCESS_TOKEN=…                      the relay's long-lived token (copy it; "Reissue" revokes the relay's)
//   LINE_CHANNEL_ID=… and LINE_CHANNEL_SECRET=…      a 15-minute stateless token is minted for this run and revokes nothing
// The token is the bot: never print it, never commit it (~/.claude/tos/line.md).
import fs from "node:fs";

const args = process.argv.slice(2);
const what = args[0] ?? "show";

const envFile = process.env.LINE_ENV_FILE ?? `${(process.env.CAN2CUP_ENV_DIR ?? ".").replace(/[\\/]+$/, "")}/.env.line`;
if (!fs.existsSync(envFile)) {
  console.error(`${envFile} not found: put LINE_CHANNEL_ACCESS_TOKEN, or LINE_CHANNEL_ID + LINE_CHANNEL_SECRET, in a .env.line (CAN2CUP_ENV_DIR names its directory)`);
  process.exit(2);
}
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));

async function token() {
  if (env.LINE_CHANNEL_ACCESS_TOKEN) return env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!env.LINE_CHANNEL_ID || !env.LINE_CHANNEL_SECRET) { console.error(`${envFile}: LINE_CHANNEL_ACCESS_TOKEN, or LINE_CHANNEL_ID + LINE_CHANNEL_SECRET, required`); process.exit(2); }
  // stateless channel access token: valid 15 minutes, issued without revoking any other token of the channel
  const r = await fetch("https://api.line.me/oauth2/v3/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { console.error(`stateless token → HTTP ${r.status}: ${j.error_description ?? j.error ?? "no token"}`); process.exit(1); }
  return j.access_token;
}
const TOKEN = await token();

/** GET a Messaging API path; 404 → null (e.g. no default rich menu). */
async function get(path) {
  const r = await fetch(`https://api.line.me${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
  if (!r.ok) { console.error(`GET ${path} → ${r.status}: ${j.message ?? JSON.stringify(j)}`); process.exit(1); }
  return j;
}

if (what === "show") {
  const info = await get("/v2/bot/info");
  console.log("bot:", JSON.stringify({ basicId: info.basicId, premiumId: info.premiumId ?? null, displayName: info.displayName, chatMode: info.chatMode, markAsReadMode: info.markAsReadMode, picture: !!info.pictureUrl }));
  if (info.chatMode !== "bot") console.log(`  !! chatMode is "${info.chatMode}": the relay needs response mode "Bot" (Official Account Manager → Settings → Response settings)`);
  console.log("webhook:", JSON.stringify(await get("/v2/bot/channel/webhook/endpoint")));
  const quota = await get("/v2/bot/message/quota");
  const used = await get("/v2/bot/message/quota/consumption");
  console.log("messages this month:", JSON.stringify({ plan: quota?.type, allowance: quota?.value ?? null, used: used?.totalUsage ?? null }));
  const menus = (await get("/v2/bot/richmenu/list"))?.richmenus ?? [];
  const def = (await get("/v2/bot/user/all/richmenu"))?.richMenuId ?? null;
  console.log(`rich menus: ${menus.length}`);
  for (const m of menus) {
    const act = (a) => a.type === "message" ? `say ${a.text}` : a.type === "uri" ? `open ${a.uri}` : a.type === "postback" ? `postback ${a.data}${a.fillInText ? ` (keyboard: "${a.fillInText}")` : ""}` : a.type;
    console.log(`  ${m.name}  ${m.size.width}x${m.size.height}  bar "${m.chatBarText}"  selected=${m.selected}${m.richMenuId === def ? "  ← default" : ""}`);
    for (const a of m.areas) console.log(`    [${a.bounds.x},${a.bounds.y} ${a.bounds.width}x${a.bounds.height}] ${act(a.action)}`);
  }
  if (!def) console.log("  (no default rich menu)");
  const aliases = (await get("/v2/bot/richmenu/alias/list"))?.aliases ?? [];
  console.log("rich menu aliases:", aliases.length ? aliases.map((a) => `${a.richMenuAliasId} → ${menus.find((m) => m.richMenuId === a.richMenuId)?.name ?? "?"}`).join(", ") : "(none)");
  console.log("not readable through the API — check in LINE Official Account Manager / Developers Console:");
  console.log("  auto-reply messages (off), greeting message (off), allow the account to join groups and multi-person chats (on),");
  console.log("  Use webhook (on, shown above as active) and webhook redelivery (on)");
} else {
  console.error(`unknown: ${what} (show)`); process.exit(2);
}
