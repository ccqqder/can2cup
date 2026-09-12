// Create (or refresh) the GitHub Release for a tag, with that version's entry from relay-assets/changelog.txt as
// the body, so the tags page is never empty and the release notes and the served changelog cannot drift.
//   node scripts/gh-release.mjs v0.16.1            # one tag
//   node scripts/gh-release.mjs --all              # every v* tag that has no release yet
//   node scripts/gh-release.mjs v0.16.1 --force    # overwrite an existing release's notes
// Needs `gh` logged in. A tag whose version has no changelog heading of its own (built but never published alone,
// folded into the next entry) gets a one-line body saying so.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");
const all = args.includes("--all");
const tags = args.filter((a) => a.startsWith("v"));
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

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

const existing = new Set(sh("gh", ["release", "list", "--limit", "200", "--json", "tagName", "-q", ".[].tagName"]).split("\n").filter(Boolean));
const wanted = all ? sh("git", ["tag", "--list", "v*", "--sort=creatordate"]).split("\n").filter(Boolean) : tags;
if (!wanted.length) { console.error("usage: node scripts/gh-release.mjs v<version> | --all [--force]"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "can2cup-rel-"));
for (const tag of wanted) {
  const v = tag.replace(/^v/, "");
  const e = entries.get(v);
  const has = existing.has(tag);
  if (has && !force) { console.log(`skip ${tag} (release exists; --force to rewrite)`); continue; }
  const notes = e
    ? `${e.body}\n\n---\nFrom \`relay-assets/changelog.txt\` (served at https://can2cup.com/changelog.txt), entry \`${e.heading} — ${e.date}\`. Install: \`npm i -g can2cup@${v}\` — releases are signed by the maintainer's offline key; \`can2cup upgrade\` verifies the manifest.`
    : `${v} was built and tagged but never published on its own; its changes are described under the next version's entry in \`relay-assets/changelog.txt\`.`;
  const f = join(dir, `${tag}.md`);
  writeFileSync(f, notes);
  const title = e ? `${tag} — ${e.date}` : tag;
  const firstLine = (e?.body.split("\n")[0] ?? "").trim();
  const flagged = firstLine.startsWith("!!");
  if (has) sh("gh", ["release", "edit", tag, "--title", title, "--notes-file", f]);
  else sh("gh", ["release", "create", tag, "--title", title, "--notes-file", f, "--verify-tag"]);
  console.log(`${has ? "updated" : "created"} ${tag}${flagged ? "  (!! flagged entry)" : ""}`);
}
