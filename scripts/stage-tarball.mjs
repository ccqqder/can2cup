// Put the release tarball into <assets>/dl/ so the relay serves it, and write the release manifest.
//
//   node scripts/stage-tarball.mjs              stage the locally packed can2cup-<version>.tgz (dev, smoke, emergencies)
//   node scripts/stage-tarball.mjs --from-npm   download can2cup-<version>.tgz FROM THE NPM REGISTRY and stage that
//   options:  --config <wrangler.toml>   where MIN_CLIENT is read               (default ./wrangler.toml)
//             --assets <dir>             the relay's assets directory             (default ./relay-assets)
//             --changelog <file>         the changelog whose `!!` lines flag it  (default relay-assets/changelog.txt of this repository)
//
// package.json, SKILL.md, the changelog and the tarball are this repository's own files and resolve against it
// (scripts/..), not the working directory, so a deployment that keeps this repository in a subdirectory can run the
// script with its own --config and --assets.
//
// v0.10.2: npm is first-hand, the relay is the mirror. GitHub Actions (trusted publishing, .github/workflows/publish.yml)
// builds and publishes the tarball; the maintainer's machine then pulls exactly those bytes, signs their hash into
// manifest.json with the OFFLINE release key, and deploys. Two hosts, one file, one signature — and the signing key
// never reaches the relay or CI, which is why CI cannot do the last step. "Offline" means off the relay and out of
// CI, not confined to one computer: the key sits on more than one of the maintainer's own machines (a release can
// be cut from either) plus an offline backup.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) { console.error(`${name} needs a value`); process.exit(2); }
  return argv[i + 1];
};
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inRoot = (p) => path.join(ROOT, p);
const CONFIG = opt("--config", "wrangler.toml");
const ASSETS = opt("--assets", "relay-assets");
const CHANGELOG = opt("--changelog", inRoot("relay-assets/changelog.txt"));
const DL = path.join(ASSETS, "dl");

const pkg = JSON.parse(fs.readFileSync(inRoot("package.json"), "utf8"));
const src = inRoot(`${pkg.name}-${pkg.version}.tgz`);
const srcName = path.basename(src);
const fromNpm = argv.includes("--from-npm");
if (fromNpm) {
  const url = `https://registry.npmjs.org/${pkg.name}/-/${srcName}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) { console.error(`${url} → HTTP ${res.status}. Is ${pkg.version} published? (push the tag v${pkg.version} and let the workflow run first)`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (fs.existsSync(src)) {
    const local = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
    const remote = createHash("sha256").update(buf).digest("hex");
    if (local !== remote) console.warn(`note: the local ${srcName} (${local.slice(0, 8)}…) differs from npm's (${remote.slice(0, 8)}…) — staging npm's; the relay must serve what npm serves`);
  }
  fs.writeFileSync(src, buf);
  console.log(`downloaded ${srcName} from the npm registry (${buf.length} bytes)`);
}
if (!fs.existsSync(src)) { console.error(`${srcName} not found — run npm run pack first (or --from-npm)`); process.exit(1); }
// sanity, on EVERY path (v0.14.5, seventh opinion #10): the tarball must be this package at this version. The local
// path used to trust the file name, so a mis-named tgz of another version was signed as the working tree's version.
{
  const inner = execFileSync("tar", ["-xzOf", srcName, "package/package.json"], { encoding: "utf8", cwd: ROOT });
  const pj = JSON.parse(inner);
  if (pj.name !== pkg.name || pj.version !== pkg.version) { console.error(`${srcName} contains ${pj.name}@${pj.version}, expected ${pkg.name}@${pkg.version} — not staging it`); process.exit(1); }
}
fs.mkdirSync(DL, { recursive: true });
fs.copyFileSync(src, path.join(DL, "can2cup.tgz"));
fs.copyFileSync(src, path.join(DL, "can2can.tgz"));
fs.copyFileSync(src, path.join(DL, "parley.tgz"));
fs.copyFileSync(src, path.join(DL, srcName));
fs.writeFileSync(path.join(DL, "VERSION"), pkg.version + "\n");
// v0.9.11 (security G-3, P1): the tarball's sha256, sha256sum-compatible ("<hex>  <name>", one line per name the
// relay serves, so `sha256sum -c VERSION.sha256` works verbatim). Same origin as the tarball, so it does not stop a
// hostile relay — it stops a corrupted or swapped file, and it is a number a person can compare out of band.
const sha = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
const names = ["can2cup.tgz", "can2can.tgz", "parley.tgz", srcName];
fs.writeFileSync(path.join(DL, "VERSION.sha256"), names.map((n) => `${sha}  ${n}`).join("\n") + "\n");
for (const n of ["can2cup.tgz", "can2can.tgz", "parley.tgz"]) fs.writeFileSync(path.join(DL, `${n}.sha256`), `${sha}  ${n}\n`);
console.log(`sha256 ${sha}`);
// v0.10.0 (security G-3, P2): the release manifest. release-sign.mjs signs it with the maintainer's OFFLINE key,
// and the client refuses an upgrade whose manifest is unsigned, signed by an unknown key, names another version,
// or does not list the tarball's hash. permissionChange / dataFlowChange come from this version's `!!` lines in
// changelog.txt, so "does this release touch who-may-do-what" is machine-readable, not just human-readable.
// An explicitly named changelog must exist: a missing one would silently clear both flags.
if (argv.includes("--changelog") && !fs.existsSync(CHANGELOG)) { console.error(`--changelog ${CHANGELOG} not found`); process.exit(1); }
const changelog = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, "utf8") : "";
const entry = (() => { const m = new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |\\Z)`, "m").exec(changelog); return m ? m[1] : ""; })();
const flags = entry.split(/\r?\n/).filter((l) => l.startsWith("!!"));
const toml = fs.readFileSync(CONFIG, "utf8");
const minClient = (/^MIN_CLIENT\s*=\s*"([^"]*)"/m.exec(toml) ?? [])[1] ?? "0.0.0";
const manifest = {
  v: 1, version: pkg.version, date: new Date().toISOString().slice(0, 10),
  files: Object.fromEntries(names.map((n) => [n, sha])),
  source: fromNpm ? "npm" : "local",
  changelogSha256: createHash("sha256").update(changelog).digest("hex"),
  permissionChange: flags.some((l) => /PERMISSION CHANGE/i.test(l)),
  dataFlowChange: flags.some((l) => /DATA FLOW/i.test(l)),
  minClient,
};
fs.writeFileSync(path.join(DL, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
try { fs.unlinkSync(path.join(DL, "manifest.sig")); } catch { /* none yet */ } // a stale signature must never outlive its manifest
console.log(`manifest ${manifest.version} (${manifest.source}): permissionChange=${manifest.permissionChange} dataFlowChange=${manifest.dataFlowChange} (unsigned until release-sign)`);
// v0.8.1: the agent skill is also served online (can2cup.com/skill.md) so any agent can re-read the latest.
fs.copyFileSync(inRoot("SKILL.md"), path.join(ASSETS, "skill.md"));
console.log(`staged ${srcName} → ${DL.replace(/\\/g, "/")}/{can2cup.tgz, can2can.tgz, parley.tgz}`);
