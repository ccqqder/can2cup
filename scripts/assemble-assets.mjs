// Write a complete static-assets directory for a relay: the generic files from this repository, the documents it
// generates, the install files, and a deployment's own overlay on top.
//
//   node scripts/assemble-assets.mjs --out <dir> [--overlay <dir>] [--dl <dir>]
//
//   generic    relay-assets/{favicon.ico, apple-touch-icon.png, changelog.txt, known-issues.json}
//   generated  skill.md from SKILL.md, selfhost.md from docs/SELF-HOST.md
//   dl/        from --dl (default relay-assets/dl) when it exists — the signed install files (stage-tarball.mjs,
//              release-sign.mjs or mirror-dl.mjs wrote them)
//   overlay    every file under --overlay, copied on top: a deployment's guide, privacy page, llms.txt, icons…
//              known-issues.json is MERGED (both `issues` lists; an id may not appear twice) instead of replaced;
//              dl/ may not come from the overlay (one source for the signed files)
//
// Static assets are served BEFORE the Worker, so a file whose path is also a Worker route would silently take that
// route over (a root index.html would answer GET / for every client). Those are refused: the route list is read from
// src/relay/index.ts and the chat-app webhook paths from src/relay/channels.ts. <out> must be new or empty.
// Prints a sha256 listing of what it wrote. Exit 1 on any refusal, 2 on a usage error.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inRoot = (p) => path.join(ROOT, p);
const argv = process.argv.slice(2);
const usage = () => { console.error("usage: node scripts/assemble-assets.mjs --out <dir> [--overlay <dir>] [--dl <dir>]"); process.exit(2); };
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) usage();
  return argv[i + 1];
};
for (const a of argv) if (a.startsWith("--") && !["--out", "--overlay", "--dl"].includes(a)) { console.error(`unknown option ${a}`); usage(); }
const OUT = opt("--out") ? path.resolve(opt("--out")) : usage();
const OVERLAY = opt("--overlay") ? path.resolve(opt("--overlay")) : undefined;
const DL = path.resolve(opt("--dl") ?? inRoot("relay-assets/dl"));
const refuse = (msg) => { console.error(`assemble-assets: ${msg}`); process.exit(1); };

// ---- the Worker's routes: every top-level path segment the Worker answers under ----
const reserved = new Map(); // lower-case first segment → a route that lives there
{
  const index = fs.readFileSync(inRoot("src/relay/index.ts"), "utf8");
  const channels = fs.readFileSync(inRoot("src/relay/channels.ts"), "utf8");
  const paths = [
    ...[...index.matchAll(/^\s*app\.(?:get|post|put|patch|delete|all|on|use)\(\s*"(\/[^"]*)"/gm)].map((m) => m[1]),
    ...[...channels.matchAll(/webhookPath:\s*"(\/[^"]+)"/g)].map((m) => m[1]),
  ];
  for (const p of paths) {
    const seg = p.split("/")[1];
    if (seg && !reserved.has(seg.toLowerCase())) reserved.set(seg.toLowerCase(), p);
  }
  // a floor, so a refactor that moves route declarations out of reach of the regex fails loudly instead of open
  for (const seg of ["terms", "j", "mcp", "oauth", "p", "rooms", "f", "bridge", "line", "discord", "telegram", ".well-known"]) {
    if (!reserved.has(seg)) refuse(`could not find the /${seg} route in src/relay/index.ts or channels.ts — update this script's route reading before assembling`);
  }
}
/** The Worker route a static file at `rel` (posix, relative to the assets root) would shadow, or undefined. */
function shadows(rel) {
  const parts = rel.split("/");
  const lower = parts.map((s) => s.toLowerCase());
  if (lower.length === 1 && /^index\.html?$/.test(lower[0])) return "/";
  // /terms is answered by terms, terms.html or terms/index.html alike (Cloudflare's html_handling)
  const first = lower.length === 1 ? lower[0].replace(/\.html?$/, "") : lower[0];
  return reserved.get(first);
}

// ---- the plan: relative path → { from } | { data } ----
const plan = new Map();
const walk = (dir, prefix = "") => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push([rel, abs]);
    else refuse(`${abs} is neither a file nor a directory (symlinks are not followed)`);
  }
  return out;
};
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

for (const f of ["favicon.ico", "apple-touch-icon.png", "changelog.txt", "known-issues.json"]) plan.set(f, { from: inRoot(`relay-assets/${f}`), origin: "relay-assets" });
plan.set("skill.md", { from: inRoot("SKILL.md"), origin: "generated from SKILL.md" });
plan.set("selfhost.md", { from: inRoot("docs/SELF-HOST.md"), origin: "generated from docs/SELF-HOST.md" });
for (const [, v] of plan) if (!fs.existsSync(v.from)) refuse(`${v.from} is missing`);

if (fs.existsSync(DL)) {
  if (!fs.statSync(DL).isDirectory()) refuse(`--dl ${DL} is not a directory`);
  const files = walk(DL);
  for (const [rel, abs] of files) plan.set(`dl/${rel}`, { from: abs, origin: "dl" });
  const names = new Set(files.map(([rel]) => rel));
  // The tarballs are gitignored while VERSION, VERSION.sha256 and the manifest are tracked: a fresh clone has the
  // metadata without the file it describes, and the relay would advertise an install URL that answers 404.
  const meta = ["VERSION", "VERSION.sha256", "manifest.json", "manifest.sig"].filter((n) => names.has(n));
  if (meta.length && !names.has("can2cup.tgz")) refuse(`${DL} has ${meta.join(", ")} but no can2cup.tgz — the tarballs are not in git; fetch them with scripts/mirror-dl.mjs, or pass a --dl without install files`);
  if (names.has("VERSION.sha256")) {
    for (const l of fs.readFileSync(path.join(DL, "VERSION.sha256"), "utf8").split("\n").filter((x) => x.trim())) {
      const m = /^([0-9a-f]{64}) {2}(\S+)\r?$/.exec(l);
      if (!m) refuse(`${DL}/VERSION.sha256 has a malformed line`);
      if (!names.has(m[2])) refuse(`${DL}/VERSION.sha256 lists ${m[2]}, which is not there`);
      if (createHash("sha256").update(fs.readFileSync(path.join(DL, m[2]))).digest("hex") !== m[1]) refuse(`${DL}/${m[2]} does not match its line in VERSION.sha256`);
    }
  }
  if (!names.has("manifest.json") || !names.has("manifest.sig")) console.warn(`note: ${DL} has no signed manifest (manifest.json + manifest.sig) — clients will refuse \`can2cup upgrade\` from this relay`);
} else if (opt("--dl")) refuse(`--dl ${DL} does not exist`);
else console.warn(`note: ${DL} does not exist — no dl/ (install and upgrade files) in the output`);

if (OVERLAY) {
  if (!fs.existsSync(OVERLAY) || !fs.statSync(OVERLAY).isDirectory()) refuse(`--overlay ${OVERLAY} is not a directory`);
  if (inside(OUT, OVERLAY) || inside(OVERLAY, OUT)) refuse("--out and --overlay must not contain each other");
  for (const [rel, abs] of walk(OVERLAY)) {
    if (rel.split("/")[0].toLowerCase() === "dl") refuse(`overlay file ${rel}: dl/ comes from --dl only (the signed install files have one source)`);
    if (rel === "known-issues.json") {
      const load = (file) => {
        let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { refuse(`${file} is not valid JSON: ${e.message}`); }
        if (!j || typeof j !== "object" || !Array.isArray(j.issues)) refuse(`${file} has no \`issues\` array`);
        for (const x of j.issues) if (!x || typeof x.id !== "string" || !x.id) refuse(`${file}: every issue needs a string \`id\``);
        return j;
      };
      const base = load(plan.get(rel).from);
      const over = load(abs);
      const seen = new Map();
      for (const [src, list] of [["relay-assets/known-issues.json", base.issues], [abs, over.issues]]) {
        for (const x of list) { if (seen.has(x.id)) refuse(`known-issues.json: id ${x.id} appears in both ${seen.get(x.id)} and ${src} (or twice in one) — overlay ids must not collide`); seen.set(x.id, src); }
      }
      const { issues: _b, ...baseRest } = base;
      const { issues: _o, ...overRest } = over;
      const updated = [base.updated, over.updated].filter((u) => typeof u === "string").sort().pop();
      const merged = { ...baseRest, ...overRest, ...(updated ? { updated } : {}), issues: [...base.issues, ...over.issues] };
      plan.set(rel, { data: JSON.stringify(merged, null, 2) + "\n", origin: `merged: relay-assets + overlay (${base.issues.length} + ${over.issues.length} issues)` });
      continue;
    }
    if (plan.has(rel)) console.warn(`note: the overlay replaces ${rel} (${plan.get(rel).origin})`);
    plan.set(rel, { from: abs, origin: "overlay" });
  }
}

// ---- refuse anything that would shadow a Worker route ----
const shadowing = [...plan.entries()].map(([rel, v]) => [rel, v, shadows(rel)]).filter(([, , r]) => r);
if (shadowing.length) {
  for (const [rel, v, r] of shadowing) console.error(`assemble-assets: ${rel} (${v.origin}) would shadow the Worker route ${r}`);
  refuse("static assets are served before the Worker; rename or remove these files");
}

// ---- write ----
if (inside(OUT, inRoot("relay-assets")) || inside(inRoot("relay-assets"), OUT) || inside(OUT, DL)) refuse(`--out ${OUT} must be outside relay-assets and the dl source`);
if (fs.existsSync(OUT) && (!fs.statSync(OUT).isDirectory() || fs.readdirSync(OUT).length)) refuse(`--out ${OUT} exists and is not an empty directory`);
for (const [rel, v] of [...plan.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const dest = path.join(OUT, ...rel.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (v.from) fs.copyFileSync(v.from, dest); else fs.writeFileSync(dest, v.data);
}
const listing = walk(OUT).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([rel, abs]) => `${createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}  ${rel}`);
console.log(listing.join("\n"));
console.log(`assemble-assets: ${listing.length} file(s) → ${OUT}`);
