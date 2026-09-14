// v0.12.1 — configure the Discord app from here instead of clicking through the Developer Portal.
//   node scripts/discord-app.mjs show                    what Discord currently holds for the app
//   node scripts/discord-app.mjs app --relay https://<relay>   interactions endpoint, install contexts, description, ToS/privacy
//   node scripts/discord-app.mjs commands                 (re)register the global slash commands — the console's command set
// Reads DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN from .env.discord — never in this repo. CAN2CUP_ENV_DIR names
// the directory that holds it; DISCORD_ENV_FILE overrides the whole path.
// `app` makes Discord validate the endpoint on the spot (a PING and a bad-signature probe), so deploy the Worker with
// DISCORD_PUBLIC_KEY first. `app` has no default relay: --relay is the deployment the app is pointed at.
import fs from "node:fs";

const args = process.argv.slice(2);
const what = args[0] ?? "show";
const relayArg = args.includes("--relay") ? args[args.indexOf("--relay") + 1] : undefined;
if (what === "app" && (!relayArg || !/^https?:\/\//.test(relayArg))) { console.error("usage: node scripts/discord-app.mjs app --relay https://<relay>\n--relay is required: the relay whose /discord/interactions the app should call"); process.exit(2); }
const relay = (relayArg ?? "").replace(/\/+$/, "");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repoUrl = ((typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ?? "").replace(/^git\+/, "").replace(/\.git$/, "");

const envFile = process.env.DISCORD_ENV_FILE ?? `${(process.env.CAN2CUP_ENV_DIR ?? ".").replace(/[\\/]+$/, "")}/.env.discord`;
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const APP = env.DISCORD_APPLICATION_ID, TOKEN = env.DISCORD_BOT_TOKEN;
if (!APP || !TOKEN) { console.error(`${envFile}: DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN required`); process.exit(2); }

async function api(path, body, method = body ? "PATCH" : "GET") {
  // Discord's required form: "DiscordBot ($url, $versionNumber)"
  const r = await fetch(`https://discord.com/api/v10${path}`, { method, headers: { authorization: `Bot ${TOKEN}`, "content-type": "application/json", "user-agent": `DiscordBot (${repoUrl}, ${pkg.version})` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) { console.error(`${method} ${path} → ${r.status}\n${JSON.stringify(json, null, 2)}`); process.exit(1); }
  return json;
}

// VIEW_CHANNEL 1024 + SEND_MESSAGES 2048 + EMBED_LINKS 16384 + ATTACH_FILES 32768 + READ_MESSAGE_HISTORY 65536
const PERMISSIONS = "117760";
const zh = (s) => ({ "zh-TW": s });
const text = (desc, zhDesc, required = false, name = "text") => ({ type: 3, name, description: desc, description_localizations: zh(zhDesc), required, max_length: 1900 });
const onoff = (desc, zhDesc) => ({ type: 3, name: "mode", description: desc, description_localizations: zh(zhDesc), required: true, choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }] });
const C = (name, desc, zhDesc, options) => ({ name, type: 1, description: desc, description_localizations: zh(zhDesc), ...(options ? { options } : {}), integration_types: [0, 1], contexts: [0, 1, 2] });
// v0.15.0: the command set comes from src/relay/commands.ts (built into dist/ — run `npm run build` first); this file
// only turns it into Discord's shape. bot.ts reads the same table, so the two can no longer drift.
const { PUBLIC_COMMANDS } = await import("../dist/relay/commands.js");
const argOf = (a) => a.kind === "onoff" ? onoff(a.en, a.zh) : text(a.en, a.zh, !!a.required, a.name ?? "text");
const COMMANDS = PUBLIC_COMMANDS.map((c) => C(c.name, c.en, c.zh, c.arg ? [argOf(c.arg)] : undefined));

if (what === "show") {
  const a = await api("/applications/@me");
  const keep = ["id", "name", "description", "tags", "interactions_endpoint_url", "integration_types_config", "install_params", "flags", "terms_of_service_url", "privacy_policy_url", "bot_public", "approximate_guild_count", "approximate_user_install_count", "verify_key"];
  console.log(JSON.stringify(Object.fromEntries(keep.filter((k) => k in a).map((k) => [k, a[k]])), null, 2));
  const cmds = await api(`/applications/${APP}/commands`);
  console.log(`\n${cmds.length} global commands: ${cmds.map((c) => "/" + c.name).join(" ")}`);
} else if (what === "app") {
  const body = {
    description: "傳聲罐罐 can2cup — drive the AI agent on your own computer from Discord, and let it talk to other people's agents in signed rooms, with your brake. 用 Discord 遙控你電腦上的 AI agent,讓它跟別人的 agent 在有簽章的對話裡談事情,你隨時能煞車。",
    tags: ["ai", "agent", "mcp", "claude", "automation"],
    interactions_endpoint_url: `${relay}/discord/interactions`,
    integration_types_config: {
      0: { oauth2_install_params: { scopes: ["applications.commands", "bot"], permissions: PERMISSIONS } },
      // permissions must be an explicit "0": omitted, Discord stores the string "None" and the client's authorize page crashes
      1: { oauth2_install_params: { scopes: ["applications.commands"], permissions: "0" } },
    },
    install_params: { scopes: ["applications.commands", "bot"], permissions: PERMISSIONS },
    terms_of_service_url: `${relay}/terms`,
    privacy_policy_url: `${relay}/privacy/`,
  };
  const a = await api("/applications/@me", body);
  console.log(`ok: endpoint ${a.interactions_endpoint_url}
install (own account, DMs): https://discord.com/oauth2/authorize?client_id=${APP}&integration_type=1&scope=applications.commands
install (into a server):    https://discord.com/oauth2/authorize?client_id=${APP}&integration_type=0&scope=bot+applications.commands&permissions=${PERMISSIONS}`);
} else if (what === "commands") {
  const out = await api(`/applications/${APP}/commands`, COMMANDS, "PUT");
  console.log(`ok: ${out.length} global commands registered: ${out.map((c) => "/" + c.name).join(" ")}`);
} else { console.error("usage: node scripts/discord-app.mjs show | app --relay https://<relay> | commands"); process.exit(2); }
