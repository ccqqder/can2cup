// Set up and read a LINE bot through the Messaging API instead of clicking through two consoles.
//   node scripts/line-app.mjs show     the bot's profile and response mode, the webhook endpoint, this month's message
//                                      allowance and usage, every rich menu (name, size, chat bar text, what each area
//                                      does), the default menu and the aliases. Read-only.
//   node scripts/line-app.mjs app --relay https://<relay>
//                                      point the webhook at <relay>/line/webhook, then have LINE send it a test event and
//                                      print the result. There is no default relay; LINE accepts only an HTTPS webhook.
//   node scripts/line-app.mjs menus --dir <dir> [--dry-run] [--console-prefix P] [--onboard-prefix P]
//                                      install the two rich menus from <dir>: console.json + console.png (people bound to
//                                      an agent) and onboard.json + onboard.png (everyone else; a .jpg works too). Make
//                                      them with tools/richmenu/make_richmenu.py.
// `menus` checks everything before it calls LINE: each JSON's name must start with its prefix (the relay finds the menus
// by name prefix: --console-prefix / --onboard-prefix, else LINE_MENU_CONSOLE / LINE_MENU_ONBOARD from the environment
// or the env file, else the relay's defaults can2cup-menu-console / can2cup-menu-onboard), and each image must be PNG or
// JPEG, at most 1 MB, 800–2500 px wide, 250+ px high, width/height ≥ 1.45, with the pixel size its JSON declares.
// Then, in this order: create console → upload its image → create onboard → upload its image → make onboard the default
// → only then delete the older menus whose names start with either prefix (never the two just created). If a step before
// the default fails, the menus this run created are deleted again. --dry-run prints the plan and calls nothing.
// Settings that live only in LINE Official Account Manager (auto-reply, greeting message, joining groups), the "Use
// webhook" switch and webhook redelivery have no write API; `show` names them so a person checks them by hand.
//
// Credentials, from .env.line — never in this repo. CAN2CUP_ENV_DIR names the directory that holds it; LINE_ENV_FILE
// overrides the whole path. Either of:
//   LINE_CHANNEL_ACCESS_TOKEN=…                      the relay's long-lived token (copy it; "Reissue" revokes the relay's)
//   LINE_CHANNEL_ID=… and LINE_CHANNEL_SECRET=…      a 15-minute stateless token is minted for this run and revokes nothing
// The token is the bot: never print it, never commit it (~/.claude/tos/line.md).
// For tests only (scripts/line-app-check.mjs): LINE_API_BASE (default https://api.line.me) and LINE_API_DATA_BASE
// (default https://api-data.line.me) point the calls at a fake server.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const what = args[0] ?? "show";
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const API = (process.env.LINE_API_BASE ?? "https://api.line.me").replace(/\/+$/, "");
const DATA = (process.env.LINE_API_DATA_BASE ?? "https://api-data.line.me").replace(/\/+$/, "");
const USAGE = "usage: node scripts/line-app.mjs show | app --relay https://<relay> | menus --dir <dir> [--dry-run] [--console-prefix P] [--onboard-prefix P]";

// Leaving with process.exit() right after a fetch can abort Node on Windows (a libuv assertion, exit 0xC0000409 instead
// of the code asked for). exit() unwinds to the bottom of the file instead, and the process ends on its own.
class Exit { constructor(code) { this.code = code; } }
const exit = (code) => { throw new Exit(code); };

const envFile = process.env.LINE_ENV_FILE ?? `${(process.env.CAN2CUP_ENV_DIR ?? ".").replace(/[\\/]+$/, "")}/.env.line`;
const env = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
  : null;

let TOKEN;
async function token() {
  if (!env) { console.error(`${envFile} not found: put LINE_CHANNEL_ACCESS_TOKEN, or LINE_CHANNEL_ID + LINE_CHANNEL_SECRET, in a .env.line (CAN2CUP_ENV_DIR names its directory)`); exit(2); }
  if (env.LINE_CHANNEL_ACCESS_TOKEN) return env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!env.LINE_CHANNEL_ID || !env.LINE_CHANNEL_SECRET) { console.error(`${envFile}: LINE_CHANNEL_ACCESS_TOKEN, or LINE_CHANNEL_ID + LINE_CHANNEL_SECRET, required`); exit(2); }
  // stateless channel access token: valid 15 minutes, issued without revoking any other token of the channel
  const r = await fetch(`${API}/oauth2/v3/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { console.error(`stateless token → HTTP ${r.status}: ${j.error_description ?? j.error ?? "no token"}`); exit(1); }
  return j.access_token;
}

/** One Messaging API call. `json` sends a JSON body, `bytes` + `type` a binary one. Never throws on an HTTP error. */
async function call(method, url, { json, bytes, type } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  if (bytes) headers["content-type"] = type;
  const r = await fetch(url, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : bytes ? { body: bytes } : {}) });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body };
}
const why = (r) => `${r.status}: ${r.body.message ?? JSON.stringify(r.body)}${r.body.details ? ` ${JSON.stringify(r.body.details)}` : ""}`;

/** GET a Messaging API path; 404 → null (e.g. no default rich menu). */
async function get(p) {
  const r = await call("GET", `${API}${p}`);
  if (r.status === 404) return null;
  if (!r.ok) { console.error(`GET ${p} → ${why(r)}`); exit(1); }
  return r.body;
}

/** Format and pixel size read from the file's own header: PNG IHDR, JPEG SOFn. null = neither. */
function imageInfo(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString("latin1", 12, 16) === "IHDR") {
    return { type: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; } // fill byte
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers without a length
      if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before any frame header
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return i + 8 < buf.length ? { type: "image/jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

async function show() {
  TOKEN = await token();
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
}

async function app() {
  const relayArg = flag("--relay");
  if (!relayArg || !/^https:\/\/[^/\s]+/.test(relayArg)) {
    console.error("usage: node scripts/line-app.mjs app --relay https://<relay>\n--relay is required: the relay whose /line/webhook LINE should call (HTTPS; LINE refuses anything else)");
    exit(2);
  }
  const relay = relayArg.replace(/\/+$/, "");
  const endpoint = `${relay}/line/webhook`;
  if (endpoint.length > 500) { console.error(`${endpoint}: LINE takes a webhook URL of at most 500 characters`); exit(2); }
  TOKEN = await token();
  const set = await call("PUT", `${API}/v2/bot/channel/webhook/endpoint`, { json: { endpoint } });
  if (!set.ok) { console.error(`PUT /v2/bot/channel/webhook/endpoint → ${why(set)}`); exit(1); }
  console.log(`webhook endpoint set: ${endpoint}`);
  // with `endpoint` in the body LINE tests that URL directly; without it, the channel's setting, which can lag a minute
  const test = await call("POST", `${API}/v2/bot/channel/webhook/test`, { json: { endpoint } });
  if (!test.ok) { console.error(`POST /v2/bot/channel/webhook/test → ${why(test)}`); exit(1); }
  const t = test.body;
  console.log("webhook test:", JSON.stringify({ success: t.success ?? null, statusCode: t.statusCode, reason: t.reason, detail: t.detail, timestamp: t.timestamp }));
  if (t.success !== true) {
    console.error(`the relay did not answer LINE's test event with 200: is ${relay} deployed, with LINE_CHANNEL_SECRET set to this channel's secret?`);
    exit(1);
  }
  console.log('ok. Turn "Use webhook" on in the LINE Developers Console (Messaging API tab) if `show` does not report the webhook as active.');
}

async function menus() {
  const dir = flag("--dir");
  const dryRun = args.includes("--dry-run");
  if (!dir || dir.startsWith("--")) { console.error("usage: node scripts/line-app.mjs menus --dir <dir> [--dry-run] [--console-prefix P] [--onboard-prefix P]\n--dir is required: it holds console.json + console.png and onboard.json + onboard.png (tools/richmenu/make_richmenu.py makes them)"); exit(2); }
  const prefixOf = (flagName, envName, fallback) => {
    const v = flag(flagName) ?? process.env[envName] ?? env?.[envName];
    return v === undefined || v === "" ? { value: fallback, from: "the relay's default" } : { value: v, from: flag(flagName) !== undefined ? flagName : process.env[envName] !== undefined ? `${envName} (environment)` : `${envName} (${envFile})` };
  };
  const prefix = {
    console: prefixOf("--console-prefix", "LINE_MENU_CONSOLE", "can2cup-menu-console"), // defaults: src/relay/line.ts
    onboard: prefixOf("--onboard-prefix", "LINE_MENU_ONBOARD", "can2cup-menu-onboard"),
  };
  const errors = [];
  const P = { console: prefix.console.value, onboard: prefix.onboard.value };
  if (P.console.startsWith(P.onboard) || P.onboard.startsWith(P.console)) errors.push(`prefixes "${P.console}" and "${P.onboard}": one starts with the other, so the relay could link either menu for either kind of person`);
  const MAX_BYTES = 1_000_000; // LINE: "Max file size: 1 MB"; counted as 10^6 bytes to stay on the safe side

  const load = (key) => {
    const m = { key };
    const jsonPath = path.join(dir, `${key}.json`);
    try { m.menu = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch (e) { errors.push(`${jsonPath}: ${e.code === "ENOENT" ? "missing" : `not JSON (${e.message})`}`); }
    m.imagePath = [`${key}.png`, `${key}.jpg`, `${key}.jpeg`].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!m.imagePath) errors.push(`${path.join(dir, `${key}.png`)}: missing (or ${key}.jpg)`);
    const menu = m.menu;
    if (menu) {
      const name = menu.name;
      if (typeof name !== "string" || !name.startsWith(P[key])) {
        errors.push(`${key}.json: name ${JSON.stringify(name)} does not start with "${P[key]}" (${prefix[key].from}); the relay looks the ${key} menu up by that prefix and would never link this one`);
      } else if (name.length > 300) errors.push(`${key}.json: name is ${name.length} characters; LINE allows 300`);
      if (typeof menu.chatBarText !== "string" || [...menu.chatBarText].length < 1 || [...menu.chatBarText].length > 14) errors.push(`${key}.json: chatBarText must be 1–14 characters`);
      const w = menu.size?.width, h = menu.size?.height;
      if (!Number.isInteger(w) || !Number.isInteger(h)) errors.push(`${key}.json: size.width and size.height must be integers`);
      else if (w < 800 || w > 2500 || h < 250 || w / h < 1.45) errors.push(`${key}.json: size ${w}x${h}; LINE wants a width of 800–2500, a height of 250 or more and width/height ≥ 1.45`);
      if (!Array.isArray(menu.areas) || menu.areas.length < 1 || menu.areas.length > 20) errors.push(`${key}.json: areas must hold 1–20 tappable areas`);
      else for (const [i, a] of menu.areas.entries()) {
        const b = a?.bounds;
        if (!b || ![b.x, b.y, b.width, b.height].every(Number.isInteger) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || b.x + b.width > w || b.y + b.height > h) errors.push(`${key}.json: areas[${i}].bounds fall outside the ${w}x${h} menu`);
        if (!a?.action?.type) errors.push(`${key}.json: areas[${i}] has no action`);
      }
    }
    if (m.imagePath) {
      m.bytes = fs.readFileSync(m.imagePath);
      const info = imageInfo(m.bytes);
      if (!info) errors.push(`${m.imagePath}: not a PNG or JPEG (LINE takes only those)`);
      else {
        m.type = info.type;
        if (m.bytes.length > MAX_BYTES) errors.push(`${m.imagePath}: ${m.bytes.length} bytes; LINE's limit is 1 MB (${MAX_BYTES} bytes here)`);
        if (menu?.size && (info.width !== menu.size.width || info.height !== menu.size.height)) errors.push(`${m.imagePath}: ${info.width}x${info.height} pixels, but ${key}.json declares ${menu.size.width}x${menu.size.height}; the tappable areas would not line up`);
      }
    }
    return m;
  };
  const menus = { console: load("console"), onboard: load("onboard") };
  if (errors.length) { console.error(`refusing to install, nothing was sent to LINE:\n${errors.map((e) => `  - ${e}`).join("\n")}`); exit(2); }

  const desc = (m) => `"${m.menu.name}" ${m.menu.size.width}x${m.menu.size.height}, ${m.menu.areas.length} areas, bar "${m.menu.chatBarText}"; upload ${path.basename(m.imagePath)} (${m.type}, ${m.bytes.length} bytes)`;
  console.log(`plan (console prefix "${P.console}" from ${prefix.console.from}; onboard prefix "${P.onboard}" from ${prefix.onboard.from}):`);
  console.log(`  1. create the console menu ${desc(menus.console)}`);
  console.log(`  2. create the onboard menu ${desc(menus.onboard)}`);
  console.log(`  3. make "${menus.onboard.menu.name}" the default rich menu (what everyone sees until the relay links the console menu to them)`);
  console.log(`  4. delete the older rich menus whose names start with "${P.console}" or "${P.onboard}" (not the two created in 1–2)`);
  if (dryRun) { console.log("dry run: nothing was sent to LINE"); return; }

  TOKEN = await token();
  const created = [];
  const abort = async (message) => {
    console.error(message);
    for (const id of created.reverse()) {
      const d = await call("DELETE", `${API}/v2/bot/richmenu/${id}`);
      console.error(d.ok ? `rolled back: deleted ${id}` : `rollback failed: DELETE ${id} → ${why(d)}; delete it by hand`);
    }
    console.error("the older menus were left as they were");
    exit(1);
  };
  for (const m of [menus.console, menus.onboard]) {
    const c = await call("POST", `${API}/v2/bot/richmenu`, { json: m.menu });
    if (!c.ok || !c.body.richMenuId) await abort(`create the ${m.key} menu: POST /v2/bot/richmenu → ${why(c)}`);
    m.id = c.body.richMenuId;
    created.push(m.id);
    console.log(`created ${m.key}: ${m.id} "${m.menu.name}"`);
    const u = await call("POST", `${DATA}/v2/bot/richmenu/${m.id}/content`, { bytes: m.bytes, type: m.type });
    if (!u.ok) await abort(`upload the ${m.key} image: POST /v2/bot/richmenu/${m.id}/content → ${why(u)}`);
    console.log(`  uploaded ${path.basename(m.imagePath)}`);
  }
  const def = await call("POST", `${API}/v2/bot/user/all/richmenu/${menus.onboard.id}`);
  if (!def.ok) await abort(`set the default rich menu: POST /v2/bot/user/all/richmenu/${menus.onboard.id} → ${why(def)}`);
  console.log(`default: ${menus.onboard.id} "${menus.onboard.menu.name}"`);

  const list = await call("GET", `${API}/v2/bot/richmenu/list`);
  if (!list.ok) { console.error(`GET /v2/bot/richmenu/list → ${why(list)}\nthe new menus are installed, but the older ones were not deleted: run \`show\` and delete them, or run menus again`); exit(1); }
  const old = (list.body.richmenus ?? []).filter((m) => !created.includes(m.richMenuId) && typeof m.name === "string" && (m.name.startsWith(P.console) || m.name.startsWith(P.onboard)));
  let failed = 0;
  for (const m of old) {
    const d = await call("DELETE", `${API}/v2/bot/richmenu/${m.richMenuId}`);
    if (d.ok) console.log(`deleted: ${m.richMenuId} "${m.name}"`);
    else { failed++; console.error(`delete ${m.richMenuId} "${m.name}" → ${why(d)}`); }
  }
  if (!old.length) console.log("deleted: none (no older menus with either prefix)");
  if (failed) { console.error(`${failed} older menu(s) could not be deleted; the relay links the first menu it finds with a prefix, so delete them`); exit(1); }
  console.log("done");
}

try {
  const run = { show, app, menus }[what];
  if (!run) { console.error(`unknown: ${what}\n${USAGE}`); exit(2); }
  await run();
} catch (e) {
  if (!(e instanceof Exit)) throw e;
  process.exitCode = e.code;
}
