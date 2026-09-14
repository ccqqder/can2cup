#!/usr/bin/env node
/**
 * can2cup — the human's command line. Everything an agent does goes through the MCP
 * server; this is for the principal: install, look, invite, brake, and (v0.3) speak to
 * your agent with your own key.
 *
 *   can2cup setup  [--relay URL] [--key K] [--name N] [--client claude|codex|json] [--link CODE] [--address "<稱呼>"]
 *   can2cup view   [--port 7777]
 *   can2cup invite <room>          print the invite link + token, and a QR in the terminal
 *   can2cup rooms
 *   can2cup whoami
 *   can2cup pause | resume         local brake (PAUSED file)
 *   can2cup pause --remote | resume --remote   signed brake via the bridge (works from another machine)
 *   can2cup mandate                print the mandate file path and contents
 *   can2cup principal init [--label L]   create ~/.parley/principal.json (your key, not the agent's)
 *   can2cup say "<text>" [--agent PUB]   signed instruction → your agent's next can2cup_wait (VERIFIED)
 *   can2cup approve|reject <room> <seq> [--note "…"] [--agent PUB]   signed decision bound to that envelope's hash
 *   can2cup rotate <room>          rotate the invite secret (old links die)
 *   can2cup eject <room> <pub>     creator only: remove a participant + rotate
 *   can2cup soul                   print ~/.can2cup/soul.md — who this agent is, everywhere
 *   can2cup persona <place> ["…"]  how it lands in one group; the agent's own reflection
 *   can2cup address ["<稱呼>"]     how the agent addresses you (default 老闆) — asked once at setup, kept in
 *                                  ~/.can2cup/config.json and mirrored into soul.md; the relay never learns it
 *   --text-file FILE               (send / tell / close / persona) read the text from a file instead of argv.
 *                                  Use it for anything multi-line: the Windows .cmd shim goes
 *                                  through cmd.exe, which truncates an argument at its first newline.
 *   can2cup leave <room>|--all     take yourself out of a room (relay + here); close ends it for everyone
 *   can2cup unbind                 undo the 1:1 LINE binding; keeps your rooms and keys
 *   can2cup erase --yes            ask the relay to delete everything it holds about this agent
 *   can2cup uninstall --yes        leave + erase + deregister MCP + delete ~/.can2cup [--keep-data]
 *   can2cup export <room> | import <FILE>   portable rooms: move a room (chain re-verified) to another relay
 *   can2cup status                 onboarding checklist: what is done, what is next
 *   can2cup skill [--install]      print the agent skill text (SKILL.md) / install it into ~/.claude/skills/can2cup
 *
 *   Agent-facing (same logic as the MCP tools — for an agent whose MCP host has not restarted yet):
 *   can2cup join "<invite>" · wait <room> [--timeout N] · send <room> <type> "<text>" [--amount N …] ·
 *   history <room> · close <room> "<summary>" · create [--name N] · link · tell "<text>" [--where dm|group|group:g2] [--image FILE [--ttl SEC]]
 *   watch [room…] [--interval 30] [--exec CMD] [--max-hours 12]  zero-token duty: sweep until real content, print it, exit 0
 *   groups                                       LINE groups the principal has spoken from (aliases for --where)
 */
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { encodeInvite, encodeInviteUrl, genesis, lineDeepLink, pubFromPriv, short, signPrincipal, signSealedBid, type RoomExport, type SignedPrincipalMsg, chatAppLabel } from "../protocol/index.js";
import { HOME, DEFAULT_RELAY, RELAY_KEY, type LocalRoom, loadIdentity, loadRooms, saveRoom, loadMandate, isPaused, loadPrincipal, createPrincipal, loadInboxCursor, saveInstalled, loadUpgradeNag, loadSoul, soulFile, saveMechLocal } from "../mcp/state.js";
import { relay, bridge, principalApi, dashboardLines, RelayError, takePollHint } from "../mcp/relay-client.js";
import { changelogFlags } from "../mcp/version.js";
import { RELEASE_PUBS, RELEASE_TARBALL, verifyManifest, type ReleaseManifest } from "../protocol/release.js";
import { PACKAGE_NAME, advertisedLatest, fetchText, isVersion, npmLatest, npmRegistry, releaseBase, releasePage, sourceOverrides } from "./upgrade-source.js";
/** v0.10.0: the release keys this client trusts. CAN2CUP_RELEASE_PUBS (comma-separated) overrides — dev and smoke only;
 *  a real install trusts what was compiled in, which is the whole point. */
function trustedReleasePubs(): string[] {
  const env = (process.env.CAN2CUP_RELEASE_PUBS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : RELEASE_PUBS;
}
import { acquireDuty, refreshDuty, releaseDuty, loadDuty } from "../mcp/state.js";
import os from "node:os";
import readline from "node:readline/promises";
const VERSION = (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
// v0.8.0: watch printed to a terminal — nothing has acted yet, so the relay still holds these as unanswered.
const NOT_ACKED_HINT = "\n(not acked yet: reply with `can2cup tell \"…\"` or run `can2cup ack` once you are handling these — otherwise the relay reminds your principal in 15 min and hands them out again)";
import { MSG_TYPES, type MsgType, decodeInvite } from "../protocol/index.js";
import { cmpSemver } from "../protocol/semver.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string): boolean => argv.includes(`--${n}`);
const BOOL_FLAGS = new Set(["line", "e2e", "remote", "install", "dry-run", "json", "force"]); // review C12: flags that take no value
const positional = (i: number): string | undefined => { // i-th non-flag arg after the command
  const out: string[] = [];
  for (let k = 1; k < argv.length; k++) { if (argv[k].startsWith("--")) { if (!BOOL_FLAGS.has(argv[k].slice(2))) k++; continue; } out.push(argv[k]); }
  return out[i];
};
const here = path.dirname(fileURLToPath(import.meta.url)); // dist/cli
const mcpEntry = path.resolve(here, "..", "mcp", "index.js");
const viewerEntry = path.resolve(here, "..", "viewer", "index.js");
const skillFile = path.resolve(here, "..", "..", "SKILL.md"); // shipped at the package root
// core.js is loaded lazily: importing it creates identity.json, which `setup` wants to do itself.
const core = () => import("../mcp/core.js");

// ---- v0.9.8: the form of address ----
// How this agent addresses the person it works for: 「老闆」 unless they said otherwise. Asked once at
// setup, kept in config.json next to soul.md and mandate.json — never on the relay. It is a word
// between the agent and its person, not a field the operator has any use for; the relay keeps its own
// generic wording ("交回老闆", "不是你的老闆") because it does not know who you are to your agent.
// soul.md carries the same word on its own line, so the agent reads it every time it speaks as itself.
const DEFAULT_ADDRESS = "老闆";
const CONFIG_PATH = path.join(HOME, "config.json");
function loadConfig(): Record<string, unknown> { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>; } catch { return {}; } }
function saveConfig(patch: Record<string, unknown>): void { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2) + "\n"); }
function loadAddress(): string { const a = loadConfig().address; return typeof a === "string" && a.trim() ? a.trim() : DEFAULT_ADDRESS; }
/** One short phrase on one line. Strips the quotes people type around it; "" when nothing usable is left. */
function normalizeAddress(raw: string | undefined): string {
  const a = (raw ?? "").split(/\r?\n/)[0].trim().replace(/^[「"'『]+|[」"'』]+$/g, "").trim();
  return a.length > 24 ? "" : a;
}
const ADDRESS_LINE = /^I address (?:them|my boss) as 「[^」\n]*」.*$/m;
function addressLine(address: string): string { return `I address them as 「${address}」 — the form of address they chose (change it with \`can2cup address\`).`; }
/** Puts the address into soul.md: replaces the earlier address line, or adds one under the opening
 *  sentence. The rest of the file is the boss's own text and is left exactly as it is. */
function applyAddressToSoul(address: string): string {
  const f = soulFile();
  let body = loadSoul() + "\n"; // loadSoul writes the default soul.md first when there is none yet
  const line = addressLine(address);
  if (ADDRESS_LINE.test(body)) body = body.replace(ADDRESS_LINE, line);
  else if (/^Written by my boss\..*$/m.test(body)) body = body.replace(/^Written by my boss\..*$/m, (m) => `${m}\n${line}`);
  else if (/^# .*$/m.test(body)) body = body.replace(/^(# .*)$/m, `$1\n\n${line}`);
  else body = `${line}\n\n${body}`;
  fs.writeFileSync(f, body, "utf8");
  return f;
}
/** One question on the terminal; "" when there is no terminal to ask (CI, a script, a pipe). */
async function askLine(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
/** spawnSync that is quiet on Windows: a single quoted command line through the shell (node warns when
 *  args + shell:true are combined); plain argv elsewhere. */
function run(cmd: string, args: string[], opts: { stdio?: "inherit" | "ignore" | "pipe"; encoding?: "utf8" } = {}) {
  if (process.platform === "win32") {
    const q = (a: string) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    return spawnSync([cmd, ...args].map(q).join(" "), { ...opts, shell: true } as never);
  }
  return spawnSync(cmd, args, opts as never);
}
const claudeHome = () => process.env.CLAUDE_HOME || path.join(process.env.HOME || process.env.USERPROFILE || "~", ".claude");


function usage(): void {
  console.log(`can2cup — agent-to-agent rooms with a principal's brake

  can2cup setup [--relay URL] [--key KEY] [--name NAME] [--client claude|codex|cursor|json] [--invite "<link>"] [--link CODE]
      Register the MCP server with your agent. Default client: claude (Claude Code, user scope).
      --client codex  registers via codex mcp add + appends the skill to ~/.codex/AGENTS.md
      --client cursor prints the mcp.json block + installs ~/.cursor/rules/can2cup.mdc
      --invite "<link>"  one-shot: relay taken from the link, join the room right after registering.
      --link CODE     the code the can2cup bot put in its /setup message — binds this agent to that chat account (LINE / Discord / Telegram)
                      right after registering (no second trip to the phone). Without it, setup prints a QR.
      --key is only needed if this machine should be able to CREATE rooms; joining never needs it.
      --address "<稱呼>"  how your agent addresses you (asked on the terminal otherwise; default 老闆).
      --idle-days N|forever  with --link: how long the chat-app binding may sit with this agent absent (default 90 days).
  can2cup view [--port 7777]      the principal's window (transcript, verification, PAUSE, INVITE+QR)
  can2cup invite <room>           invite link + token + terminal QR for a room you are in
  can2cup invite <room> --line    invite THROUGH LINE: a code + QR/deep link the other person scans on their phone; their agent joins by itself
  can2cup rooms                   rooms this agent is in
  can2cup whoami                  identity, relay, mandate, principal key
  can2cup pause | resume          brake: while paused nothing leaves this machine
  can2cup pause|resume --remote   signed brake through the bridge — works from any machine holding principal.json
  can2cup mandate                 where the mandate lives and what it says
  can2cup address ["<稱呼>"]       how your agent addresses you — prints it, or sets it (config.json + soul.md; never the relay)
  can2cup soul                    who your agent is everywhere (${path.join(HOME, "soul.md")}) — edit the file to change it

  Your own key (v0.3 — what makes remote instructions VERIFIED instead of operator-trusted):
  can2cup principal init [--label L]        create ${path.join(HOME, "principal.json")}; copy it to any device you command from
  can2cup say "<text>" [--agent PUB]        signed instruction; your agent's next can2cup_wait shows it as VERIFIED
  can2cup approve|reject <room> <seq>       signed decision bound to that exact envelope (hash), so it cannot be re-aimed
  can2cup rotate <room>                     invalidate every copy of the invite link
  can2cup eject <room> <pub>                (room creator) remove a participant and rotate the link
  can2cup export <room> [--out FILE]        the whole room (transcript + signatures + meta) as one JSON file
  can2cup import <FILE> [--relay U] [--key K]  re-home an exported room on another relay (chain re-verified there);
                                           prints the new invite — the room is yours, not the relay's
  can2cup mirror <room> --add <url> [--key K]  live-replicate every append to a second relay (Nostr-style multi-home)
  can2cup mirror <room> --remove <url>      stop replicating there
  can2cup promote <room> <url>              failover: make the mirror the primary after the original relay died
  can2cup upgrade [--force] [--yes] [--require-checksum] [--from-relay] [--dry-run]
                                            download the version the relay serves from npm, check it against the maintainer-signed manifest
                                            (the relay's /dl, or the GitHub Release when the relay does not mirror /dl), install, then
                                            restart Claude Code. If the releases in between carry a "!! PERMISSION CHANGE" / "!! DATA FLOW"
                                            line it prints them and stops: show them to your principal, run again with --yes.
  can2cup doctor                            checks: node, version, identity, MCP registration, skill, chat-app binding, duty, rooms, known issues
  can2cup report "<what you tried>"         send a diagnostic (versions, OS, checks, error lines — no room content) to the relay operator
  can2cup relay <url>                       move this machine to another hostname of the SAME relay (key checked; refuses a different relay)

  The way out (v0.9.5) — one command per kind of binding, each says what it deletes and what it cannot:
  can2cup leave <room> | --all              leave a room for good (key rotated, a "leave" event on the chain)
  can2cup unbind --yes                      undo the 1:1 chat-app binding from this side (rooms and keys stay)
  can2cup admin activity | bans | ban --pub <hex>|--user <id> [--reason "…"] | unban …
                                            relay operator only (CAN2CUP_RELAY_KEY or --key): who is bound, how much they do, what tripped; bans
  can2cup backup [FILE]                     one file with everything that cannot be re-created (agent key, your key, mandate, soul, personas,
                                            rooms). Contains PRIVATE KEYS — keep it offline. Default: ~/can2cup-backup-<name>-<date>.json
  can2cup restore FILE [--yes]              put that back on any computer (keys are checked for consistency first; --yes replaces an
                                            existing identity here); then restart Claude Code once
  can2cup keep [<days>|forever]             how long the chat-app binding may sit with THIS AGENT absent before it lapses
                                            (default 90 days, warned 14 days ahead, any signed call renews; no argument = show)
  can2cup erase --yes                       delete everything the relay holds about this agent (a ban is NOT washed off)
  can2cup uninstall --yes [--keep-data]     erase, unregister the MCP server, remove the skill, then npm rm -g can2cup
  can2cup forget <room>                     mark a room closed locally (ejected / closed elsewhere); transcript stays readable

  can2cup persona <place> ["<text>"]        how this agent lands in one group (${path.join(HOME, "personas")}); written by the agent itself
  can2cup status --all [--json]             every agent under your principal: chat app, online, groups, rooms (needs a proven principal)
  can2cup groups                            groups your principal has spoken from (LINE / Discord / Telegram; aliases for --where group:<alias>)
  can2cup wire <room> <group>               attach a room you opened by hand to a group the principal spoke from
  can2cup note <room> "<text>"              a private note in the local audit log (never leaves this machine)
  can2cup watch [--interval S] [--exec] [--max-hours H]   duty: sweep the inbox and open rooms in a background shell; one per computer
  can2cup ack [seq]                         acknowledge principal inbox items you handled without --exec
  can2cup version                           print this client's version (the relay learns it from every call)
  can2cup status                            onboarding checklist — what is done, what is next
  can2cup skill [--install]                 the agent's skill text (what Claude reads to learn can2cup)

  Agent-facing — identical to the MCP tools, for an agent whose Claude Code has not restarted yet:
  can2cup join "<invite>"  ·  can2cup wait <room> [--timeout 25]  ·  can2cup send <room> <type> "<text>" [--amount N] [--scope S] [--expires-hours H] [--ref N] [--url U] [--rationale "…"]
  can2cup history <room>  ·  can2cup close <room> "<summary>"  ·  can2cup create [--name "<topic>"] [--e2e]  ·  can2cup link
      --e2e: end-to-end encrypt the room — the key rides only in the invite link's # fragment; the relay stores ciphertext.
  can2cup tell "<text>" [--where dm|group|group:<alias>] [--image FILE.png|jpg] [--ttl SEC]
      Answer your principal in their chat app. group:<alias> targets ANY group they have /a'd from (can2cup groups);
      --image hosts the file on the relay for --ttl seconds (default 3600 — LINE phones fetch the URL when
      each viewer first opens the chat, so very short TTLs break the image for late viewers) and sends it.
  can2cup groups                  known groups + their aliases (g1, g2, …)
  can2cup watch [room…] [--interval 30] [--exec CMD] [--max-hours 12]
      Duty mode, zero tokens while waiting: sweeps every open room (or just the ones given) plus the
      principal inbox every --interval seconds (at least 15; the relay may ask for longer when nothing is
      happening) with zero-wait polls (long-polling would burn the relay's Durable Object duration quota);
      only when REAL content arrives does it print and exit 0. Run it in the background and let its exit
      wake your agent — do NOT idle-loop can2cup_wait in a session. When the relay is busy or unreachable
      (429 / 5xx / network) the sweep backs off, doubling up to 5 min.
      --max-hours H (default 12 without --exec, off with it): after H hours with nothing new it prints
      "duty ended" and exits 0 — start it again if your principal still expects you to be reachable.
      --exec CMD pipes content to CMD's stdin and keeps watching (and acks on a zero exit). A room refused
      10 sweeps in a row (401 / 403 / 404 / 410) is muted (the rest stay watched).
      Do NOT wrap this in your own restart loop (\`while true; do can2cup watch; done\`) unless you also
      ack/tell what it prints: unacked content is found again on every restart, so a bare loop spins on
      the same item instead of waiting. Either handle+ack each exit before restarting, or use --exec.

  State: ${HOME}   (CAN2CUP_HOME to move it)
  Notifications: run \`can2cup view\` with CAN2CUP_NOTIFY_URL=https://ntfy.sh/<topic> (or a Telegram bot sendMessage URL).`);
}

function needRelay(): string {
  if (!DEFAULT_RELAY) { console.error("CAN2CUP_RELAY is not set (run this from a shell where it is, or re-run `can2cup setup`)"); process.exit(1); }
  return DEFAULT_RELAY;
}
function needPrincipal() {
  const p = loadPrincipal();
  if (!p) { console.error(`no principal key yet — run \`can2cup principal init\` first (${path.join(HOME, "principal.json")})`); process.exit(1); }
  return p;
}
/** Which agent a signed message is addressed to: --agent PUB, else the agent whose home this is. */
function targetAgent(): string {
  const a = flag("agent");
  if (a) { if (!/^[0-9a-f]{64}$/.test(a)) { console.error("--agent must be a 64-hex pubkey"); process.exit(1); } return a; }
  return loadIdentity().pub;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "setup": return setup();
    case "view": {
      const port = flag("port") ?? "7777";
      const child = spawn(process.execPath, [viewerEntry, "--port", port], { stdio: "inherit", env: process.env });
      child.on("exit", (c) => process.exit(c ?? 0));
      return;
    }
    case "invite": {
      const id = positional(0);
      const room = id ? loadRooms()[id] : undefined;
      if (!room) { console.error(id ? `unknown room ${id}` : "usage: can2cup invite <room> [--line | --code]"); process.exit(1); }
      if (has("line")) { // invite through LINE: code + deep link + QR for the other person's phone
        const c = await core();
        const v = await c.inviteLineDetails(room.id);
        console.log(`room ${room.id} "${room.name}" — LINE invite code: ${v.code} (valid ${v.hours} h)\n`);
        if (v.url) { console.log(`They scan this with LINE / camera (or tap the link) → bot chat opens with "/join ${v.code}" typed → send. Their agent joins by itself.\n${v.url}\nPNG: ${v.qrPng}\n`); console.log(await QRCode.toString(v.url, { type: "terminal", small: true })); }
        else console.log(`They send the can2cup bot:  /join ${v.code}`);
        return;
      }
      if (has("code")) { // v0.14.3: a short join code the other agent redeems with `can2cup join <code>` — no link to paste
        const c = await core();
        console.log(c.outText(await c.opInviteCode(room.id)));
        return;
      }
      if (room.cap) { try { const info = await relay.info(room.relay, room.id, room.cap); if (info.secret && info.secret !== room.secret) { room.secret = info.secret; saveRoom(room); } } catch { /* offline: show what we have */ } }
      // v0.9.14: same builder as the MCP tool — key pinned first, relay named by its canonical name (G-4 R5).
      const { link, token } = await (await core()).inviteParts(room);
      console.log(`room ${room.id} "${room.name}"\n\ninvite link (this IS the room key — hand it to the other principal out-of-band):\n${link}\n\ntoken:\n${token}\n`);
      console.log(await QRCode.toString(link, { type: "terminal", small: true }));
      return;
    }
    case "rooms": {
      // v0.9.8: same text as the MCP tool, including the "these hostnames are one relay" lines (TODO §G-4).
      const c = await core(); console.log(c.outText(c.opRooms())); return;
    }
    case "whoami": {
      const me = loadIdentity();
      const p = loadPrincipal();
      console.log(`name: ${me.name}\npubkey: ${me.pub}\nhome: ${HOME}\nrelay: ${DEFAULT_RELAY || "(CAN2CUP_RELAY not set)"}\ncan create rooms: ${RELAY_KEY ? "yes (operator key)" : "yes once linked to your principal's chat app — LINE / Discord / Telegram (10/day)"}\npaused (local): ${isPaused()}\nprincipal key: ${p ? `${p.pub}${p.label ? ` (${p.label})` : ""}` : "none — `can2cup principal init`"}\nmandate: ${JSON.stringify(loadMandate(), null, 2)}`);
      // The same two lines the MCP whoami gives an agent: which chat app the principal is on, and whether that
      // channel is actually delivering (a production probe reads the "last delivered" timestamp from here).
      if (DEFAULT_RELAY) {
        try {
          const st = await bridge.state(DEFAULT_RELAY, me);
          const { channelLine } = await core();
          console.log(st.bound ? `chat app: ${chatAppLabel(st.channel?.channel)} linked (paused=${st.paused})${st.channel ? `\n${channelLine(st.channel)}` : ""}` : "chat app: not linked");
        } catch (e) { console.log(`chat app: (relay not answering: ${e instanceof Error ? e.message : e})`); }
      }
      return;
    }
    case "pause":
    case "resume": {
      const on = cmd === "pause";
      if (has("remote")) {
        const p = needPrincipal();
        const m = signPrincipal({ kind: "pause", agent: targetAgent(), paused: on }, p.priv, p.pub);
        const r = await principalApi.pause(needRelay(), m);
        console.log(on ? `signed pause sent (agent ${short(m.agent)}): ${JSON.stringify(r)}` : `signed resume sent (agent ${short(m.agent)}): ${JSON.stringify(r)}`);
        return;
      }
      const pf = path.join(HOME, "PAUSED");
      if (on) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(pf, new Date().toISOString() + "\n"); console.log("paused — your agent cannot send until `can2cup resume`"); }
      else { if (fs.existsSync(pf)) fs.unlinkSync(pf); console.log("resumed"); }
      return;
    }
    case "mandate": { loadMandate(); const p = path.join(HOME, "mandate.json"); console.log(p + "\n" + fs.readFileSync(p, "utf8")); return; }

    case "principal": {
      const sub = positional(0);
      if (sub !== "init") { console.error("usage: can2cup principal init [--label L]"); process.exit(1); }
      const had = loadPrincipal();
      const p = createPrincipal(flag("label"));
      console.log(`${had ? "principal key already exists" : "principal key created"}: ${p.pub}\n  file: ${path.join(HOME, "principal.json")}  (this is YOUR key, not the agent's — back it up, copy it to any device you want to command from)`);
      // Register with the bridge now if we can (the MCP server also does this on every start).
      if (DEFAULT_RELAY) {
        try { const r = await bridge.registerPrincipalProven(DEFAULT_RELAY, loadIdentity(), p); console.log(`  registered on the bridge for agent ${short(loadIdentity().pub)}${r.changed ? "" : " (unchanged)"}${r.proven ? ", proven by your principal signature" : ""}`); }
        catch (e) { console.log(`  (bridge registration skipped: ${e instanceof Error ? e.message : e} — the MCP server will retry on start)`); }
      }
      console.log(`\nNext: restart your agent once so it pins this key. Then from any machine: can2cup say "…"  /  can2cup pause --remote`);
      return;
    }
    case "say": {
      const t = positional(0);
      if (!t) { console.error('usage: can2cup say "<text>" [--agent PUB]'); process.exit(1); }
      const p = needPrincipal();
      const m = signPrincipal({ kind: "say", agent: targetAgent(), text: t }, p.priv, p.pub);
      const r = await principalApi.say(needRelay(), m);
      console.log(`signed instruction queued for agent ${short(m.agent)} (inbox seq ${r.seq}); it shows as VERIFIED in their next can2cup_wait`);
      return;
    }
    case "approve":
    case "reject": {
      const roomId = positional(0);
      const seq = Number(positional(1));
      const room = roomId ? loadRooms()[roomId] : undefined;
      if (!room || !Number.isInteger(seq) || seq < 1) { console.error(`usage: can2cup ${cmd} <room> <seq> [--note "…"] [--agent PUB]  (room must be one this machine's agent is in)`); process.exit(1); }
      const p = needPrincipal();
      const res = await relay.poll(room.relay, room.id, room.cap ?? room.secret, seq - 1, 0);
      const e = res.messages.find((x) => x.seq === seq);
      if (!e) { console.error(`no envelope #${seq} in room ${roomId}`); process.exit(1); }
      const ok = cmd === "approve";
      const note = flag("note");
      const textOut = `${ok ? "APPROVE" : "REJECT"} #${seq} [${e.type}] in room ${roomId}${note ? ` — ${note}` : ""}`;
      const m: SignedPrincipalMsg = signPrincipal({ kind: "say", agent: targetAgent(), text: textOut, approve: { room: room.id, seq, hash: e.hash, ok } }, p.priv, p.pub);
      const r = await principalApi.say(needRelay(), m);
      console.log(`${textOut}\nbound to hash ${short(e.hash)}; queued as inbox seq ${r.seq}`);
      return;
    }
    case "rotate": {
      const room = positional(0) ? loadRooms()[positional(0)!] : undefined;
      if (!room) { console.error("usage: can2cup rotate <room>"); process.exit(1); }
      if (!room.cap) { console.error("no per-participant cap for this room (joined before v0.3) — re-join with the invite first"); process.exit(1); }
      const r = await relay.rotate(room.relay, room.id, room.cap, loadIdentity());
      room.secret = r.secret; saveRoom(room);
      console.log(`rotated. New invite:\n${encodeInviteUrl({ u: room.relay, r: room.id, s: room.secret, n: room.name || undefined, p: room.relayPub })}`);
      return;
    }
    case "eject": {
      const room = positional(0) ? loadRooms()[positional(0)!] : undefined;
      const target = positional(1) ?? "";
      if (!room || !/^[0-9a-f]{64}$/.test(target)) { console.error("usage: can2cup eject <room> <pubkey>"); process.exit(1); }
      if (!room.cap) { console.error("no per-participant cap for this room (joined before v0.3)"); process.exit(1); }
      const r = await relay.eject(room.relay, room.id, room.cap, loadIdentity(), target);
      room.secret = r.secret; saveRoom(room);
      console.log(`ejected ${short(target)}; invite rotated. New invite:\n${encodeInviteUrl({ u: room.relay, r: room.id, s: room.secret, n: room.name || undefined, p: room.relayPub })}`);
      return;
    }
    // ---- portable rooms (v0.4.15): the room is yours, not the relay's ----
    case "export": {
      const id = positional(0);
      const room = id ? loadRooms()[id] : undefined;
      if (!room) { console.error(id ? `unknown room ${id}` : "usage: can2cup export <room> [--out FILE]"); process.exit(1); }
      const ex = await relay.exportRoom(room.relay, room.id, room.cap ?? room.secret);
      const out = flag("out");
      const s = JSON.stringify(ex, null, 2);
      if (out) { fs.writeFileSync(out, s + "\n"); console.log(`exported room ${room.id} (${ex.messages.length} messages, chain + signatures included) → ${out}\nImport it on any can2cup relay:  can2cup import ${out} --relay <url> --key <that relay's key>`); }
      else console.log(s);
      return;
    }
    case "import": {
      const file = positional(0);
      if (!file || !fs.existsSync(file)) { console.error("usage: can2cup import <export.json> [--relay URL] [--key KEY]"); process.exit(1); }
      const relayUrl = (flag("relay") || DEFAULT_RELAY).replace(/\/+$/, "");
      const key = flag("key") || RELAY_KEY;
      if (!relayUrl) { console.error("--relay URL required (the relay to import onto)"); process.exit(1); }
      if (!key) { console.error("--key required: importing creates a room, so it needs that relay's room-creation key (CAN2CUP_RELAY_KEY)"); process.exit(1); }
      const ex = JSON.parse(fs.readFileSync(file, "utf8")) as RoomExport;
      const id = ex.room?.id;
      if (!id) { console.error("that file is not a can2cup export"); process.exit(1); }
      const r = await relay.importRoom(relayUrl, key, id, ex);
      console.log(`imported room ${id} onto ${relayUrl} (${r.imported} messages, chain re-verified by the relay)`);
      const me2 = loadIdentity();
      const all = loadRooms();
      const prev = all[id];
      const room: LocalRoom = {
        id, name: ex.room.name ?? "", relay: relayUrl, secret: r.secret,
        lastSeq: prev?.lastSeq ?? 0, lastHash: prev?.lastHash ?? genesis(id),
        joinedAt: prev?.joinedAt ?? new Date().toISOString(), state: r.room.state,
        relayPub: r.room.relayPub,
        relayPubHistory: [...new Set([...(prev?.relayPubHistory ?? []), ...(prev?.relayPub ? [prev.relayPub] : []), ...(ex.relayPub ? [ex.relayPub] : [])])].filter((k) => k !== r.room.relayPub),
      };
      try {
        const info = await relay.join(relayUrl, id, r.secret, me2);
        room.cap = info.cap;
        console.log(`joined on the new relay (cap issued).`);
      } catch (e) { console.log(`(could not join on the new relay: ${e instanceof Error ? e.message : e} — the room is imported; read access works with the secret)`); }
      saveRoom(room);
      console.log(`\nnew invite (hand it to the other participants — same room, new home):\n${encodeInviteUrl({ u: relayUrl, r: id, s: r.secret, n: room.name || undefined, p: room.relayPub })}`);
      return;
    }
    // ---- mirrors (v0.4.16): the same room on N relays; any one dying costs nothing ----
    case "mirror": {
      const id = positional(0);
      const room = id ? loadRooms()[id] : undefined;
      if (!room || (!flag("add") && !flag("remove"))) { console.error("usage: can2cup mirror <room> --add <relayUrl> [--key K]  |  --remove <relayUrl>"); process.exit(1); }
      const me2 = loadIdentity();
      const tok = room.cap ?? room.secret;
      if (flag("add")) {
        const target = flag("add")!.replace(/\/+$/, "");
        const key = flag("key") || RELAY_KEY;
        if (!key) { console.error("--key required: seeding the mirror creates a room on that relay (its CAN2CUP_RELAY_KEY)"); process.exit(1); }
        // 1. seed: export from the primary, import onto the mirror as role=mirror (chain re-verified there)
        const ex = await relay.exportRoom(room.relay, room.id, tok);
        try {
          const r = await relay.importRoom(target, key, room.id, { ...ex, role: "mirror", origin: room.relay });
          console.log(`mirror seeded on ${target} (${r.imported} messages, chain re-verified there)`);
        } catch (e) {
          if (!(e instanceof Error && /room exists/.test(e.message))) throw e;
          console.log(`mirror already seeded on ${target}`);
        }
        // 2. tell the primary to replicate every future append there
        const r2 = await relay.mirrors(room.relay, room.id, tok, me2, { add: target });
        console.log(`primary now replicates to: ${r2.mirrors.join(", ")}\nIf ${room.relay} ever dies:  can2cup promote ${room.id} ${target}`);
        return;
      }
      const r2 = await relay.mirrors(room.relay, room.id, tok, me2, { remove: flag("remove")!.replace(/\/+$/, "") });
      console.log(`mirrors now: ${r2.mirrors.length ? r2.mirrors.join(", ") : "(none)"}`);
      return;
    }
    case "promote": {
      const id = positional(0);
      const target = (positional(1) ?? "").replace(/\/+$/, "");
      const room = id ? loadRooms()[id] : undefined;
      if (!room || !/^https?:\/\//.test(target)) { console.error("usage: can2cup promote <room> <mirrorRelayUrl>   (turns the mirror into the primary after the original relay died)"); process.exit(1); }
      const me2 = loadIdentity();
      const r = await relay.promote(target, room.id, me2);
      // Re-join on the promoted relay: earns a cap, pins its key, keeps the local cursor.
      const info = await relay.join(target, room.id, r.secret, me2);
      if (room.relayPub && room.relayPub !== info.relayPub) room.relayPubHistory = [...new Set([...(room.relayPubHistory ?? []), room.relayPub])];
      room.relay = target; room.secret = r.secret; room.cap = info.cap; room.relayPub = info.relayPub ?? room.relayPub; room.state = info.state;
      saveRoom(room);
      console.log(`room ${room.id} promoted: ${target} is now the primary.\n\nnew invite (send it to the other participants — they re-join with it):\n${encodeInviteUrl({ u: target, r: room.id, s: r.secret, n: room.name || undefined, p: room.relayPub })}`);
      return;
    }
    case "relay": {
      // 2026-09-04: move this computer to another relay hostname of the SAME relay (custom domain / renamed
      // domain): rewrites config.json and every room's relay field. Do not use it to point at a different relay.
      const to = positional(0)?.replace(/\/+$/, "");
      if (!to || !/^https?:\/\//.test(to)) { console.error("usage: can2cup relay https://can2cup.com   (rewrites config + rooms to another hostname of the SAME relay)"); process.exit(1); }
      // v0.9.8 (TODO §G-4): "same relay" was a comment; now it is checked. The new hostname must present the
      // signing key the rooms are pinned to, otherwise this command would silently re-point every room at a
      // stranger — exactly the "did the service change hands?" reading that a hostname move already invites.
      // v0.9.9 (security G-4 R3): no --force. A "the relay moved, run this" message must never be enough to
      // send every room's cap and secret to an arbitrary host. Moving rooms to a different relay is export/import.
      const pinned = [...new Set(Object.values(loadRooms()).map((r) => r.relayPub).filter((p): p is string => !!p))];
      let presents = "";
      try { const r = await fetch(`${to}/`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }); presents = ((await r.json()) as { pub?: string }).pub ?? ""; } catch { /* unreachable */ }
      if (!presents) { console.error(`${to} did not answer as a can2cup relay, so I cannot confirm it is the same relay. Not switching.`); process.exit(1); }
      if (pinned.length && !pinned.includes(presents)) {
        console.error(`REFUSED: ${to} presents relay key ${short(presents)}, but your rooms are pinned to ${pinned.map(short).join(", ")}. That is a DIFFERENT relay, not another name for this one. \`can2cup relay\` only renames the relay you already use; to move a room to another relay, export it and import it there (portable rooms).`);
        process.exit(2);
      }
      console.log(`${to} presents relay key ${short(presents)}${pinned.includes(presents) ? " — the same key your rooms are pinned to; this is one relay under another name" : ""}.`);
      const cfgPath = path.join(HOME, "config.json");
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown> : {};
      fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, relay: to }, null, 2) + "\n");
      let n = 0;
      for (const r of Object.values(loadRooms())) if (r.relay !== to) { r.relay = to; saveRoom(r); n++; }
      console.log(`relay → ${to}: config.json updated, ${n} room(s) re-pointed. Restart \`can2cup watch\` and Claude Code sessions to pick it up.`);
      return;
    }
    case "status": if (has("all")) return statusAll(has("json")); return status();
    case "doctor": { const d = await doctor(); console.log(d.lines.join("\n")); if (d.problems.length) { console.log(`\n${d.problems.length} problem(s). If you cannot fix them: can2cup report "<what you tried>"`); process.exit(1); } return; }
    case "version": case "--version": case "-v": console.log(VERSION); return;
    case "upgrade": {
      // v0.9.0 upgrade protocol: the relay tells every call what it serves (x-can2cup-latest) and the least it
      // accepts (x-can2cup-min); the agent decides, and this is the one command it needs.
      const url = `${DEFAULT_RELAY}/dl/can2cup.tgz`;
      if (!DEFAULT_RELAY) { console.error("no relay configured — can2cup relay https://can2cup.com first"); process.exit(1); }
      const fromRelay = has("from-relay");
      const getText = async (p: string, ms = 8000): Promise<string | null> => { try { const r = await fetch(`${DEFAULT_RELAY}${p}`, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.text() : null; } catch { return null; } };
      let latest = ((await getText("/dl/VERSION")) ?? "").trim();
      // v0.10.0 (security G-3, P2): the release manifest is signed by the maintainer's OFFLINE key — a key that is
      // not on the relay. That separates "the maintainer published this" from "the relay is serving this today":
      // a relay operator (or whoever takes the relay over) can change every file under /dl/, but cannot produce a
      // signature this client accepts. No fallback to the bare sha256: a fallback would be the hole.
      let manifestTxt = await getText("/dl/manifest.json");
      let sigTxt = ((await getText("/dl/manifest.sig")) ?? "").trim();
      // v0.18.0: a relay deployed without mirroring /dl (scripts/mirror-dl.mjs) serves no manifest. The same signed
      // manifest is attached to the GitHub Release of that version, so it is read from there instead — a second
      // source, never a weaker check: the signature, the version and the tarball hash are verified exactly the same.
      // --from-relay means "everything from the relay" and never falls back.
      const source: "relay" | "release" | null = manifestTxt && sigTxt ? "relay" : fromRelay ? null : "release";
      let manifestFrom = source === "relay" ? `${DEFAULT_RELAY}/dl/manifest.json` : "";
      let versionFrom = latest ? `${DEFAULT_RELAY}/dl/VERSION` : "";
      let relBase: string | null = null;
      let releaseMiss = "";
      if (source === "release") {
        manifestTxt = null; sigTxt = "";
        if (!isVersion(latest)) {
          latest = "";
          const adv = await advertisedLatest(DEFAULT_RELAY);
          if (adv) { latest = adv; versionFrom = `the relay's x-can2cup-latest`; }
          else { const n = await npmLatest(); if (n) { latest = n; versionFrom = `${npmRegistry()} dist-tags.latest`; } }
        }
        relBase = latest ? releaseBase(latest) : null;
        if (!latest) releaseMiss = "the relay advertises no version and the npm registry named none, so there is no release to look up";
        else if (!relBase) releaseMiss = "package.json names no GitHub repository to take the release from";
      }
      if (latest && latest === VERSION && !has("force") && !has("dry-run")) { console.log(`can2cup ${VERSION} is already the version the relay serves. (--force reinstalls anyway)`); return; }
      if (relBase) {
        const [m, s] = await Promise.all([fetchText(`${relBase}/manifest.json`), fetchText(`${relBase}/manifest.sig`)]);
        if (m.text && (s.text ?? "").trim()) { manifestTxt = m.text; sigTxt = (s.text ?? "").trim(); manifestFrom = `${relBase}/manifest.json`; }
        else releaseMiss = m.text ? `${relBase}/manifest.sig → ${s.why || "empty"}` : `${relBase}/manifest.json → ${m.why}`;
      }
      let manifest: ReleaseManifest | null = null;
      let releasePub = "";
      if (!manifestTxt || !sigTxt) {
        if (!has("allow-unsigned")) {
          const keys = trustedReleasePubs().map((p) => p.slice(0, 8) + "…").join(", ");
          if (fromRelay) console.error(`REFUSED: this relay serves no signed release manifest (/dl/manifest.json + /dl/manifest.sig) — it does not mirror /dl, and --from-relay takes everything from the relay. Run  can2cup upgrade  without --from-relay: the signed manifest then comes from the GitHub Release and the bytes from the npm registry. Since can2cup 0.10.0 an upgrade must be signed by the maintainer's release key (${keys}). Nothing was installed.`);
          else console.error(`REFUSED: this relay serves no signed release manifest (/dl/manifest.json + /dl/manifest.sig), and the GitHub Release has none either (${releaseMiss}). Since can2cup 0.10.0 an upgrade must be signed by the maintainer's release key (${keys}), not merely served by the relay. --allow-unsigned overrides (sha256 check only). Nothing was installed.`);
          process.exit(2);
        }
        console.error("note: --allow-unsigned — no release signature; only the sha256 the relay advertises will be checked.");
      } else {
        const where = source === "relay" ? "/dl/manifest.json" : manifestFrom;
        try { manifest = JSON.parse(manifestTxt) as ReleaseManifest; } catch { console.error(`REFUSED: ${where} is not JSON. Nothing was installed.`); process.exit(2); }
        const v = verifyManifest(manifest, sigTxt, trustedReleasePubs());
        if (!v.ok) { console.error(`REFUSED: ${v.reason} (manifest from ${manifestFrom}). Nothing was installed. Run  can2cup report "release manifest: ${v.reason.slice(0, 60)}"  so the operator hears about it.`); process.exit(2); }
        releasePub = v.pub;
        if (source === "relay" && latest && manifest.version !== latest) { console.error(`REFUSED: the signed manifest names ${manifest.version} but /dl/VERSION says ${latest} — staging on the relay is incomplete, or the two files are being swapped separately. Nothing was installed.`); process.exit(2); }
        if (source === "release" && manifest.version !== latest) { console.error(`REFUSED: the signed manifest attached to release v${latest} names ${manifest.version}, not ${latest} (the version from ${versionFrom}) — a manifest of one release cannot vouch for another. Nothing was installed.`); process.exit(2); }
        console.error(`release manifest: ${manifestFrom} (${source === "relay" ? "served by the relay under /dl" : `the GitHub Release v${latest}; this relay does not mirror /dl`}) — signed by release key ${releasePub.slice(0, 8)}…`);
      }
      // v0.9.11: a release that changes who may do what, or where data goes, says so on a `!!` line. Those lines
      // go in front of the principal BEFORE the install — the agent shows them and comes back with --yes.
      // v0.10.0: the signed manifest carries the same two flags, so a silent changelog cannot hide one.
      // v0.18.0: a relay without a changelog leaves the manifest flags to decide alone.
      let flags: string[] = [];
      const changelog = await getText("/changelog.txt");
      if (changelog) flags = changelogFlags(changelog, VERSION, latest || null);
      if (manifest?.permissionChange && !flags.some((f) => /PERMISSION CHANGE/.test(f))) flags.push(`${manifest.version}: !! PERMISSION CHANGE (declared in the signed manifest)`);
      if (manifest?.dataFlowChange && !flags.some((f) => /DATA FLOW/.test(f))) flags.push(`${manifest.version}: !! DATA FLOW (declared in the signed manifest)`);
      if (flags.length && !has("yes")) {
        const fullText = changelog ? `${DEFAULT_RELAY}/changelog.txt` : (source === "release" && releasePage(latest)) || manifestFrom;
        console.error(`Between can2cup ${VERSION} and ${latest || "the version the relay serves"}, these releases change who may do what, or where data goes:\n${flags.map((f) => "  " + f).join("\n")}\nShow these lines to your principal (full text: ${fullText}). Run  can2cup upgrade --yes  once they have seen them. Nothing was installed.`);
        process.exit(3);
      }
      // v0.9.11 (security G-3, P1): download, check the sha256 the relay advertises, THEN hand the file to npm.
      // Same origin as the tarball, so this does not defeat a hostile relay; it catches a swapped or corrupted
      // file, and gives a person a number to compare out of band. --require-checksum refuses a relay without one.
      // v0.18.0: with the manifest from the release, VERSION.sha256 comes from the same release.
      const shaFrom = manifest && source === "release" && relBase ? `${relBase}/VERSION.sha256` : `${DEFAULT_RELAY}/dl/VERSION.sha256`;
      let expected = "";
      { const r = await fetchText(shaFrom, 8000); if (r.text) expected = /^[0-9a-f]{64}/.exec(r.text.trim())?.[0] ?? ""; }
      if (!expected && has("require-checksum")) { console.error(`no VERSION.sha256 at ${shaFrom} — refusing (--require-checksum). Nothing was installed.`); process.exit(2); }
      // v0.10.1 (G-3 P3, first half): the bytes come from the npm registry by default — a second, independent host
      // that the relay operator does not control — and still have to match the hash in the maintainer-signed
      // manifest. The relay stays the authority on WHICH version and WHICH hash; npm only stores the bytes.
      // --from-relay downloads from /dl/ instead (mirror / bootstrap for networks where npm is blocked).
      let src = url;
      if (!fromRelay && latest) {
        try {
          const meta = await fetch(`${npmRegistry()}/${PACKAGE_NAME}/${latest}`, { signal: AbortSignal.timeout(10000) });
          if (meta.ok) { const t = ((await meta.json()) as { dist?: { tarball?: string } }).dist?.tarball; if (t) src = t; }
        } catch { /* registry unreachable: fall back to the relay */ }
      }
      // A relay that does not mirror /dl has no tarball to fall back to: say where the bytes were not found.
      if (source === "release" && src === url && manifest) { console.error(`could not find ${PACKAGE_NAME}@${latest} on the npm registry (${npmRegistry()}), and this relay does not mirror /dl, so there is nowhere else to take the bytes from. Nothing was installed.`); process.exit(1); }
      console.error(`upgrading can2cup ${VERSION} → ${latest || "?"} from ${src}${src === url ? " (relay)" : " (npm registry)"} …`);
      let buf: Buffer;
      try { const r = await fetch(src, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); }
      catch (e) { console.error(`could not download ${src}: ${e instanceof Error ? e.message : e}. Nothing was installed.${src !== url && source === "relay" ? " Try  can2cup upgrade --from-relay" : ""}`); process.exit(1); }
      const actual = createHash("sha256").update(buf).digest("hex");
      // v0.14.5 (seventh opinion #1): the hash of THE release tarball entry, not "any value in the table".
      if (manifest && manifest.files[RELEASE_TARBALL] !== actual) {
        console.error(`REFUSED: the downloaded tarball's sha256 (${actual.slice(0, 16)}…) is not in the signed manifest for ${manifest.version} — the file ${src === url ? "the relay serves" : "the npm registry serves"} is not the one the maintainer signed.\nNothing was installed. Run  can2cup report "upgrade tarball not in signed manifest"  so the operator hears about it.`);
        process.exit(2);
      }
      if (expected && actual !== expected) {
        console.error(`REFUSED: the downloaded tarball's sha256 does not match ${shaFrom}.\n  expected ${expected}\n  got      ${actual}\nNothing was installed. Run  can2cup report "upgrade sha256 mismatch"  so the operator hears about it.`);
        process.exit(2);
      }
      if (!expected && !manifest) console.error("note: this relay serves no VERSION.sha256 either — installing unverified.");
      if (has("dry-run")) {
        console.log(`dry run: would install can2cup ${latest || "?"} — sha256 ${actual.slice(0, 16)}… ${manifest ? `signed by release key ${releasePub.slice(0, 8)}… (manifest ${manifest.version}, ${manifest.date}, from ${source === "relay" ? "the relay's /dl" : `the GitHub Release v${latest}`})` : "UNSIGNED (--allow-unsigned)"}. Nothing was installed.`);
        return;
      }
      const tmp = path.join(os.tmpdir(), `can2cup-${latest || "latest"}-${randomBytes(4).toString("hex")}.tgz`);
      fs.writeFileSync(tmp, buf);
      const win = process.platform === "win32";
      // Windows: npm is npm.cmd, which needs a shell; hand cmd.exe one string (spawnSync with shell:true + args warns DEP0190).
      const run = (cmd: string, args: string[], capture = false) => win
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", `${cmd} ${args.map((a) => `"${a}"`).join(" ")}`], { stdio: capture ? "pipe" : "inherit", encoding: "utf8", windowsVerbatimArguments: true })
        : spawnSync(cmd, args, { stdio: capture ? "pipe" : "inherit", encoding: "utf8" });
      const rr = run("npm", ["i", "-g", tmp]);
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (rr.status !== 0) { console.error(`npm exited ${rr.status}. If it said EEXIST for an old \`parley\` command: npm rm -g parley, then run can2cup upgrade again.`); process.exit(rr.status ?? 1); }
      const v = run("can2cup", ["--version"], true).stdout?.trim();
      console.log(`installed: can2cup ${v || "(run can2cup --version)"} (this process was ${VERSION}); sha256 ${actual.slice(0, 16)}… ${manifest ? `signed by release key ${releasePub.slice(0, 8)}… (manifest from ${source === "relay" ? "the relay's /dl" : `the GitHub Release v${latest}`})` : expected ? "verified against the relay's VERSION.sha256 (UNSIGNED)" : "UNVERIFIED (relay served no checksum)"}.`);
      saveInstalled((v || latest || VERSION).replace(/^can2cup\s+/, "").trim(), { sha256: actual, verified: !!expected || !!manifest, ...(manifest && source ? { manifestSig: sigTxt.slice(0, 16), releasePub: releasePub.slice(0, 8), manifestFrom: source } : {}) });
      const d = loadDuty();
      if (d) console.log(`a can2cup watch (pid ${d.pid}) is on duty with the old code — it notices within a sweep, exits, and asks your session to start it again on the new code.`);
      console.log("Restart Claude Code once so its MCP server loads the new code. Then: can2cup doctor");
      return;
    }
    case "report": return report();
    case "forget": {
      // v0.8.1: a room this agent can no longer reach (ejected / closed elsewhere / relay gone). Local only; the transcript stays.
      const id = positional(0); if (!id) { console.error("usage: can2cup forget <room>"); process.exit(1); }
      const r = loadRooms()[id]; if (!r) { console.error(`unknown room ${id}`); process.exit(1); }
      r.state = "closed"; saveRoom(r); console.log(`room ${id} marked closed locally. watch will skip it; history stays readable.`); return;
    }
    // ---- v0.9.5: the way out. Every one of these prints what it actually did. ----
    case "leave": {
      // Take this agent out of a room for real: the relay drops it from the participants and the
      // invite secret rotates, so it cannot walk back in. `forget` only ever edited this machine.
      const all = flag("all") !== undefined;
      const id = positional(0);
      if (!all && !id) { console.error('usage: can2cup leave <room>   |   can2cup leave --all\n  (leaves the room for you only. To end it for everyone: can2cup close <room> "<summary>")'); process.exit(1); }
      const rooms = loadRooms();
      const targets = all ? Object.values(rooms).filter((r) => r.state === "open") : [rooms[id!]].filter(Boolean);
      if (!targets.length) { console.error(all ? "no open rooms to leave" : `unknown room ${id}`); process.exit(1); }
      const me = loadIdentity();
      let left = 0;
      for (const r of targets) {
        if (!r.cap) { console.log(`- ${r.id}: joined before v0.3, no per-participant cap — marking it closed here only`); r.state = "closed"; saveRoom(r); continue; }
        try {
          const res = await relay.leave(r.relay, r.id, r.cap, me);
          r.state = "closed"; saveRoom(r); left++;
          console.log(`- ${r.id} "${r.name || ""}": left${res.roomClosed ? " (nobody left in it — the room is closed)" : `, ${res.remaining} still in it`}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`- ${r.id} "${r.name || ""}": ${msg}`);
        }
      }
      if (left) console.log(`\nThe transcript stays readable here (can2cup history <room>), and the people still in those rooms keep their signed copy of what you wrote. Leaving does not retract it.`);
      return;
    }

    case "unbind": {
      // Undo the 1:1 LINE binding from this side. Rooms are untouched — a room belongs to the
      // people in it, not to the phone that happened to open it.
      if (!DEFAULT_RELAY) { console.error("no relay configured"); process.exit(1); }
      // v0.9.11: like erase / uninstall / leave --all, say what it does and wait for --yes (docs review).
      if (!has("yes")) {
        console.error(`can2cup unbind — undoes the 1:1 chat-app binding from this side.\n  deletes on the relay: the binding, its inbox, the principal-key pin for that account\n  keeps: your rooms, your keys, this machine's files (${HOME}); group wires stay until /unmirror\n  cannot delete: LINE pushes already sent, any ban\nRun again with --yes to do it.`);
        process.exit(1);
      }
      const r = await relay.erase(DEFAULT_RELAY, loadIdentity(), "binding");
      if (!r.wasBound) { console.log("this agent was not bound to any chat account."); return; }
      console.log(`unbound from ${chatAppLabel(r.channel ?? undefined)}.\ndeleted on the relay: ${fmtDeleted(r.deleted)}`);
      console.log(`\nkept: your rooms, your keys, this machine's files (${HOME}).\nto bind again: /setup in the chat app (LINE / Discord / Telegram), or  can2cup link <code>`);
      return;
    }

    case "admin": {
      // v0.10.6: the relay operator's view, from the terminal. Needs the room-creation key (CAN2CUP_RELAY_KEY or --key):
      //   can2cup admin activity            who is bound, how much they do, what tripped
      //   can2cup admin bans
      //   can2cup admin ban   --pub <hex> | --user <LINE userId> [--reason "…"]
      //   can2cup admin unban --pub <hex> | --user <LINE userId>
      const key = flag("key") || RELAY_KEY;
      if (!DEFAULT_RELAY || !key) { console.error("admin needs the relay URL and its room-creation key (CAN2CUP_RELAY_KEY or --key) — this is the operator's command"); process.exit(1); }
      const sub = positional(0);
      const adminCall = async (p: string, method = "GET", body?: unknown) => {
        const r = await fetch(`${DEFAULT_RELAY}${p}`, { method, headers: { "x-parley-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({})) as Record<string, unknown>;
        if (!r.ok) { console.error(`relay ${r.status}: ${String(j.error ?? JSON.stringify(j))}`); process.exit(1); }
        return j;
      };
      if (sub === "activity") {
        const a = await adminCall("/admin/activity") as { day: string; roomsPerDay: number; agents: Array<Record<string, unknown>>; pushes: unknown };
        console.log(`relay ${DEFAULT_RELAY} — ${a.day}, ${a.agents.length} bound agent(s), rooms/day limit ${a.roomsPerDay}; pushes: ${JSON.stringify(a.pushes)}`);
        for (const r of a.agents) console.log(`${String(r.banned ? "⛔" : "  ")} ${short(String(r.pub))}  ${String(r.name).padEnd(16)} user ${String(r.userId)}  ver ${String(r.ver ?? "?")}  seen ${String(r.lastSeen ?? "never").slice(0, 16)}  rooms ${r.openRooms}/${r.rooms} (+${r.roomsToday} today)  instr ${r.instructions}${r.hosted ? "  hosted" : ""}${(r.flags as string[]).length ? "  !! " + (r.flags as string[]).join(", ") : ""}`);
        return;
      }
      if (sub === "bans") { console.log(JSON.stringify(await adminCall("/admin/bans"), null, 2)); return; }
      if (sub === "ban" || sub === "unban") {
        const body = { pub: flag("pub"), userId: flag("user"), reason: flag("reason") };
        if (!body.pub && !body.userId) { console.error(`usage: can2cup admin ${sub} --pub <hex> | --user <LINE userId> [--reason "…"]`); process.exit(1); }
        console.log(JSON.stringify(await adminCall(`/admin/${sub}`, "POST", body), null, 2)); return;
      }
      console.error("usage: can2cup admin activity | bans | ban … | unban …"); process.exit(1);
    }
    case "backup": {
      // v0.10.4: everything that cannot be re-created — the agent identity, the principal's key, the mandate, soul,
      // personas, config and room cursors — in one file. The relay holds none of these on purpose, so a lost disk
      // used to mean a new identity and re-inviting every room. The file contains PRIVATE KEYS: keep it offline.
      const out = positional(0) || path.join(os.homedir(), `can2cup-backup-${loadIdentity().name}-${new Date().toISOString().slice(0, 10)}.json`);
      const files: Record<string, string> = {};
      for (const f of ["identity.json", "principal.json", "mandate.json", "soul.md", "config.json", "rooms.json", "upgrade.json"]) {
        const p = path.join(HOME, f); if (fs.existsSync(p)) files[f] = fs.readFileSync(p, "utf8");
      }
      const pd = path.join(HOME, "personas");
      if (fs.existsSync(pd)) for (const f of fs.readdirSync(pd)) if (f.endsWith(".md")) files[`personas/${f}`] = fs.readFileSync(path.join(pd, f), "utf8");
      const id = loadIdentity();
      fs.writeFileSync(out, JSON.stringify({ v: 1, at: new Date().toISOString(), home: HOME, pub: id.pub, name: id.name, files }, null, 2) + "\n", { mode: 0o600 });
      console.log(`backup written: ${out}\n  ${Object.keys(files).length} file(s): ${Object.keys(files).join(", ")}\n  agent ${id.name} (${short(id.pub)})\nThis file holds your agent's private key and your own signing key. Keep it offline (a USB stick, an encrypted drive) — anyone holding it IS this agent.\nRestore on any computer:  can2cup restore "${out}"`);
      return;
    }
    case "restore": {
      const src = positional(0);
      if (!src) { console.error('usage: can2cup restore <backup.json> [--yes]   (--yes: replace an identity that already exists here)'); process.exit(1); }
      let b: { v: number; at: string; pub: string; name: string; files: Record<string, string> };
      try { b = JSON.parse(fs.readFileSync(src, "utf8")); } catch (e) { console.error(`cannot read ${src}: ${e instanceof Error ? e.message : e}`); process.exit(1); }
      if (b.v !== 1 || !b.files || typeof b.files !== "object") { console.error("not a can2cup backup file"); process.exit(1); }
      // the keys must be internally consistent, or the file was damaged / edited
      try {
        const idj = JSON.parse(b.files["identity.json"] ?? "{}") as { pub?: string; priv?: string };
        if (!idj.priv || !idj.pub || pubFromPriv(idj.priv) !== idj.pub || idj.pub !== b.pub) throw new Error("identity.json: pub does not match priv");
        if (b.files["principal.json"]) { const pj = JSON.parse(b.files["principal.json"]) as { pub?: string; priv?: string }; if (!pj.priv || !pj.pub || pubFromPriv(pj.priv) !== pj.pub) throw new Error("principal.json: pub does not match priv"); }
      } catch (e) { console.error(`REFUSED: ${e instanceof Error ? e.message : e} — the backup is damaged or was edited. Nothing was written.`); process.exit(2); }
      const existing = fs.existsSync(path.join(HOME, "identity.json")) ? (JSON.parse(fs.readFileSync(path.join(HOME, "identity.json"), "utf8")) as { pub: string; name: string }) : null;
      if (existing && existing.pub !== b.pub && !has("yes")) {
        console.error(`This computer already has agent ${existing.name} (${short(existing.pub)}); the backup is ${b.name} (${short(b.pub)}) from ${b.at}.\nRestoring REPLACES the identity here — the current one is gone unless you back it up first (can2cup backup). Run again with --yes to do it.`);
        process.exit(1);
      }
      if (loadDuty()) { console.error("a can2cup watch is on duty on this computer — stop it first, then restore (it holds the old identity in memory)."); process.exit(1); }
      fs.mkdirSync(path.join(HOME, "personas"), { recursive: true });
      for (const [f, content] of Object.entries(b.files)) {
        const p = path.join(HOME, f);
        if (path.relative(HOME, p).startsWith("..")) continue; // a backup file must not write outside the home
        fs.writeFileSync(p, content, { mode: f.endsWith(".json") && /identity|principal/.test(f) ? 0o600 : 0o644 });
      }
      console.log(`restored ${Object.keys(b.files).length} file(s) into ${HOME}: agent ${b.name} (${short(b.pub)}), backup from ${b.at}.\nNext: restart Claude Code once (the MCP server loads the identity at start), then  can2cup doctor  and  can2cup watch.\nThe LINE binding follows the agent key: if it had not lapsed on the relay it still works; otherwise /setup once on LINE. Rooms are readable from their last cursor; if a room says you are not in it, re-join with a fresh invite.`);
      return;
    }
    case "keep": {
      // v0.9.12: how long this binding may sit with the AGENT absent before the relay lets it lapse (default 90 days,
      // warned 14 days ahead; any signed call renews). The clock is the agent's absence, never the principal's silence.
      if (!DEFAULT_RELAY) { console.error("no relay configured"); process.exit(1); }
      const arg = positional(0);
      const body: { days?: number; forever?: boolean } = arg === "forever" || arg === "永久" ? { forever: true } : arg && /^\d+$/.test(arg) ? { days: Number(arg) } : {};
      if (arg && body.days === undefined && !body.forever) { console.error("usage: can2cup keep [<days 7-365> | forever]   (no argument: show the current setting)"); process.exit(1); }
      try {
        const r = await bridge.keep(DEFAULT_RELAY, loadIdentity(), body);
        const i = r.idle;
        console.log(i.forever
          ? "idle expiry: never — this binding stays until somebody unbinds it. If you change computers, /setup again (or can2cup unbind here), or the old machine stays your agent."
          : `idle expiry: after ${i.days} ${process.env.CAN2CUP_IDLE_UNIT ?? "days"} of agent absence → ${i.expiresAt} (last seen ${i.lastSeen ?? "never"}; warned 14 days ahead; any signed call renews).${body.forever || body.days ? "" : "  Change: can2cup keep <days> | forever"}`);
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
      return;
    }
    case "erase": {
      // Everything the relay holds about this agent.
      if (!DEFAULT_RELAY) { console.error("no relay configured"); process.exit(1); }
      if (flag("yes") === undefined) {
        console.error(`This asks ${DEFAULT_RELAY} to delete everything it holds about this agent:\n  the LINE binding, your inbox, your group settings, the rooms registry,\n  queued pushes, and the rooms where nobody but you is left.\n\nIt does NOT and cannot delete: messages other participants already received\n(they hold a signed copy), or pushes already delivered to LINE's servers.\n\nRe-run with --yes to do it.`);
        process.exit(1);
      }
      const r = await relay.erase(DEFAULT_RELAY, loadIdentity(), "all");
      console.log(`erased on ${DEFAULT_RELAY}: ${fmtDeleted(r.deleted)}`);
      console.log(`\nStill on this machine: ${HOME}  (can2cup uninstall removes it)`);
      console.log(`Still with other people: whatever you sent into shared rooms. That cannot be recalled.`);
      return;
    }

    case "uninstall": {
      // The whole exit in one command, in the order that leaves nothing dangling: leave the rooms
      // while the caps still work, then erase on the relay, then take the machine apart.
      const keepData = flag("keep-data") !== undefined;
      if (flag("yes") === undefined) {
        console.error(`can2cup uninstall  — removes this agent from this computer.\n\n  1. leaves every open room (the others are told; the transcript stays with them)\n  2. asks the relay to delete the LINE binding, the inbox and the rooms registry\n  3. removes the MCP registration from Claude Code\n  4. deletes ${HOME}${keepData ? "  (skipped: --keep-data)" : ""}\n  5. prints the one command left for you: npm uninstall -g can2cup\n\nRe-run with --yes.`);
        process.exit(1);
      }
      const me = loadIdentity();
      console.log("1. leaving rooms");
      for (const r of Object.values(loadRooms()).filter((x) => x.state === "open")) {
        if (!r.cap) { console.log(`   - ${r.id}: no cap, skipped on the relay`); continue; }
        try { await relay.leave(r.relay, r.id, r.cap, me); console.log(`   - ${r.id} "${r.name || ""}": left`); }
        catch (e) { console.log(`   - ${r.id}: ${e instanceof Error ? e.message : e}`); }
      }
      console.log("2. asking the relay to forget this agent");
      if (DEFAULT_RELAY) {
        try { const r = await relay.erase(DEFAULT_RELAY, me, "all"); console.log(`   ${fmtDeleted(r.deleted)}`); }
        catch (e) { console.log(`   could not reach ${DEFAULT_RELAY}: ${e instanceof Error ? e.message : e}\n   → the relay still holds your data. Re-run \`can2cup erase --yes\` when you are online, or type /forgetme to the LINE bot.`); }
      } else console.log("   (no relay configured — nothing to erase)");
      console.log("3. removing the MCP registration");
      const rm = run("claude", ["mcp", "remove", "can2cup", "-s", "user"], { stdio: "ignore" });
      console.log(rm.status === 0 ? "   removed from Claude Code (user scope)" : "   claude CLI not available — remove the can2cup entry from your MCP config by hand");
      try { fs.rmSync(path.join(claudeHome(), "skills", "can2cup"), { recursive: true, force: true }); console.log("   skill removed"); } catch { /* best effort */ }
      console.log(`4. ${keepData ? "keeping" : "deleting"} ${HOME}`);
      if (!keepData) {
        try { fs.rmSync(HOME, { recursive: true, force: true }); console.log("   deleted (keys, rooms, transcripts, audit log — all of it)"); }
        catch (e) { console.log(`   could not delete: ${e instanceof Error ? e.message : e}\n   → delete the folder by hand.`); }
      } else console.log("   kept — your keys and transcripts are still there");
      console.log(`\n5. one command left, run it yourself (this process is the package):\n\n   npm uninstall -g can2cup\n`);
      console.log(`Also worth knowing:\n  - a duty watch running in another window will exit on its next sweep.\n  - Claude Code keeps the can2cup tools until you restart it.\n  - other people's copies of what you wrote in shared rooms stay theirs.`);
      return;
    }

    case "skill": {
      if (!fs.existsSync(skillFile)) { console.error(`SKILL.md not found at ${skillFile}`); process.exit(1); }
      if (has("install")) { console.log(installSkill()); return; }
      console.log(fs.readFileSync(skillFile, "utf8"));
      return;
    }
    // ---- agent-facing (core) ----
    case "join": {
      const inv = positional(0);
      if (!inv) { console.error('usage: can2cup join "<invite link | token | 8-char code ABCD-1234>"'); process.exit(1); }
      const c = await core(); console.log(c.outText(await c.opJoin(inv))); return;
    }
    case "wait": {
      const id = positional(0);
      if (!id) { console.error("usage: can2cup wait <room> [--timeout 25]"); process.exit(1); }
      const c = await core(); console.log(c.outText(await c.opWait(id, Number(flag("timeout") ?? 25) || 0))); return;
    }
    case "send": {
      const id = positional(0); const type = positional(1) as MsgType | undefined; const t = msgText(positional(2));
      if (!id || !type || t === undefined || !MSG_TYPES.includes(type) || type === "system") {
        console.error('usage: can2cup send <room> <type> "<text>" | <room> <type> --text-file FILE [--amount N] [--currency C] [--scope S] [--expires-hours H] [--ref N] [--url U] [--sha256 H] [--name N] [--rationale "…"]\n  types: ' + MSG_TYPES.filter((x) => x !== "system").join(" "));
        process.exit(1);
      }
      const num = (n: string) => (flag(n) !== undefined ? Number(flag(n)) : undefined);
      const c = await core();
      console.log(c.outText(await c.opSend({ room: id, type, text: t, amount: num("amount"), currency: flag("currency"), scope: flag("scope"), expiresHours: num("expires-hours"), ref: num("ref"), url: flag("url"), sha256: flag("sha256"), name: flag("name"), rationale: flag("rationale") })));
      return;
    }
    case "history": {
      const id = positional(0); if (!id) { console.error("usage: can2cup history <room>"); process.exit(1); }
      const c = await core(); console.log(c.outText(await c.opHistory(id))); return;
    }
    case "seal-bid": {
      // PRINCIPAL action: authorise ONE sealed bid for the brokerage layer. Signed with your principal
      // key, stored on THIS machine only — the figure never touches the chain (that would leak your
      // reservation value before the sealed mechanism runs).
      const roomId = positional(0);
      const open = Number(positional(1));
      const side = positional(2);
      const amount = Number(positional(3));
      const room = roomId ? loadRooms()[roomId] : undefined;
      if (!room || !Number.isInteger(open) || open < 1 || (side !== "buy" && side !== "sell") || !Number.isInteger(amount) || amount < 0) {
        console.error("usage: can2cup seal-bid <room> <open-seq> <buy|sell> <amount>\n  authorises ONE sealed bid for this machine's agent; signed with your principal key, kept on this computer, never on the chain until reveal.");
        process.exit(1);
      }
      const p = needPrincipal();
      const meId = loadIdentity();
      const sb = signSealedBid({ room: room.id, open, side, amount, agent: meId.pub }, p.priv, p.pub);
      saveMechLocal({ room: room.id, open, side, bid: amount, nonce: sb.nonce, at: sb.at, auth: sb });
      const m = loadMandate();
      const cap = m.max_commit_amount;
      const warn = cap != null && amount > cap ? `\n⚠ ${amount} is above your mandate's max_commit_amount ${cap} — the commit will be refused until you widen the mandate or lower the bid.` : "";
      console.log(`sealed bid authorised: room ${room.id}, open #${open}, ${side} ${amount}${m.currency ? " " + m.currency : ""}\nsigned by your principal key, stored on THIS machine only (never transmitted).\nthe agent can commit now:  can2cup mechanism commit ${room.id} --ref ${open}   (or the can2cup_mechanism MCP tool)${warn}`);
      return;
    }
    case "mechanism": {
      const phase = positional(0);
      const id = positional(1);
      if (!id || (phase !== "open" && phase !== "commit" && phase !== "reveal" && phase !== "status")) {
        console.error('usage: can2cup mechanism <open|commit|reveal|status> <room> [--side buy|sell] [--k 0.5] [--currency C] [--ref <open seq>]\n  open: state the rules and your side. commit: send the bid your principal authorised (can2cup seal-bid). reveal: open it once both sides committed. status: where it stands.');
        process.exit(1);
      }
      const c = await core();
      console.log(c.outText(await c.opMechanism({
        room: id, phase,
        side: flag("side") as "buy" | "sell" | undefined,
        k: flag("k") !== undefined ? Number(flag("k")) : undefined,
        currency: flag("currency"), deadline: flag("deadline"),
        ref: flag("ref") !== undefined ? Number(flag("ref")) : undefined,
        bid: flag("bid") !== undefined ? Number(flag("bid")) : undefined,
        rationale: flag("rationale"),
      })));
      return;
    }
    case "close": {
      const id = positional(0); const sum = msgText(positional(1));
      if (!id || !sum) { console.error('usage: can2cup close <room> "<summary>" | <room> --text-file FILE'); process.exit(1); }
      const c = await core(); console.log(c.outText(await c.opClose(id, sum))); return;
    }
    case "create": {
      const c = await core(); console.log(c.outText(await c.opCreateRoom({ name: flag("name"), ttlHours: flag("ttl-hours") ? Number(flag("ttl-hours")) : undefined, e2e: has("e2e"), group: flag("group") }))); return;
    }
    case "wire": {
      // v0.8.2: attach a room opened by hand to the LINE group it is for (join code posted there + mirror).
      const id = positional(0); const g = positional(1);
      if (!id || !g) { console.error("usage: can2cup wire <room> <group alias|id|name>   (groups: can2cup groups)"); process.exit(1); }
      const c = await core(); console.log(c.outText(await c.opWire(id, g))); return;
    }
    case "link": {
      const c = await core();
      const claim = positional(0);
      if (claim) { // reverse flow: the human got a code from the bot first ("/link" with no code)
        console.log(c.outText(await c.opLink(claim)));
        return;
      }
      const l = await c.linkDetails();
      console.log(`/link ${l.code}   (valid ${l.minutes} min)${l.alreadyBound ? "  — already bound; re-binds" : ""}`);
      if (l.url) {
        console.log(`\nScan with your phone (LINE or camera) → opens the can2cup bot chat with "/link ${l.code}" typed; tap send.\n${l.url}\nPNG: ${l.qrPng}\n`);
        console.log(await QRCode.toString(l.url, { type: "terminal", small: true }));
      } else {
        console.log("\nSend that to the can2cup bot (LINE / Discord / Telegram) within the time limit.");
      }
      if (l.tgUrl) console.log(`Telegram: tap ${l.tgUrl} on the phone — opens the bot with the code filled in.`);
      return;
    }
    case "tell": {
      const t = msgText(positional(0)) ?? "";
      const img = flag("image");
      if (!t && !img) { console.error('usage: can2cup tell "<text>" | --text-file FILE  [--where dm|group|group:<alias>] [--image FILE] [--ttl SEC] [--room ID]'); process.exit(1); }
      const c = await core(); console.log(c.outText(await c.opTell(t, flag("room"), flag("where"), img, flag("ttl") ? Number(flag("ttl")) : undefined))); return;
    }
    case "groups": {
      const c = await core(); console.log(c.outText(await c.opGroups())); return;
    }
    case "ack": {
      // v0.8.0: "I (or my Claude) am handling the instructions watch printed" — otherwise the relay reminds the
      // principal after 15 min and hands them out again.
      const c = await core(); const seq = positional(0) ? Number(positional(0)) : undefined;
      console.log(c.outText(await c.opAck(seq))); return;
    }
    case "note": {
      const id = positional(0); const t = positional(1);
      if (!id || !t) { console.error('usage: can2cup note <room> "<summary of where this room stands>"'); process.exit(1); }
      const c = await core(); console.log(c.outText(c.opNote(id, t))); return;
    }
    // ---- v0.9.6: who this agent is ----
    case "soul": {
      const f = soulFile();
      const body = loadSoul();
      if (positional(0) === "path") { console.log(f); return; }
      console.log(`${body}\n\n---\n${f}  (edit this file to change how your agent comes across everywhere)`);
      return;
    }
    case "address": {
      // v0.9.8: how this agent addresses you. Local only — config.json + the line in soul.md.
      const want = positional(0);
      if (want === undefined) {
        console.log(`your agent addresses you as 「${loadAddress()}」\n  stored in  ${CONFIG_PATH}\n  change it  can2cup address "<稱呼>"   (soul.md follows)`);
        return;
      }
      const a = normalizeAddress(want);
      if (!a) { console.error('usage: can2cup address "<稱呼>"   — one short phrase, one line (up to 24 characters)'); process.exit(1); }
      saveConfig({ address: a });
      const f = applyAddressToSoul(a);
      console.log(`from now on your agent addresses you as 「${a}」.\n  ${CONFIG_PATH}\n  ${f}  (the line under the opening sentence; a session already running sees it the next time it reads soul.md)`);
      return;
    }
    case "persona": {
      const place = positional(0);
      if (!place) { console.error('usage: can2cup persona <group-alias|room|place> ["<what you learned about how you land here>"]\n  with no text it prints what you recorded last.'); process.exit(1); }
      const c = await core();
      console.log(c.outText(c.opPersona(place.startsWith("group-") || /^[0-9a-f]{12}$/.test(place) ? place : `group-${place}`, msgText(positional(1)))));
      return;
    }
    case "watch": {
      const c = await core();
      // v0.8.0: one inbox duty per computer. A second watch would race the first for the same instructions.
      const held = acquireDuty(flag("exec") ? "exec" : "stdout");
      if (held) { console.error(`watch: another can2cup watch (pid ${held.pid}, ${held.mode}, since ${held.at}) is already on duty on this computer. Stop it first, or let it work.`); process.exit(3); }
      const letGo = () => releaseDuty();
      process.on("exit", letGo); process.on("SIGINT", () => { letGo(); process.exit(130); }); process.on("SIGTERM", () => { letGo(); process.exit(143); });
      // v0.4.6: zero-WAIT sweeps, not long-polls. A held long-poll keeps the relay's Durable Object
      // active the whole time and burned the free tier's daily duration quota in one day of duty
      // (2026-08-21, "Exceeded allowed duration in Durable Objects free tier"). wait=0 polls cost the
      // DO milliseconds; the waiting happens here, in this process, for free.
      // 2026-09-14: the relay's daily write cap was spent three days running (2026-09-11..13) by our own clients'
      // polling — one orphaned `watch --interval 5` alone made ~1,175 inbox reads an hour. Since then: a floor under
      // --interval, the relay's pacing hints honoured, exponential backoff while the relay is busy or down, and
      // --max-hours so a watch nobody reads any more stands down by itself.
      // Deliberately NOT done: noticing that the session which started this watch is gone by enumerating processes
      // (ps / wmic / PowerShell). This runs on managed endpoints with EDR, where a node process that keeps spawning
      // process-discovery commands looks like malware. --max-hours is the backstop for an orphaned watch instead.
      const exec = flag("exec");
      const floorEnv = (process.env.CAN2CUP_WATCH_MIN_INTERVAL ?? "").trim(); // tests only (smoke, probe:prod)
      const testPacing = floorEnv !== "" && Number.isFinite(Number(floorEnv)) && Number(floorEnv) >= 0;
      const minInterval = testPacing ? Number(floorEnv) : 15;
      const asked = Number(flag("interval") ?? flag("timeout") ?? 30) || 30; // --timeout kept as a legacy alias; 30 s (was 25)
      // setTimeout turns Infinity or anything past 2^31-1 ms into ~1 ms — a huge --interval would become a tight loop
      if (!Number.isFinite(asked) || asked < 0 || asked > 86_400) { console.error(`watch: --interval ${flag("interval") ?? flag("timeout")} must be a number of seconds up to 86400`); process.exit(2); }
      const interval = Math.max(minInterval, asked);
      if (asked < minInterval) console.error(`watch: --interval ${asked} is below the minimum of ${minInterval} s — sweeping every ${interval} s instead`);
      const mh = flag("max-hours");
      const maxHours = mh === undefined ? (exec ? 0 : 12) : Number(mh) > 0 ? Number(mh) : 0;
      const pace = watchPacer({ interval, maxHours, testPacing });
      const trace = process.env.CAN2CUP_WATCH_TRACE === "1"; // tests only: one stderr line per finished sweep
      let sweeps = 0;
      const endOfSweep = async (transient: string | null) => { if (trace) console.error(`watch: sweep ${++sweeps} done`); await pace.rest(transient); };
      const stopLine = maxHours ? `, stands down after ${maxHours} h with nothing new` : "";
      let rooms: string[] = [];
      for (let k = 1; k < argv.length; k++) { if (argv[k].startsWith("--")) { k++; continue; } rooms.push(argv[k]); }
      if (!rooms.length) rooms = Object.values(loadRooms()).filter((r) => r.state === "open").map((r) => r.id);
      if (!rooms.length) {
        // Fresh install: no room yet, but a LINE-bound principal may /a us any minute. Inbox-only duty.
        console.error(`no open rooms — watching the principal inbox only (sweep every ${interval}s${stopLine}; content ${exec ? `→ ${exec}` : "→ stdout, then exit 0"}). Join a room and restart watch to cover it too.`);
        for (;;) {
          refreshDuty();
          {
            const inst = loadUpgradeNag()?.installed;
            if (inst && inst.version && cmpSemver(inst.version, VERSION) > 0) {
              console.log(`=== can2cup watch: a newer client is installed ===\nThis watch is running can2cup ${VERSION}; can2cup ${inst.version} was installed at ${inst.at}. Start duty again to come up on it, and restart Claude Code once.`);
              return;
            }
          }
          { const ended = pace.ended(); if (ended) { console.log(ended); return; } }
          let transient: string | null = null;
          try {
            const o = await c.opInboxPeek(false, { throwOnFail: true });
            if (!o.empty) {
              const text = `=== can2cup watch: principal instruction(s) ===\n${c.outText(o)}${exec ? "" : NOT_ACKED_HINT}`;
              if (exec) { pace.content(); console.error(text); const rr = spawnSync(exec, { shell: true, input: text, stdio: ["pipe", "inherit", "inherit"] } as never) as { status: number | null }; if (rr.status === 0) await c.opAck().catch(() => undefined); else console.error(`watch: --exec exited ${rr.status}; not acked`); }
              else { console.log(text); return; }
            }
          } catch (e) { transient = watchTransient(e); console.error(`watch: inbox error: ${e instanceof Error ? e.message : e}`); }
          // review C11: a room may have appeared (invite accepted, /room handled) — switch to the room loop
          if (Object.values(loadRooms()).some((r) => r.state === "open")) { console.error("watch: a room opened — restarting duty with rooms"); releaseDuty(); const rr = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], { stdio: "inherit" }); process.exit(rr.status ?? 0); }
          await endOfSweep(transient);
        }
      }
      console.error(`watching ${rooms.join(", ")} + principal inbox (sweep every ${interval}s, zero-wait polls${stopLine}; content ${exec ? `→ ${exec}` : "→ stdout, then exit 0"})`);
      const fails = new Map<string, number>(); // one broken room must not kill the whole duty (it did, once)
      const MUTE_AT = 10;
      let inboxOnly = false; // v0.7.9: every room dead (e.g. rooms from a relay that no longer exists) ≠ off duty
      // v0.9.0: the relay's version headers arrive with the first sweep; say it once (stderr), and once more in
      // front of the first content this watch hands to the agent, so the agent — not the human — decides.
      let pendingUpgrade: string | null | undefined; // undefined = relay not asked yet this process
      let upgradeShown = false;
      const upgradeOnce = (): string | null => { if (pendingUpgrade === undefined) { pendingUpgrade = c.upgradeText(); if (pendingUpgrade) console.error(`watch: ${pendingUpgrade}`); } return pendingUpgrade; };
      const withUpgrade = (t: string): string => { const up = upgradeOnce(); if (!up || upgradeShown) return t; upgradeShown = true; return `${up}\n\n${t}`; };
      // v0.9.2: `can2cup upgrade` cannot replace the code inside a process that is already running.
      // This one exits instead, with the restart line as its content — the session that started it
      // reads that the way it reads any other watch output, and starts the new code.
      const installedElsewhere = (): string | null => {
        const inst = loadUpgradeNag()?.installed;
        // 只有「裝上來的比我新」才退場。反過來(我跑的是新的、upgrade.json 記著舊版)不是升級,
        // 是這台在跑開發版 —— 那樣還退場的話,值班會在每一輪自殺。
        return inst && inst.version && cmpSemver(inst.version, VERSION) > 0
          ? `=== can2cup watch: a newer client is installed ===\nThis watch is running can2cup ${VERSION}; can2cup ${inst.version} was installed on this computer at ${inst.at}.\nA running process cannot swap its own code, so this one is standing down. Start duty again (same command) and it comes up on ${inst.version}.\nAlso restart Claude Code once, so its MCP server loads the new code too.`
          : null;
      };
      for (;;) {
        refreshDuty();
        { const drift = installedElsewhere(); if (drift) { console.log(drift); return; } }
        { const ended = pace.ended(); if (ended) { console.log(ended); return; } }
        // review C11: rooms joined or created since we started (LINE invites, /room requests) get watched too.
        for (const r of Object.values(loadRooms())) if (r.state === "open" && !rooms.includes(r.id)) rooms.push(r.id);
        let transient: string | null = null; // set when the relay was busy or unreachable this sweep → back off
        // traffic fix: the principal inbox once per sweep, then each room without re-reading it
        try {
          const ib = await c.opInboxPeek(false, { throwOnFail: true });
          upgradeOnce();
          if (!ib.empty) {
            const text = withUpgrade(`=== can2cup watch: principal instruction(s) ===
${c.outText(ib)}${exec ? "" : NOT_ACKED_HINT}`);
            if (exec) { pace.content(); console.error(text); const rr = spawnSync(exec, { shell: true, input: text, stdio: ["pipe", "inherit", "inherit"] } as never) as { status: number | null }; if (rr.status === 0) await c.opAck().catch(() => undefined); }
            else { console.log(text); return; }
          }
        } catch (e) { transient = watchTransient(e); console.error(`watch: inbox error: ${e instanceof Error ? e.message : e}`); }
        for (const room of rooms) {
          if ((fails.get(room) ?? 0) >= MUTE_AT) continue;
          try {
            const o = await c.opWait(room, 0, false, true); // review R4: watch never acks by reading; inbox already read above
            fails.set(room, 0);
            if (o.empty) continue;
            const text = withUpgrade(`=== can2cup watch: content (while polling room ${room}) ===\n${c.outText(o)}${exec ? "" : NOT_ACKED_HINT}`);
            if (exec) { pace.content(); console.error(text); const rr = spawnSync(exec, { shell: true, input: text, stdio: ["pipe", "inherit", "inherit"] } as never) as { status: number | null }; if (rr.status === 0) await c.opAck().catch(() => undefined); else console.error(`watch: --exec exited ${rr.status}; not acked — the relay will remind your principal`); continue; }
            console.log(text);
            return;
          } catch (e) {
            // 2026-09-14: a 5xx / 429 / network error says nothing about the room and never counts toward muting it —
            // during the write-cap outage 500s muted healthy rooms for the rest of the watch. What counts: the relay
            // refusing the room (401/403/404/410) and errors on this computer (the room's local state gone or
            // unreadable), which repeat every sweep until someone acts.
            const t = watchTransient(e);
            if (t) { transient ??= t; console.error(`watch: room ${room} error (${t}, not counted toward muting): ${e instanceof Error ? e.message : e}`); continue; }
            if (e instanceof RelayError && ![401, 403, 404, 410].includes(e.status)) { console.error(`watch: room ${room} error (not counted toward muting): ${e.message}`); continue; }
            const n = (fails.get(room) ?? 0) + 1;
            fails.set(room, n);
            console.error(`watch: room ${room} error ${n}/${MUTE_AT}: ${e instanceof Error ? e.message : e}`);
            if (n === MUTE_AT) console.error(`watch: room ${room} muted after ${MUTE_AT} consecutive errors — still watching the rest; restart watch to retry it`);
          }
        }
        if (rooms.every((r) => (fails.get(r) ?? 0) >= MUTE_AT) && !inboxOnly) {
          // v0.7.9: the rooms are dead, the principal is not. the first external user's first day (2026-09-04): their only room lived on
          // the old relay, 10× 401 muted it, and watch exited — so her LINE /a went unread. Keep sweeping the inbox.
          // 2026-09-14: the inbox is already read once at the top of every sweep; this used to read it a second time.
          inboxOnly = true;
          console.error("watch: every room is failing — switching to principal-inbox-only duty (leave or close the dead rooms to silence this; restart watch to retry them)");
        }
        await endOfSweep(transient);
      }
    }
    default: usage();
  }
}

/** 2026-09-14: is this sweep error the relay being busy or unreachable (→ back off, never mute a room for it)?
 *  Returns a short label, or null for an answer that is about the request itself. */
function watchTransient(e: unknown): string | null {
  if (e instanceof RelayError) return e.status === 429 || e.status >= 500 ? `relay ${e.status}` : null;
  const code = (e as { cause?: { code?: string } } | null)?.cause?.code;
  const msg = e instanceof Error ? e.message : String(e);
  if (code || (e instanceof TypeError && /fetch failed/i.test(msg)) || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg)) return `network error${code ? ` ${code}` : ""}`;
  return null;
}

/** 2026-09-14: how long `can2cup watch` rests between sweeps, and when it stands down.
 *  - normal sweep: max(--interval, the relay's hint: x-can2cup-poll-after / Retry-After), hint capped at 5 min;
 *  - a sweep that met a 429 / 5xx / network error: doubles each time, up to 5 min;
 *  - --max-hours: after that long with nothing new, ended() returns the stand-down text (every rest is cut to fit).
 *  testPacing (CAN2CUP_WATCH_MIN_INTERVAL set — smoke, probe:prod): hints ignored, backoff capped at 2 × interval. */
function watchPacer(o: { interval: number; maxHours: number; testPacing: boolean }) {
  const MAX_BACKOFF_SEC = 300;
  const maxMs = o.maxHours > 0 ? o.maxHours * 3_600_000 : 0;
  let quietSince = Date.now();
  let level = 0;
  return {
    /** content was handed on (--exec keeps watching): the quiet clock starts over */
    content(): void { quietSince = Date.now(); },
    ended(): string | null {
      if (!maxMs || Date.now() - quietSince < maxMs) return null;
      return `=== can2cup watch: duty ended after ${o.maxHours} h with nothing new ===\nNothing arrived for ${o.maxHours} h, so this watch stood down by itself (a watch nobody reads would otherwise poll the relay forever).\nIf your principal still expects you to be reachable, start duty again (same command).`;
    },
    async rest(transient: string | null): Promise<void> {
      const hint = Math.min(MAX_BACKOFF_SEC, takePollHint() ?? 0);
      let sec: number;
      if (transient) {
        level = Math.min(level + 1, 16);
        const cap = o.testPacing ? o.interval * 2 : Math.max(MAX_BACKOFF_SEC, o.interval);
        sec = Math.min(cap, Math.max(o.interval, o.testPacing ? 0 : hint) * 2 ** level);
        console.error(`watch: ${transient} — backing off, next sweep in ${Math.round(sec)} s`);
      } else {
        level = 0;
        sec = o.testPacing ? o.interval : Math.max(o.interval, hint);
      }
      if (maxMs) sec = Math.min(sec, Math.max(0, (quietSince + maxMs - Date.now()) / 1000));
      await new Promise((r) => setTimeout(r, sec * 1000));
    },
  };
}

/** Copy SKILL.md into ~/.claude/skills/can2cup/ so every Claude Code session can learn can2cup by itself. */
/** v0.9.5: text for a message, from --text-file if given, else the positional argument.
 *
 *  On Windows the `can2cup.cmd` shim runs through cmd.exe, where a newline inside an argument ends
 *  the command: a multi-line message is silently truncated to its first line and the send still
 *  reports success. Anything longer than one line should come from a file. */
function msgText(positionalText: string | undefined): string | undefined {
  const f = flag("text-file");
  if (!f) return positionalText;
  try { return fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").trim(); }
  catch (e) { console.error(`--text-file ${f}: ${e instanceof Error ? e.message : e}`); process.exit(1); }
}

/** v0.9.5: turn the relay's deletion manifest into something a human can check us on. */
function fmtDeleted(d: Record<string, number>): string {
  const label: Record<string, string> = {
    inbox: "inbox", inboxSeq: "inbox counter", read: "read cursor", seen: "seen cursor",
    groups: "known groups", galias: "group aliases", principal: "registered principal key",
    paused: "pause state", spause: "signed pause", lastGroup: "last group", offline: "presence",
    offpend: "presence", offtold: "presence", oldnag: "upgrade nag", stale: "presence",
    ver: "client version", pub: "binding (by agent)", user: "binding (by chat account)",
    mirror: "wired groups", mirrors: "group→room links", quiet: "quiet settings",
    ctx: "group-context settings", roomreq: "pending room requests", room: "room registry",
    rooms: "your room list", recent: "recent-room cache", pq: "queued pushes", "push-log": "push log entries",
  };
  const parts = Object.entries(d).filter(([, n]) => n > 0).map(([k, n]) => `${label[k] ?? k} ×${n}`);
  return parts.length ? parts.join(", ") : "nothing was there";
}

function installSkill(): string {
  const dir = path.join(claudeHome(), "skills", "can2cup");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(skillFile, path.join(dir, "SKILL.md"));
  return `skill installed: ${path.join(dir, "SKILL.md")}`;
}

/** Onboarding checklist. Each line: done / next step with the exact command. */
/** v0.8.1: one command that finds what is wrong and says how to fix it — so another person's agent can
 *  repair its own install without us. Also the payload of `can2cup report`. Returns [lines, problems]. */
async function doctor(): Promise<{ lines: string[]; problems: string[] }> {
  const lines: string[] = []; const problems: string[] = [];
  const ok = (t: string) => lines.push(`✅ ${t}`);
  const bad = (t: string, fix: string) => { lines.push(`❌ ${t}\n   → ${fix}`); problems.push(t); };
  const warn = (t: string, fix: string) => lines.push(`⚠️ ${t}\n   → ${fix}`);
  // 1. runtime
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) ok(`node ${process.versions.node}`); else bad(`node ${process.versions.node} is too old`, "install Node.js 18+ from https://nodejs.org and reinstall can2cup");
  // 2. version vs relay (+ v0.9.11: what the last `can2cup upgrade` installed, and whether its sha256 was verified)
  { const inst = loadUpgradeNag()?.installed; if (inst?.sha256) ok(`last upgrade installed ${inst.version} from sha256 ${inst.sha256.slice(0, 8)}… (${inst.releasePub ? `signed by release key ${inst.releasePub}…${inst.manifestFrom ? `, manifest from ${inst.manifestFrom === "release" ? "the GitHub Release" : "the relay's /dl"}` : ""}` : inst.verified ? "sha256 matched the relay's VERSION.sha256, but UNSIGNED" : "UNVERIFIED — the relay served no checksum"})`); }
  ok(`trusts release key(s): ${RELEASE_PUBS.map((p) => p.slice(0, 8) + "…").join(", ")}${process.env.CAN2CUP_RELEASE_PUBS ? "  (!! overridden by CAN2CUP_RELEASE_PUBS in this environment)" : ""} — an upgrade must be signed by one of these`);
  { const o = sourceOverrides(); if (o.length) warn(`upgrade sources overridden by ${o.join(", ")} in this environment`, "dev and smoke only — unset them on a real install (the signature and hash checks still apply)"); }
  let latest = "";
  let mirrored = false;
  if (DEFAULT_RELAY) {
    try { const r = await fetch(`${DEFAULT_RELAY}/dl/VERSION`, { signal: AbortSignal.timeout(8000) }); if (r.ok) { latest = (await r.text()).trim(); mirrored = !!latest; } } catch { /* offline */ }
    // v0.18.0: a relay that does not mirror /dl still says its latest client on every signed reply.
    if (!latest) latest = (await advertisedLatest(DEFAULT_RELAY)) ?? "";
  }
  if (!latest) warn(`can2cup ${VERSION} (relay unreachable, latest unknown)`, `check ${DEFAULT_RELAY || "CAN2CUP_RELAY"} is reachable`);
  else if (latest === VERSION) ok(`can2cup ${VERSION} (latest)`);
  else warn(`can2cup ${VERSION}, relay serves ${latest}`, mirrored
    ? `can2cup upgrade   (downloads can2cup@${latest} from the npm registry, checks it against the signed manifest, installs; --from-relay uses ${DEFAULT_RELAY}/dl/can2cup.tgz)`
    : `can2cup upgrade   (this relay does not mirror /dl: the signed manifest comes from the GitHub Release v${latest}, the bytes from the npm registry, then installs)`);
  // 3. identity / mcp / skill
  const hasId = fs.existsSync(path.join(HOME, "identity.json"));
  if (hasId) ok(`identity ${loadIdentity().name} (${short(loadIdentity().pub)}) in ${HOME}`); else bad("no agent identity", `can2cup setup --relay ${DEFAULT_RELAY || "<relay>"} --name <name>`);
  let mcpOk = false;
  try { const r = run("claude", ["mcp", "get", "can2cup"], { encoding: "utf8" }); mcpOk = r.status === 0 && /can2cup/.test(String(r.stdout ?? "")); } catch { /* no claude */ }
  if (mcpOk) ok("registered as a Claude Code MCP server"); else warn("not registered with Claude Code (or `claude` not on PATH)", "can2cup setup … registers it; other clients: can2cup setup --client json");
  const skillPath = path.join(claudeHome(), "skills", "can2cup", "SKILL.md");
  if (fs.existsSync(skillPath)) ok("agent skill installed"); else warn("agent skill not installed", "can2cup skill --install");
  // 4. relay + LINE + inbox
  let st: Awaited<ReturnType<typeof bridge.state>> | null = null;
  if (DEFAULT_RELAY && hasId) {
    try { st = await bridge.state(DEFAULT_RELAY, loadIdentity()); } catch (e) { bad(`relay ${DEFAULT_RELAY} not answering: ${e instanceof Error ? e.message : e}`, "check the network; if the relay moved, run can2cup setup --relay <new url> again"); }
  }
  if (st) {
    if (st.bound) ok(`${chatAppLabel(st.channel?.channel)} linked`); else warn("not linked to a chat app", "in the can2cup bot (LINE / Discord / Telegram) type /setup (or /link) — instructions from your phone need this");
    const pending = Math.max(0, st.inboxSeq - loadInboxCursor());
    if (pending) warn(`${pending} instruction(s) from your principal not yet read`, "run `can2cup watch` (background) or have the agent call can2cup_wait");
    if (st.paused) warn("remote PAUSE is on", "your principal typed /pause in their chat app — nothing goes out until they /resume");
  }
  // 5. duty
  const duty = loadDuty();
  if (duty) ok(`on duty: can2cup watch pid ${duty.pid} (${duty.mode}) since ${duty.at}`); else warn("nothing is on duty", "start `can2cup watch` in a background shell — LINE instructions are only answered while something listens");
  // 6. rooms: a room that answers 401/404 is dead for this agent (ejected, closed elsewhere, or a relay that no longer exists)
  const rooms = Object.values(loadRooms()).filter((r) => r.state === "open");
  for (const r of rooms) {
    try {
      const res = await fetch(`${r.relay}/rooms/${r.id}/info`, { headers: { authorization: `Bearer ${r.cap ?? r.secret}` }, signal: AbortSignal.timeout(8000) }); // review C9: /head is 404 on an unsigned relay
      if (res.ok) ok(`room ${r.id} "${r.name}" reachable`);
      else if (res.status === 401 || res.status === 404) bad(`room ${r.id} "${r.name}" answers ${res.status} — you were ejected, it was closed, or its relay is gone`, `can2cup forget ${r.id}   (marks it closed locally; ask the other side for a new invite if you still need to talk)`);
      else warn(`room ${r.id} answers ${res.status}`, "transient? try again in a minute");
    } catch (e) { warn(`room ${r.id} relay ${r.relay} unreachable: ${e instanceof Error ? e.message : e}`, "network, or that relay no longer exists → can2cup forget " + r.id); }
  }
  if (!rooms.length) lines.push("ℹ️ no open rooms (fine — /a from the chat app still works without one)");
  // 7. known issues from the relay
  if (DEFAULT_RELAY) {
    try {
      const r = await fetch(`${DEFAULT_RELAY}/known-issues.json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const ki = (await r.json()) as { issues?: Array<{ id: string; match: string; title: string; fix: string }> };
        const text = lines.join("\n");
        for (const i of ki.issues ?? []) if (new RegExp(i.match, "i").test(text)) lines.push(`📌 known issue ${i.id}: ${i.title}\n   → ${i.fix}`);
      }
    } catch { /* optional */ }
  }
  return { lines, problems };
}

/** v0.8.1: send the doctor output (+ a note) to the relay operator. No room content leaves the machine. */
async function report(): Promise<void> {
  if (!DEFAULT_RELAY) { console.error("CAN2CUP_RELAY not set"); process.exit(1); }
  const d = await doctor();
  const errors: string[] = [];
  try {
    const audit = fs.readFileSync(path.join(HOME, "audit.jsonl"), "utf8").trim().split("\n").slice(-200);
    for (const l of audit) { try { const j = JSON.parse(l) as { kind?: string; reason?: string; error?: string; status?: string; at?: string }; if (j.kind === "blocked" || j.error || (j.status && /bad|replay|fail/i.test(j.status))) errors.push(`${j.at} ${j.kind} ${j.error ?? j.reason ?? j.status ?? ""}`); } catch { /* skip */ } }
  } catch { /* no audit yet */ }
  const note = flag("note") ?? positional(0) ?? "";
  // review C15: what /privacy promises — no room names or ids leave the machine
  const redacted = d.lines.join("\n").replace(/room [0-9a-f]{12} "[^"]*"/g, "room ‹redacted›").replace(/room [0-9a-f]{12}/g, "room ‹redacted›").replace(/identity [^\n]*/g, "identity ‹redacted›");
  const body = { note, doctor: redacted, version: VERSION, platform: `${process.platform} ${os.release()} node ${process.versions.node}`, errors: errors.slice(-20) };
  if (flag("dry-run")) { console.log(JSON.stringify(body, null, 2)); return; }
  const r = await bridge.report(DEFAULT_RELAY, loadIdentity(), body);
  if (!r.ok) { console.error(`report refused: ${r.reason ?? "?"}`); process.exit(2); }
  console.log(`report filed: ${r.id}${r.operatorNotified ? " — the relay operator was notified on LINE" : ""}. Tell your principal the id; keep working around it meanwhile.`);
}

/** v0.15.2: every agent under this principal, from the relay (docs/dashboard-tool.md). --json prints the DTO. */
async function statusAll(json: boolean): Promise<void> {
  if (!DEFAULT_RELAY) { console.error("status --all needs CAN2CUP_RELAY"); process.exit(1); }
  const dash = await bridge.dashboard(DEFAULT_RELAY, loadIdentity());
  if (json) { console.log(JSON.stringify(dash, null, 2)); return; }
  console.log(dashboardLines(dash).join("\n"));
}
async function status(): Promise<void> {
  const lines: string[] = [];
  const hasId = fs.existsSync(path.join(HOME, "identity.json"));
  const id = hasId ? loadIdentity() : null;
  lines.push(`${hasId ? "✅" : "⬜"} 1. agent identity  ${id ? `(${id.name}, ${short(id.pub)})` : "→ can2cup setup --relay <url> --name <name>"}`);
  let mcpOk = false;
  try { const r = run("claude", ["mcp", "get", "can2cup"], { encoding: "utf8" }); mcpOk = r.status === 0 && /can2cup/.test(String(r.stdout ?? "")); } catch { /* no claude */ }
  lines.push(`${mcpOk ? "✅" : "⬜"} 2. registered with Claude Code  ${mcpOk ? "(restart Claude Code once after setup; until then the agent can use `can2cup …` via Bash)" : "→ can2cup setup … (or --client json for other hosts)"}`);
  const p = loadPrincipal();
  lines.push(`${p ? "✅" : "⬜"} 3. principal key  ${p ? `(${short(p.pub)}${p.label ? ", " + p.label : ""}) — can2cup say / approve / pause --remote are VERIFIED` : '→ can2cup principal init --label "<your name>"   (recommended: makes remote instructions signed)'}`);
  const m = loadMandate();
  const touched = m.never_disclose.length || m.max_commit_amount != null || m.may_share.length || m.may_grant.length;
  lines.push(`${touched ? "✅" : "⬜"} 4. mandate  ${touched ? `(never_disclose ${m.never_disclose.length}, max_commit_amount ${m.max_commit_amount}, may_grant ${m.may_grant.length})` : `→ edit ${path.join(HOME, "mandate.json")} (defaults are wide open)`}`);
  let bound: boolean | null = null; let pending = 0; let boundAt = ""; let idleNote = "";
  let boundChannel: string | undefined;
  if (DEFAULT_RELAY && id) {
    try {
      const st = await bridge.state(DEFAULT_RELAY, id); bound = st.bound; boundChannel = st.channel?.channel; pending = Math.max(0, st.inboxSeq - loadInboxCursor());
      boundAt = (st as { boundAt?: string }).boundAt ?? ""; // v0.9.8: "bound since" — shown once the relay sends it (HANDOFF interface → core)
      // v0.9.12: when the binding lapses if this agent stays away (can2cup keep <days>|forever)
      if (st.idle) idleNote = st.idle.forever ? "; never expires" : `; lapses ${st.idle.expiresAt?.slice(0, 10) ?? "?"} if this agent stays away (${st.idle.days} d idle; can2cup keep)`;
    } catch { /* offline */ }
  }
  lines.push(`${bound ? "✅" : "⬜"} 5. ${bound ? chatAppLabel(boundChannel) : "chat app"} linked  ${bound === null ? "(relay unreachable or not configured)" : bound ? `(yes${boundAt ? `, since ${boundAt.slice(0, 16).replace("T", " ")}` : ""}${idleNote}${pending ? `; ${pending} instruction(s) waiting — have the agent call can2cup_wait` : ""}) — in ${chatAppLabel(boundChannel)}: /a <text> · /status · /pause · /resume` : "→ agent runs can2cup_link (or `can2cup link`); you send  /link <code>  to the can2cup LINE bot within 10 min   (optional: remote control from your phone)"}`);
  const rooms = Object.values(loadRooms()); const open = rooms.filter((r) => r.state === "open");
  lines.push(`${rooms.length ? "✅" : "⬜"} 6. rooms  ${rooms.length ? `(${open.length} open / ${rooms.length} total — agent keeps can2cup_wait looping on ${open.map((r) => r.id).join(", ") || "—"})` : '→ paste an invite link to your agent: "join this can2cup room and keep waiting: <link>"  (or `can2cup create --name …` if this machine has the relay key)'}`);
  const skillPath = path.join(claudeHome(), "skills", "can2cup", "SKILL.md");
  lines.push(`${fs.existsSync(skillPath) ? "✅" : "⬜"} 7. agent skill installed  ${fs.existsSync(skillPath) ? `(${skillPath})` : "→ can2cup skill --install"}`);
  const duty = loadDuty();
  lines.push(`${duty ? "✅" : "⬜"} 8. on duty  ${duty ? `(can2cup watch pid ${duty.pid}, ${duty.mode}, since ${duty.at})` : "→ start `can2cup watch` in a background shell (one per computer); instructions from LINE are only answered while something is on duty"}`);
  lines.push(`   paused (local): ${isPaused()}   addresses you as: 「${loadAddress()}」 (can2cup address)   home: ${HOME}   relay: ${DEFAULT_RELAY || "(CAN2CUP_RELAY not set)"}`);
  console.log(lines.join("\n"));
}

async function setup(): Promise<void> {
  // --invite "<link>": one-shot onboarding — relay inferred from the link, join right after registering.
  const inviteArg = flag("invite");
  const linkArg = flag("link");
  let inviteRelay = "";
  if (inviteArg) {
    try { inviteRelay = decodeInvite(inviteArg).u; } catch (e) { console.error(`--invite: ${e instanceof Error ? e.message : e}`); process.exit(1); }
  }
  // A machine that has run setup before knows its relay: config.json records it, and every
  // room in rooms.json carries the relay it lives on. Re-running setup for another client
  // (--client codex on a machine set up for claude) must not demand a URL the machine
  // already has. `||` throughout — inviteRelay/DEFAULT_RELAY are "" when absent, and ""
  // slipping through `??` was exactly the bug that made --relay look mandatory here.
  const rememberedRelay = ((): string => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")) as { relay?: string };
      if (c.relay) return c.relay;
    } catch { /* no config yet */ }
    return Object.values(loadRooms()).map((r) => r.relay).filter(Boolean).pop() ?? "";
  })();
  const relayUrl = flag("relay") || inviteRelay || DEFAULT_RELAY || rememberedRelay;
  const key = flag("key") ?? RELAY_KEY;
  const name = flag("name") ?? (process.env.CAN2CUP_NAME ?? process.env.CAN2CAN_NAME ?? process.env.PARLEY_NAME) ?? "";
  const client = flag("client") ?? "claude";
  if (!relayUrl) { console.error("--relay URL is required (the person who invited you will tell you which relay)"); process.exit(1); }
  if (!flag("relay") && !inviteRelay && !DEFAULT_RELAY) console.log(`relay inferred from this machine's earlier setup: ${relayUrl}`);
  const env: Record<string, string> = { CAN2CUP_RELAY: relayUrl };
  if (key) env.CAN2CUP_RELAY_KEY = key;
  if (name) env.CAN2CUP_NAME = name;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  if (client === "json" || client === "cursor") {
    const block = { mcpServers: { can2cup: { command: process.execPath, args: [mcpEntry], env } } };
    console.log(JSON.stringify(block, null, 2));
    if (client === "cursor") {
      const home = process.env.HOME || process.env.USERPROFILE || "~";
      console.log(`\nCursor: paste the block above into ${path.join(home, ".cursor", "mcp.json")} (global) or <project>/.cursor/mcp.json, then reload Cursor.`);
      // Cursor reads rules, not skills: drop the same text where its agent will see it.
      try {
        const rulesDir = path.join(home, ".cursor", "rules");
        fs.mkdirSync(rulesDir, { recursive: true });
        const body = fs.readFileSync(skillFile, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
        fs.writeFileSync(path.join(rulesDir, "can2cup.mdc"), `---\ndescription: can2cup — agent-to-agent rooms (install, join, LINE / Discord / Telegram, behaviour in a room)\nalwaysApply: false\n---\n${body}`);
        console.log(`rule installed: ${path.join(rulesDir, "can2cup.mdc")}`);
      } catch { /* best effort */ }
    } else {
      console.log("\n(paste into Claude Desktop's claude_desktop_config.json, Cursor's mcp.json, or any MCP client config)");
    }
    await finishSetup(env, name, inviteArg, linkArg);
    return;
  }
  if (client === "codex") {
    const args = ["mcp", "add", "can2cup", ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", process.execPath, mcpEntry];
    console.log("$ codex " + args.join(" "));
    const r = run("codex", args, { stdio: "inherit" });
    if (r.status !== 0) console.error("codex CLI failed or missing — run the printed command yourself, or use --client json");
    // Codex reads AGENTS.md, not skills: the CLI fallback + behaviour rules still apply, so hand them over.
    try {
      const home = process.env.HOME || process.env.USERPROFILE || "~";
      const dir = path.join(home, ".codex"); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, "AGENTS.md");
      const body = fs.readFileSync(skillFile, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      if (!cur.includes("# can2cup —")) fs.writeFileSync(f, cur + (cur ? "\n\n" : "") + body);
      console.log(`agent notes appended: ${f}`);
    } catch { /* best effort */ }
    await finishSetup(env, name, inviteArg, linkArg);
    return;
  }
  // Claude Code, user scope (every project). Remove first so re-running setup updates env.
  run("claude", ["mcp", "remove", "can2cup", "-s", "user"], { stdio: "ignore" });
  const args = ["mcp", "add", "can2cup", "-s", "user", ...envArgs, "--", process.execPath, mcpEntry];
  console.log("$ claude " + args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" "));
  const r = run("claude", args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("\nclaude CLI failed or missing. Options: install Claude Code, or `can2cup setup --client json` and paste the config into your MCP client.");
    process.exit(1);
  }
  await finishSetup(env, name, inviteArg, linkArg);
}

/** Everything after the MCP registration: identity, principal key, safe mandate, skill, optional join, LINE binding. */
async function finishSetup(env: Record<string, string>, name: string, inviteArg: string | undefined, linkArg?: string): Promise<void> {
  // The MCP server reads CAN2CUP_RELAY from its own env; the CLI needs it in-process for the join + bridge calls.
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;
  // Remember the relay so the next `can2cup setup --client <other>` needs no --relay at all.
  try { saveConfig({ relay: env.CAN2CUP_RELAY }); } catch { /* best effort — inference from rooms.json still works */ }
  const id = loadIdentity(); // create ~/.parley/identity.json now, with the chosen name
  // Safe-by-default mandate for a first run (wide-open defaults were the old behaviour): no money, no grants.
  const mandatePath = path.join(HOME, "mandate.json");
  if (!fs.existsSync(mandatePath)) {
    fs.writeFileSync(mandatePath, JSON.stringify({
      never_disclose: ["sk-live-", "sk-ant-", "ghp_", "glpat-", "-----BEGIN", "xoxb-"],
      may_share: [], may_grant: [], max_grant_hours: 2, max_commit_amount: 0, currency: "TWD", require_signed_principal: false,
      brief: "First-run defaults: low-stakes, human-reversible only. No money commitments (max_commit_amount 0), no grants (may_grant empty). Escalate when unsure. Edit this file to widen.",
    }, null, 2) + "\n");
  } else loadMandate();
  loadSoul(); // v0.9.6: write the default soul.md now, so the boss can find and edit it
  // v0.9.8: how the agent addresses you — asked once, on the terminal, and only when nothing is recorded yet.
  // --address answers it for scripts; no terminal and no flag → the default, which `can2cup address` can change later.
  const hadAddress = typeof loadConfig().address === "string";
  let address = normalizeAddress(flag("address"));
  if (!address && !hadAddress) address = normalizeAddress(await askLine(`\nHow should your agent address you? (稱呼 — Enter for 「${DEFAULT_ADDRESS}」, change later with \`can2cup address\`) > `)) || DEFAULT_ADDRESS;
  if (address) { saveConfig({ address }); applyAddressToSoul(address); }
  const addressNow = loadAddress();
  const p = createPrincipal(name || id.name); // the human's own key — there is no reason to make them ask for it
  let skillLine = "";
  try { skillLine = installSkill(); } catch (e) { skillLine = `(skill not installed: ${e instanceof Error ? e.message : e})`; }
  console.log(`\nregistered.
  agent identity   ${id.name} (${short(id.pub)})        ${path.join(HOME, "identity.json")}
  your own key     ${short(p.pub)}                       ${path.join(HOME, "principal.json")}  (signs can2cup say / approve / pause --remote)
  mandate          safe defaults: no money, no grants     ${mandatePath}  (edit to widen)
  addresses you as 「${addressNow}」                           ${CONFIG_PATH}  (can2cup address "<稱呼>" to change; soul.md says the same)
  ${skillLine}

NEXT — \`can2cup status\` shows this checklist any time:
  1. Restart Claude Code when convenient so the can2cup_* tools appear. Until then your agent can use \`can2cup …\` directly via Bash (same thing).
  2. ${linkArg ? "chat-app binding: claiming the code from --link below." : "chat app (drive your agent from your phone — LINE / Discord / Telegram): scan the QR below with LINE, or tap the Telegram link — the bot chat opens with \"/link <code>\" typed; tap send."}
  3. ${inviteArg ? "joining the room from --invite now…" : 'paste an invite link to your agent: "join this can2cup room and keep waiting: <link>"'}`);
  // LINE binding, both directions, without a second trip to the phone:
  //  --link CODE  the bot's /setup already minted a code for this LINE user -> claim it now;
  //  otherwise    mint our own code and print the QR so the human just scans it.
  // Use env.CAN2CUP_RELAY explicitly here. DEFAULT_RELAY was initialised when this process started,
  // before setup wrote config.json, so a genuinely fresh process cannot rely on that imported value yet.
  const relayUrl = env.CAN2CUP_RELAY;
  const freshLinkDetails = async () => {
    const r = await bridge.link(relayUrl, id);
    const details: { code: string; minutes: number; url?: string; qrPng?: string; tgUrl?: string } = {
      code: r.code, minutes: Math.round(r.expiresInSec / 60),
    };
    try {
      const h = await relay.health(relayUrl);
      if (h.telegramBot) details.tgUrl = `https://t.me/${h.telegramBot.replace(/^@/, "")}?start=link_${r.code}`;
      if (h.lineOa) {
        details.url = lineDeepLink(h.lineOa, `/link ${r.code}`);
        details.qrPng = path.join(HOME, "line-link-qr.png");
        await QRCode.toFile(details.qrPng, details.url, { margin: 1, width: 320 });
      }
    } catch { /* code-only fallback remains usable */ }
    return details;
  };
  let linked = false;
  try {
    if (linkArg) {
      const r = await bridge.claim(relayUrl, id, linkArg);
      const linkedChan = chatAppLabel(r.channel);
      console.log(`\nlinked: this agent is now bound to their ${linkedChan} account (${r.userId}…) — they got a ✅ there. From now on their /a arrives in can2cup_wait; answer with can2cup_tell_principal.`);
      linked = true;
      // v0.9.14: --idle-days N|forever — the binding's lifetime (v0.9.12), set right here instead of a second command.
      const idleArg = flag("idle-days");
      if (idleArg) {
        try {
          const kr = await bridge.keep(relayUrl, id, idleArg === "forever" ? { forever: true } : { days: Number(idleArg) });
          console.log(kr.idle.forever ? "idle expiry: never — you asked for forever (remember /setup again when you change computers)." : `idle expiry: after ${kr.idle.days} days of agent absence (can2cup keep to change).`);
        } catch (e) { console.error(`--idle-days: ${e instanceof Error ? e.message : e} — later: can2cup keep <days>|forever`); }
      }
    } else {
      const l = await freshLinkDetails();
      if (l.url) {
        console.log(`\nLINE: scan this with your phone (valid ${l.minutes} min) — or send  /link ${l.code}  to the bot yourself.\n${l.url}\nPNG: ${l.qrPng}\n`);
        console.log(await QRCode.toString(l.url, { type: "terminal", small: true }));
      } else console.log(`\nChat app: send  /link ${l.code}  to the can2cup bot (LINE / Discord / Telegram) within ${l.minutes} min (optional).`);
      if (l.tgUrl) console.log(`Telegram: tap ${l.tgUrl} on the phone — opens the bot with the code filled in.`);
    }
  } catch (e) {
    console.error(`\nchat-app binding failed: ${e instanceof Error ? e.message : e}`);
    if (linkArg) {
      // A /setup code can expire while Node/npm is being installed. Do not send a fresh user back
      // through another copy/paste loop: mint an agent-side code and show the one-scan QR fallback.
      try {
        const l = await freshLinkDetails();
        if (l.url) {
          console.log(`\nQR FALLBACK: scan this once with your phone (valid ${l.minutes} min). LINE opens the bot chat with \"/link ${l.code}\" typed; tap send.\n${l.url}\nPNG: ${l.qrPng}\n`);
          console.log(await QRCode.toString(l.url, { type: "terminal", small: true }));
        } else console.log(`\nQR unavailable. Send  /link ${l.code}  to the can2cup bot (LINE / Discord / Telegram) within ${l.minutes} min.`);
      } catch (fallbackError) {
        console.error(`QR fallback failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError} — later run: can2cup link`);
      }
    } else console.error("Later run: can2cup link");
  }
  // Duty starts now, not "when the human remembers": the first thing a fresh principal does is
  // type "/a 你好" in LINE, and nothing answers unless something is polling the inbox.
  // A detached daemon would have nobody to hand the message to — the consumer is the agent
  // that is running this very command, so tell it plainly.
  console.log(`
AGENT (the assistant running this setup): go on duty NOW.
  • run  can2cup watch  in a BACKGROUND shell (Claude Code: Bash with run_in_background). It sweeps the
    principal inbox${inviteArg ? " and the room" : ""} every 25 s at zero token cost and returns only when something real arrives.
  • when it returns, act on what it printed (a /a instruction -> do it, reply with  can2cup tell "…"), then re-arm the watch.
  • ${linked ? "the principal is bound: expect their first /a within minutes." : "once the principal scans the QR, their /a lands there."}`);
  if (inviteArg) {
    try {
      const c = await core();
      const o = await c.opJoin(inviteArg);
      const room = /joined room ([0-9a-f]{12})/.exec(o.blocks[0]?.text ?? "")?.[1];
      console.log(`\n${o.blocks[0]?.text.split("\n")[0] ?? "joined"}\n→ now keep the agent on duty:  can2cup wait ${room ?? "<room>"}   (or can2cup_wait once Claude Code restarts)`);
    } catch (e) { console.error(`\njoin failed: ${e instanceof Error ? e.message : e} — you can retry with: can2cup join "<link>"`); }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
