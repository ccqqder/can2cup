// Mirror a signed release's install files without the release key — for forks, self-hosted relays and any deployment
// that serves /dl/ but is not where releases are signed.
//
//   node scripts/mirror-dl.mjs --version <x.y.z> --out <dl dir> [--from-release <owner/repo | GitHub URL>]
//   node scripts/mirror-dl.mjs --version <x.y.z> --out <dl dir> --from-relay <relay URL>
//   option:  --registry <url>   the npm registry to take the tarball from (default https://registry.npmjs.org)
//
// The tarball comes from the npm registry; manifest.json, manifest.sig and VERSION.sha256 come from the GitHub Release
// of tag v<version> (default: this package.json's repository) or from <relay>/dl/. Nothing is written unless
//   - the manifest names <version> and its signature verifies against RELEASE_PUBS (src/protocol/release.ts, via dist/),
//   - every file the manifest lists is one this layout serves and carries the tarball's sha256,
//   - every line of VERSION.sha256 agrees, and the tarball holds package.json of this package at <version>.
// Then <out> receives exactly what scripts/stage-tarball.mjs + release-sign.mjs put into <assets>/dl/: can2cup.tgz,
// can2can.tgz, parley.tgz, <name>-<version>.tgz, VERSION, VERSION.sha256, the three <alias>.sha256, manifest.json,
// manifest.sig. Point scripts/assemble-assets.mjs --dl at it. Needs `npm run build` (the verifier lives in dist/).
// Exit 1 on any refusal, 2 on a usage error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const usage = (why) => {
  if (why) console.error(`mirror-dl: ${why}`);
  console.error("usage: node scripts/mirror-dl.mjs --version <x.y.z> --out <dl dir> [--from-release <owner/repo> | --from-relay <url>] [--registry <url>]");
  process.exit(2);
};
const KNOWN = ["--version", "--out", "--from-release", "--from-relay", "--registry"];
for (const a of argv) if (a.startsWith("--") && !KNOWN.includes(a)) usage(`unknown option ${a}`);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) usage(`${name} needs a value`);
  return argv[i + 1];
};
const VERSION = opt("--version") ?? usage("--version is required");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(VERSION)) usage(`--version ${VERSION} is not a version`);
const OUT = path.resolve(opt("--out") ?? usage("--out is required"));
// <out> must hold exactly the verified layout: a leftover file would be published beside it unverified, and a
// symlink would carry the write somewhere else.
if (fs.existsSync(OUT) || (() => { try { return fs.lstatSync(OUT).isSymbolicLink(); } catch { return false; } })()) {
  const st = fs.lstatSync(OUT);
  if (st.isSymbolicLink() || !st.isDirectory() || fs.readdirSync(OUT).length) usage(`--out ${OUT} must be a new or empty directory`);
}
if (opt("--from-release") && opt("--from-relay")) usage("--from-release and --from-relay are alternatives");
const REGISTRY = (opt("--registry") ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let metaBase;
if (opt("--from-relay")) {
  metaBase = `${opt("--from-relay").replace(/\/+$/, "")}/dl`;
} else {
  const spec = opt("--from-release") ?? (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ?? "";
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(spec) ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(spec);
  if (!m) usage(`cannot tell a GitHub repository from ${JSON.stringify(spec)} — pass --from-release <owner/repo>`);
  metaBase = `https://github.com/${m[1]}/${m[2]}/releases/download/v${VERSION}`;
}

// A refusal is thrown, not process.exit()ed: exiting while fetch sockets are still open trips a libuv assertion on
// Windows and turns the clean exit 1 into a crash code.
class Refused extends Error {}
const fail = (msg) => { throw new Refused(msg); };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
async function get(url) {
  let res;
  try { res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) }); }
  catch (e) { fail(`${url}: ${e.cause?.code ?? e.message}`); }
  if (!res.ok) fail(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  let verifyManifest, RELEASE_PUBS, RELEASE_TARBALL;
  try { ({ verifyManifest, RELEASE_PUBS, RELEASE_TARBALL } = await import("../dist/protocol/index.js")); }
  catch (e) { fail(`cannot load the verifier from dist/protocol (run npm run build first): ${e.message}`); }

  const tgzName = `${pkg.name}-${VERSION}.tgz`;
  const tgzUrl = `${REGISTRY}/${pkg.name}/-/${tgzName}`;
  console.log(`metadata from ${metaBase}/\ntarball  from ${tgzUrl}`);
  const [manifestBytes, sigBytes, sumsBytes, tgz] = await Promise.all([get(`${metaBase}/manifest.json`), get(`${metaBase}/manifest.sig`), get(`${metaBase}/VERSION.sha256`), get(tgzUrl)]);

  // 1. the signature, over the manifest exactly as served
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch (e) { fail(`manifest.json is not JSON: ${e.message}`); }
  const verdict = verifyManifest(manifest, sigBytes.toString("utf8").trim(), RELEASE_PUBS);
  if (!verdict.ok) fail(verdict.reason);
  if (manifest.version !== VERSION) fail(`the signed manifest is for ${manifest.version}, not ${VERSION}`);

  // 2. every file the manifest lists, against the bytes npm serves
  const sha = sha256(tgz);
  const aliases = [RELEASE_TARBALL, "can2can.tgz", "parley.tgz"];
  const names = [...aliases, tgzName];
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!names.includes(name)) fail(`the manifest lists ${name}, which this mirror does not serve`);
    if (hash !== sha) fail(`${name}: the manifest says ${hash}, the npm tarball is ${sha}`);
  }
  for (const name of names) if (!(name in manifest.files)) fail(`the manifest does not list ${name}`);

  // 3. VERSION.sha256 must say the same, line for line
  const sumNames = new Set();
  for (const l of sumsBytes.toString("utf8").split("\n").filter((x) => x.trim())) {
    const m = /^([0-9a-f]{64}) {2}(\S+)\r?$/.exec(l);
    if (!m) fail(`VERSION.sha256 has a malformed line: ${JSON.stringify(l).slice(0, 100)}`);
    if (!names.includes(m[2])) fail(`VERSION.sha256 lists ${m[2]}, which this mirror does not serve`);
    if (m[1] !== sha) fail(`VERSION.sha256: ${m[2]} is ${m[1]}, the npm tarball is ${sha}`);
    sumNames.add(m[2]);
  }
  for (const name of names) if (!sumNames.has(name)) fail(`VERSION.sha256 does not list ${name}`);

  // 4. the tarball is this package at this version (the same sanity stage-tarball.mjs applies)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "can2cup-mirror-"));
  try {
    fs.writeFileSync(path.join(tmp, tgzName), tgz);
    let pj;
    try { pj = JSON.parse(execFileSync("tar", ["-xzOf", tgzName, "package/package.json"], { encoding: "utf8", cwd: tmp })); }
    catch (e) { fail(`cannot read package/package.json from the tarball: ${e.message}`); }
    if (pj.name !== pkg.name || pj.version !== VERSION) fail(`the tarball contains ${pj.name}@${pj.version}, expected ${pkg.name}@${VERSION}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // verified — write the stage-tarball layout
  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  const write = (name, data) => { fs.writeFileSync(path.join(OUT, name), data); written.push(name); };
  for (const name of names) write(name, tgz);
  write("VERSION", VERSION + "\n");
  write("VERSION.sha256", sumsBytes);
  for (const name of aliases) write(`${name}.sha256`, `${sha}  ${name}\n`);
  write("manifest.json", manifestBytes);
  write("manifest.sig", sigBytes);
  for (const name of written) console.log(`${sha256(fs.readFileSync(path.join(OUT, name)))}  ${name}`);
  console.log(`mirror-dl: ${pkg.name}@${VERSION} verified — manifest signed by ${verdict.pub.slice(0, 8)}…, tarball ${sha.slice(0, 16)}… → ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Refused ? `mirror-dl: REFUSED — ${e.message}` : e);
  process.exitCode = 1;
});
