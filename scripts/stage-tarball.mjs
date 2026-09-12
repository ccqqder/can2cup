// Put the release tarball into relay-assets/dl/ so the relay serves it, and write the release manifest.
//
//   node scripts/stage-tarball.mjs              stage the locally packed can2cup-<version>.tgz (dev, smoke, emergencies)
//   node scripts/stage-tarball.mjs --from-npm   download can2cup-<version>.tgz FROM THE NPM REGISTRY and stage that
//
// v0.10.2: npm is first-hand, the relay is the mirror. GitHub Actions (trusted publishing, .github/workflows/publish.yml)
// builds and publishes the tarball; the maintainer's machine then pulls exactly those bytes, signs their hash into
// manifest.json with the OFFLINE release key, and deploys. Two hosts, one file, one signature — and the signing key
// never reaches the relay or CI, which is why CI cannot do the last step. "Offline" means off the relay and out of
// CI, not confined to one computer: the key sits on more than one of the maintainer's own machines (a release can
// be cut from either) plus an offline backup.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const src = `${pkg.name}-${pkg.version}.tgz`;
const fromNpm = process.argv.includes("--from-npm");
if (fromNpm) {
  const url = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) { console.error(`${url} → HTTP ${res.status}. Is ${pkg.version} published? (push the tag v${pkg.version} and let the workflow run first)`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (fs.existsSync(src)) {
    const local = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
    const remote = createHash("sha256").update(buf).digest("hex");
    if (local !== remote) console.warn(`note: the local ${src} (${local.slice(0, 8)}…) differs from npm's (${remote.slice(0, 8)}…) — staging npm's; the relay must serve what npm serves`);
  }
  fs.writeFileSync(src, buf);
  console.log(`downloaded ${src} from the npm registry (${buf.length} bytes)`);
}
if (!fs.existsSync(src)) { console.error(`${src} not found — run npm run pack first (or --from-npm)`); process.exit(1); }
// sanity, on EVERY path (v0.14.5, seventh opinion #10): the tarball must be this package at this version. The local
// path used to trust the file name, so a mis-named tgz of another version was signed as the working tree's version.
{
  const inner = execFileSync("tar", ["-xzOf", src, "package/package.json"], { encoding: "utf8" });
  const pj = JSON.parse(inner);
  if (pj.name !== pkg.name || pj.version !== pkg.version) { console.error(`${src} contains ${pj.name}@${pj.version}, expected ${pkg.name}@${pkg.version} — not staging it`); process.exit(1); }
}
fs.mkdirSync("relay-assets/dl", { recursive: true });
fs.copyFileSync(src, "relay-assets/dl/can2cup.tgz");
fs.copyFileSync(src, "relay-assets/dl/can2can.tgz");
fs.copyFileSync(src, "relay-assets/dl/parley.tgz");
fs.copyFileSync(src, `relay-assets/dl/${src}`);
fs.writeFileSync("relay-assets/dl/VERSION", pkg.version + "\n");
// v0.9.11 (security G-3, P1): the tarball's sha256, sha256sum-compatible ("<hex>  <name>", one line per name the
// relay serves, so `sha256sum -c VERSION.sha256` works verbatim). Same origin as the tarball, so it does not stop a
// hostile relay — it stops a corrupted or swapped file, and it is a number a person can compare out of band.
const sha = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
const names = ["can2cup.tgz", "can2can.tgz", "parley.tgz", src];
fs.writeFileSync("relay-assets/dl/VERSION.sha256", names.map((n) => `${sha}  ${n}`).join("\n") + "\n");
for (const n of ["can2cup.tgz", "can2can.tgz", "parley.tgz"]) fs.writeFileSync(`relay-assets/dl/${n}.sha256`, `${sha}  ${n}\n`);
console.log(`sha256 ${sha}`);
// v0.10.0 (security G-3, P2): the release manifest. release-sign.mjs signs it with the maintainer's OFFLINE key,
// and the client refuses an upgrade whose manifest is unsigned, signed by an unknown key, names another version,
// or does not list the tarball's hash. permissionChange / dataFlowChange come from this version's `!!` lines in
// changelog.txt, so "does this release touch who-may-do-what" is machine-readable, not just human-readable.
const changelog = fs.existsSync("relay-assets/changelog.txt") ? fs.readFileSync("relay-assets/changelog.txt", "utf8") : "";
const entry = (() => { const m = new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |\\Z)`, "m").exec(changelog); return m ? m[1] : ""; })();
const flags = entry.split(/\r?\n/).filter((l) => l.startsWith("!!"));
const toml = fs.readFileSync("wrangler.toml", "utf8");
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
fs.writeFileSync("relay-assets/dl/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
try { fs.unlinkSync("relay-assets/dl/manifest.sig"); } catch { /* none yet */ } // a stale signature must never outlive its manifest
console.log(`manifest ${manifest.version} (${manifest.source}): permissionChange=${manifest.permissionChange} dataFlowChange=${manifest.dataFlowChange} (unsigned until release-sign)`);
// v0.8.1: the agent skill is also served online (can2cup.com/skill.md) so any agent can re-read the latest.
fs.copyFileSync("SKILL.md", "relay-assets/skill.md");
console.log(`staged ${src} → relay-assets/dl/{can2cup.tgz, can2can.tgz, parley.tgz}`);
