// Layer 2 of docs/chat-e2e.md — the PRODUCTION relay, after every deploy, with nobody's phone.
//
//   node scripts/probe-prod.mjs [--relay https://can2cup.com] [--skip-loop] [--verbose]      (npm run probe:prod)
//
// What it proves, in order:
//   routes   every chat-app webhook route is up and verifying: an unsigned / wrong-secret POST gets that adapter's own
//            refusal (LINE 400, Discord 401, Telegram 401). Needs no secret.
//   secret   for each channel whose secret is on this machine (.env.telegram TELEGRAM_WEBHOOK_SECRET, .env.line
//            LINE_CHANNEL_SECRET): a forged `/help` from a synthetic, unbound id is accepted (200) — the deployed secret
//            is the one we hold. The bot's answer to that id fails at the chat app (no such user) and is a per-target
//            failure only, never channel-wide (bridge.ts noteHealth), so the real principal's health is untouched.
//   loop     the full path on the channel THIS machine's agent is bound to (`can2cup status`): a forged `/a probe …` as
//            the real principal (TELEGRAM_TEST_USER_ID / LINE_TEST_USER_ID) → `can2cup watch` on this machine reads it →
//            `can2cup tell` answers → the relay reports the channel DELIVERED with a timestamp after the probe began, i.e.
//            the chat app's API accepted the message. The phone receives two short lines (the receipt and the answer).
//   discord  Discord cannot be forged (its webhooks are signed by Discord's own key) — only the bot token is checked
//            (GET /users/@me) when .env.discord holds it. The inbound path is layer 3: one /status by hand.
// Exit 1 on any FAIL; a check that lacks its secret or binding prints `skip` and does not fail.
import { createHmac, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const RELAY = (argv.includes("--relay") ? argv[argv.indexOf("--relay") + 1] : "https://can2cup.com").replace(/\/+$/, "");
const VERBOSE = argv.includes("--verbose");
const SKIP_LOOP = argv.includes("--skip-loop");
const LOOP_TIMEOUT_MS = 90_000;
let fails = 0;
const say = (s) => console.log(s);
const ok = (m) => say(`ok   ${m}`);
const fail = (m) => { fails++; say(`FAIL ${m}`); };
const skip = (m) => say(`skip ${m}`);
const expect = (c, m) => (c ? ok(m) : fail(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The chat-app secret files are not in this repo and never should be. CAN2CUP_ENV_DIR names the directory that
// holds them; unset, they are looked for here, which is what a fresh clone expects.
const ENV_DIR = (process.env.CAN2CUP_ENV_DIR ?? ".").replace(/[\\/]+$/, "");
function envFile(name) {
  const file = `${ENV_DIR}/${name}`;
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const tg = envFile(".env.telegram");
const line = envFile(".env.line");
const dc = envFile(".env.discord");
// The INSTALLED client (its state dir is this machine's real one), run through node directly so no shell touches the
// arguments. --cli overrides the entry (e.g. dist/cli/index.js to probe with the working tree's build).
function cliEntry() {
  if (argv.includes("--cli")) return argv[argv.indexOf("--cli") + 1];
  const root = spawnSync(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/c", "npm", "root", "-g"] : ["root", "-g"], { encoding: "utf8" }).stdout?.trim();
  const entry = root && `${root}/can2cup/dist/cli/index.js`;
  if (!entry || !fs.existsSync(entry)) { console.error(`cannot find the installed can2cup client (npm root -g → ${root || "?"}); pass --cli <path to dist/cli/index.js>`); process.exit(2); }
  return entry;
}
const CLI = cliEntry();
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

async function post(path, body, headers = {}) {
  const r = await fetch(`${RELAY}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const text = await r.text();
  if (VERBOSE) say(`     ${path} → ${r.status} ${text.slice(0, 160)}`);
  return { status: r.status, text };
}

// ---- forged people ----
const tgUpdate = (text, userId, chatId = userId) => {
  const id = 2_000_000_000 + Math.floor(Math.random() * 100_000_000); // far above Telegram's real sequence
  return JSON.stringify({ update_id: id, message: { message_id: id % 100000, from: { id: userId, is_bot: false, language_code: "zh-hant" }, chat: chatId === userId ? { id: chatId, type: "private" } : { id: chatId, type: "supergroup", title: "probe" }, date: Math.floor(Date.now() / 1000), text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : [] } });
};
const lineBody = (text, userId) => JSON.stringify({ destination: "Uprobe", events: [{ type: "message", webhookEventId: "01" + randomBytes(8).toString("hex").toUpperCase(), deliveryContext: { isRedelivery: false }, timestamp: Date.now(), mode: "active", replyToken: randomBytes(16).toString("hex"), source: { type: "user", userId }, message: { id: String(Date.now()), type: "text", text } }] });
const lineSig = (body) => createHmac("sha256", line.LINE_CHANNEL_SECRET).update(body).digest("base64");
const forgeTelegram = (text, userId, chatId) => post("/telegram/webhook", tgUpdate(text, userId, chatId), { "x-telegram-bot-api-secret-token": tg.TELEGRAM_WEBHOOK_SECRET });
const forgeLine = (text, userId) => { const b = lineBody(text, userId); return post("/line/webhook", b, { "x-line-signature": lineSig(b) }); };

say(`probing ${RELAY}`);
const health = await fetch(`${RELAY}/`).then((r) => r.json()).catch(() => null);
if (!health?.pub) { fail(`GET / did not answer with the relay's signing key`); say(`\n${fails} failed`); process.exit(1); }
ok(`relay answers: canonical ${health.canonical}, LINE ${health.lineOa ?? "-"}, Telegram @${health.telegramBot ?? "-"}, relay key ${health.pub.slice(0, 8)}`);

// ---- routes: up and verifying, no secret needed ----
let r = await post("/line/webhook", "{}");
expect(r.status === 400, `LINE webhook route refuses an unsigned body (400)`);
r = await post("/discord/interactions", JSON.stringify({ type: 1 }));
expect(r.status === 401, `Discord interactions route refuses an unsigned PING (401)`);
r = await post("/telegram/webhook", tgUpdate("/help", 1), { "x-telegram-bot-api-secret-token": "wrong-secret-of-a-plausible-length" });
expect(r.status === 401, `Telegram webhook route refuses a wrong secret (401)`);

// ---- secret: the deployed one is ours ----
if (tg.TELEGRAM_WEBHOOK_SECRET) {
  r = await forgeTelegram("/help", 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  expect(r.status === 200, `Telegram: a forged /help with our secret is accepted (200) — the deployed secret matches .env.telegram`);
} else skip("Telegram secret check (.env.telegram TELEGRAM_WEBHOOK_SECRET missing)");
if (line.LINE_CHANNEL_SECRET) {
  r = await forgeLine("/help", "U" + randomBytes(16).toString("hex"));
  expect(r.status === 200, `LINE: a forged /help signed with our secret is accepted (200) — the deployed secret matches .env.line`);
} else skip("LINE secret check (.env.line LINE_CHANNEL_SECRET missing — copy the channel secret from LINE Developers into it)");

// ---- discord: token only ----
if (dc.DISCORD_BOT_TOKEN) {
  const me = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bot ${dc.DISCORD_BOT_TOKEN}` } });
  const j = await me.json().catch(() => ({}));
  expect(me.status === 200 && j.bot, `Discord bot token valid (${j.username ?? me.status}); inbound cannot be forged — one /status by hand after a Discord adapter change`);
} else skip("Discord token check (.env.discord DISCORD_BOT_TOKEN missing)");

// ---- loop: forged /a as the real principal → this machine's watch → tell → delivered ----
if (SKIP_LOOP) skip("full loop (--skip-loop)");
else {
  const status = cli("status");
  const st = (status.stdout ?? "") + (status.stderr ?? "");
  const bound = /5\. (LINE|Discord|Telegram) linked\s+\(yes/.exec(st)?.[1];
  const onDuty = /✅ 8\. on duty/.test(st);
  if (!bound) skip("full loop: this machine's agent is not linked to any chat app (can2cup status)");
  else if (onDuty) skip(`full loop: a \`can2cup watch\` is already on duty on this machine and would take the probe first — stop it, or run with --skip-loop`);
  else {
    const nonce = randomBytes(3).toString("hex");
    const probeText = `/a probe ${nonce}(自動探針,不用理)`;
    let forged = null;
    if (bound === "Telegram") {
      const uid = Number(tg.TELEGRAM_TEST_USER_ID);
      if (!tg.TELEGRAM_WEBHOOK_SECRET || !Number.isSafeInteger(uid)) skip("full loop: .env.telegram needs TELEGRAM_WEBHOOK_SECRET and TELEGRAM_TEST_USER_ID (the principal's own Telegram id)");
      else forged = await forgeTelegram(probeText, uid);
    } else if (bound === "LINE") {
      if (!line.LINE_CHANNEL_SECRET || !line.LINE_TEST_USER_ID) skip("full loop: .env.line needs LINE_CHANNEL_SECRET and LINE_TEST_USER_ID (the principal's own LINE userId)");
      else forged = await forgeLine(probeText, line.LINE_TEST_USER_ID);
    } else skip(`full loop: bound to ${bound}, which cannot be forged`);
    if (forged) {
      const started = Date.now();
      expect(forged.status === 200, `${bound}: forged "/a probe ${nonce}" as the principal accepted (200)`);
      // this machine's own watch reads the inbox, exactly as duty would
      let seen = false, out = "";
      while (!seen && Date.now() - started < LOOP_TIMEOUT_MS) {
        out = await new Promise((resolve) => {
          const p = spawn(process.execPath, [CLI, "watch", "--interval", "2"], { stdio: ["ignore", "pipe", "pipe"] });
          let buf = "";
          p.stdout.on("data", (d) => { buf += d; });
          p.stderr.on("data", (d) => { if (VERBOSE) process.stderr.write(d); });
          const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, Math.max(1000, LOOP_TIMEOUT_MS - (Date.now() - started)));
          p.on("close", () => { clearTimeout(t); resolve(buf); });
        });
        if (VERBOSE && out.trim()) say(`     watch → ${JSON.stringify(out).slice(0, 300)}`);
        seen = out.includes(`probe ${nonce}`);
        if (!seen && !out.trim()) break; // killed on timeout with nothing to show
      }
      expect(seen, `…\`can2cup watch\` on this machine picked it up (${Math.round((Date.now() - started) / 1000)} s)`);
      if (seen) {
        const tell = cli("tell", `probe ${nonce} ok — 自動探針,relay 到 ${bound} 的路是通的`);
        const t = (tell.stdout ?? "") + (tell.stderr ?? "");
        if (VERBOSE) say(`     tell → ${JSON.stringify(t).slice(0, 300)}`);
        expect(/^queued for your principal's/m.test(t), `…\`can2cup tell\` answered: the relay queued the reply for ${bound}`);
        if (/REFUSING|NOT DELIVERED/.test(t)) fail(`the relay says the ${bound} channel is refusing pushes: ${t.trim().split("\n").pop()}`);
        // The push leaves the relay a moment later (an alarm), so the health line on the tell itself still shows the
        // PREVIOUS delivery. Ask again until "last delivered" is after the probe began — that is the chat app's API
        // saying yes to this very message.
        const HEALTH = /principal channel: (\w+) ok \(last delivered ([^)]+)\)/;
        let health = null;
        for (let i = 0; i < 20 && !health; i++) {
          await sleep(1500);
          const who = cli("whoami"); const w = (who.stdout ?? "") + (who.stderr ?? "");
          const m = HEALTH.exec(w);
          if (m && Date.parse(m[2]) >= started - 2000) health = m;
          if (/REFUSING/.test(w)) { fail(`the relay now says the ${bound} channel is REFUSING: ${w.split("\n").find((l) => /REFUSING/.test(l))}`); break; }
        }
        expect(health, `…and the relay reports ${bound} DELIVERED at ${health?.[2] ?? "(no delivery after " + new Date(started).toISOString() + ")"} — the chat app's API accepted this message (can2cup whoami)`);
      }
    }
  }
}

say(`\n${fails ? `${fails} failed` : "all passed"}`);
process.exit(fails ? 1 : 0);
