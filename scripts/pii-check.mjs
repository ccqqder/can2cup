// Refuse to commit or publish text that should never leave a maintainer's machine: home-directory paths (which
// carry the user name), e-mail addresses, chat-platform user ids, bot tokens, private keys.
//   node scripts/pii-check.mjs              # the staged diff (pre-commit; see .githooks/pre-commit)
//   node scripts/pii-check.mjs --tree       # every tracked text file (CI, before a release)
// Generic patterns live here. Each maintainer adds their own (an employee id, a hostname, a real name) to a file
// OUTSIDE the repository — $CAN2CUP_PII_PATTERNS, default ~/.can2cup-release/pii-patterns.txt, one JS regex per
// line, `#` comments — so the check script itself never names what it is protecting.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GENERIC = [
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/, "Windows home path"],
  [/(?<![\w./-])\/Users\/[^/\s"'`]+/, "macOS home path"],
  [/(?<![\w./-])\/home\/[^/\s"'`]+/, "Linux home path"],
  [/[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|proton(mail)?|qq|163)\.com/i, "personal e-mail"],
  [/\bU[0-9a-f]{32}\b/, "LINE user id"],
  [/\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/, "Telegram bot token"],
  [/\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/, "Discord bot token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
  [/\b(sk|rnd|npm|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, "API token"],
  [/(RELAY_SIGNING_KEY|BRIDGE_KEY|RELAY_KEY|LINE_CHANNEL_(SECRET|ACCESS_TOKEN)|DISCORD_BOT_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|OPERATOR_LINE_USER_ID)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{24,}/, "secret assignment"],
];

// Files that legitimately carry hashes, ids or third-party text and are not ours to rewrite.
const SKIP = [/^package-lock\.json$/, /^relay-assets\/dl\//, /^node_modules\//, /^dist\//, /\.(png|jpg|jpeg|gif|ico|tgz|sqlite)$/i];
// Known throwaways, documented where they live (dev keys that verify only a local wrangler dev).
const ALLOW = [/devtelegramsecret0000/, /ce53d70c9973b866965929632fc72f5da94eaaa53338cb637fc6253193240cb8/];

function personal() {
  const p = process.env.CAN2CUP_PII_PATTERNS ?? join(homedir(), ".can2cup-release", "pii-patterns.txt");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => [new RegExp(l, "i"), "personal pattern"]);
}

const sh = (a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const tree = process.argv.includes("--tree");
const patterns = [...GENERIC, ...personal()];
const hits = [];

if (tree) {
  for (const f of sh(["ls-files"]).split("\n").filter(Boolean)) {
    if (SKIP.some((r) => r.test(f))) continue;
    let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => scan(f, i + 1, line));
  }
} else {
  let file = null, line = 0;
  for (const l of sh(["diff", "--cached", "-U0", "--no-color"]).split("\n")) {
    if (l.startsWith("+++ b/")) { file = l.slice(6); continue; }
    if (l.startsWith("+++ ") || l.startsWith("--- ")) { file = null; continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l); if (m) { line = Number(m[1]); continue; }
    if (!file || !l.startsWith("+")) continue;
    if (!SKIP.some((r) => r.test(file))) scan(file, line, l.slice(1));
    line++;
  }
}

function scan(file, n, text) {
  if (ALLOW.some((r) => r.test(text))) return;
  for (const [re, what] of patterns) {
    const m = re.exec(text);
    // Location and kind only. Echoing the match would copy it into terminal scrollback, CI logs and any
    // agent's context, which is exactly where a personal pattern must never appear.
    if (m) hits.push(`${file}:${n}: ${what}`);
  }
}

if (hits.length) {
  console.error(`pii-check: ${hits.length} hit(s) — nothing here may be committed or published:\n  ${hits.join("\n  ")}`);
  console.error("If a hit is a documented throwaway, add it to ALLOW in scripts/pii-check.mjs with a comment saying why.");
  process.exit(1);
}
console.log(`pii-check: clean (${tree ? "tracked tree" : "staged diff"}, ${patterns.length} patterns)`);
