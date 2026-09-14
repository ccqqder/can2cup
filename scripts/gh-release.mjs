// Create (or refresh) the GitHub Release for a tag, with that version's entry from relay-assets/changelog.txt as
// the body, so the tags page is never empty and the release notes and the served changelog cannot drift.
//   node scripts/gh-release.mjs v0.16.1            # one tag
//   node scripts/gh-release.mjs --all              # every v* tag that has no release yet
//   node scripts/gh-release.mjs v0.16.1 --force    # overwrite an existing release's notes (and re-upload its assets)
//   options:  --dl <dir>     the signed install files to attach (default relay-assets/dl)
//             --no-assets    notes only
// Needs `gh` logged in. A tag whose version has no changelog heading of its own (built but never published alone,
// folded into the next entry) gets a one-line body saying so.
//
// Release assets: when <dl>/manifest.json is for the tag's version, manifest.json, manifest.sig, VERSION.sha256 and
// changelog.txt are attached to the release (gh release upload --clobber) — that is what scripts/mirror-dl.mjs reads,
// so a fork or a self-hosted relay can mirror a release without the key, and what `can2cup upgrade` reads when a relay
// does not mirror /dl. They are checked first: the signature must verify against RELEASE_PUBS (dist/, so build first),
// VERSION.sha256 must agree with the manifest, and changelog.txt must have the manifest's changelogSha256 (the working
// copy, else the copy at the tag); otherwise nothing is attached and the script exits 1. A tag whose version is not
// the one in <dl> gets notes only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const force = args.includes("--force");
const all = args.includes("--all");
const noAssets = args.includes("--no-assets");
const dlIdx = args.indexOf("--dl");
if (dlIdx >= 0 && (!args[dlIdx + 1] || args[dlIdx + 1].startsWith("--"))) { console.error("--dl needs a directory"); process.exit(2); }
const DL = dlIdx >= 0 ? resolve(args[dlIdx + 1]) : fileURLToPath(new URL("../relay-assets/dl", import.meta.url));
const tags = args.filter((a, i) => a.startsWith("v") && i !== dlIdx + 1);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repoSpec = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ?? "";
const repoMatch = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoSpec);
const repoUrl = repoMatch ? `https://github.com/${repoMatch[1]}/${repoMatch[2]}` : undefined;

const changelog = readFileSync(new URL("../relay-assets/changelog.txt", import.meta.url), "utf8");
/** version → { date, body } from `## <version> — <date>` headings (newest first) */
const entries = new Map();
const re = /^## ([^\n]+?) — ([^\n]+)$/gm;
const heads = [...changelog.matchAll(re)];
heads.forEach((m, i) => {
  const end = i + 1 < heads.length ? heads[i + 1].index : changelog.length;
  const body = changelog.slice(m.index + m[0].length, end).trim();
  for (const v of m[1].split(/[–-]/).map((s) => s.trim())) entries.set(v, { date: m[2].trim(), body, heading: m[1] });
});

/** The asset files for version v, verified — or undefined when <dl> is for another version. Exits on a bad signature. */
async function releaseAssets(v) {
  const file = (n) => join(DL, n);
  if (!existsSync(file("manifest.json"))) return undefined;
  const manifest = JSON.parse(readFileSync(file("manifest.json"), "utf8"));
  if (manifest.version !== v) return undefined;
  for (const n of ["manifest.sig", "VERSION.sha256"]) if (!existsSync(file(n))) { console.error(`${DL} has manifest.json for ${v} but no ${n} — sign (release-sign.mjs) before creating the release`); process.exit(1); }
  const { verifyManifest, RELEASE_PUBS } = await import("../dist/protocol/index.js");
  const verdict = verifyManifest(manifest, readFileSync(file("manifest.sig"), "utf8").trim(), RELEASE_PUBS);
  if (!verdict.ok) { console.error(`${DL}/manifest.json for ${v}: ${verdict.reason} — not attaching it`); process.exit(1); }
  for (const l of readFileSync(file("VERSION.sha256"), "utf8").split("\n").filter((x) => x.trim())) {
    const m = /^([0-9a-f]{64}) {2}(\S+)\r?$/.exec(l);
    if (!m || manifest.files[m[2]] !== m[1]) { console.error(`${DL}/VERSION.sha256 disagrees with the signed manifest (${l.slice(0, 90)}) — not attaching it`); process.exit(1); }
  }
  // `can2cup upgrade` reads the `!!` lines of every release in between only from a changelog whose sha256 is the
  // manifest's changelogSha256. The working copy may have moved on since staging, so the copy at the tag is the other
  // candidate; attaching one that does not match would only make every client stop for --yes.
  const files = ["manifest.json", "manifest.sig", "VERSION.sha256"].map(file);
  if (!manifest.changelogSha256) { console.error(`${DL}/manifest.json for ${v} carries no changelogSha256 — attaching it without changelog.txt`); return files; }
  const candidates = [
    ["relay-assets/changelog.txt", () => readFileSync(CHANGELOG_FILE)],
    [`relay-assets/changelog.txt at tag v${v}`, () => execFileSync("git", ["show", `v${v}:relay-assets/changelog.txt`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 })],
  ];
  for (const [label, read] of candidates) {
    let bytes;
    try { bytes = read(); } catch { continue; }
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.changelogSha256) continue;
    const d = join(dir, `v${v}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "changelog.txt"), bytes);
    console.log(`changelog.txt for ${v}: ${label} (sha256 matches the signed manifest)`);
    return [...files, join(d, "changelog.txt")];
  }
  console.error(`neither relay-assets/changelog.txt nor its copy at tag v${v} has the signed manifest's changelogSha256 (${String(manifest.changelogSha256).slice(0, 12)}…) — not attaching anything`);
  process.exit(1);
}
const CHANGELOG_FILE = fileURLToPath(new URL("../relay-assets/changelog.txt", import.meta.url));

const existing = new Set(sh("gh", ["release", "list", "--limit", "200", "--json", "tagName", "-q", ".[].tagName"]).split("\n").filter(Boolean));
const wanted = all ? sh("git", ["tag", "--list", "v*", "--sort=creatordate"]).split("\n").filter(Boolean) : tags;
if (!wanted.length) { console.error("usage: node scripts/gh-release.mjs v<version> | --all [--force] [--dl <dir>] [--no-assets]"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "can2cup-rel-"));
for (const tag of wanted) {
  const v = tag.replace(/^v/, "");
  const e = entries.get(v);
  const has = existing.has(tag);
  if (has && !force) { console.log(`skip ${tag} (release exists; --force to rewrite)`); continue; }
  const source = repoUrl ? `[\`relay-assets/changelog.txt\`](${repoUrl}/blob/${tag}/relay-assets/changelog.txt)` : "`relay-assets/changelog.txt`";
  const notes = e
    ? `${e.body}\n\n---\nFrom ${source}, entry \`${e.heading} — ${e.date}\`. Install: \`npm i -g ${pkg.name}@${v}\` — releases are signed by the maintainer's offline key; \`${pkg.name} upgrade\` verifies the manifest.`
    : `${v} was built and tagged but never published on its own; its changes are described under the next version's entry in \`relay-assets/changelog.txt\`.`;
  const assets = noAssets ? undefined : await releaseAssets(v); // verified before anything is created
  const f = join(dir, `${tag}.md`);
  writeFileSync(f, notes);
  const title = e ? `${tag} — ${e.date}` : tag;
  const firstLine = (e?.body.split("\n")[0] ?? "").trim();
  const flagged = firstLine.startsWith("!!");
  if (has) sh("gh", ["release", "edit", tag, "--title", title, "--notes-file", f]);
  else sh("gh", ["release", "create", tag, "--title", title, "--notes-file", f, "--verify-tag"]);
  if (assets) sh("gh", ["release", "upload", tag, ...assets, "--clobber"]);
  console.log(`${has ? "updated" : "created"} ${tag}${flagged ? "  (!! flagged entry)" : ""}${assets ? `  + ${assets.map((a) => basename(a)).join(", ")}` : noAssets ? "" : `  (no assets: ${DL} is not for ${v})`}`);
}
