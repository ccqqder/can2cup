// v0.10.1: publish to the npm registry the EXACT tarball the relay serves and the manifest signs — never a fresh
// `npm pack`. Same bytes on both hosts means `can2cup upgrade` can take the bytes from npm and still check them
// against the maintainer-signed manifest. Interactive: npm opens the 2FA (passkey) flow in a browser.
//
//   npm run release:relay   # pack → routes-check → stage → sign → deploy (this already happened)
//   npm run release:npm     # publishes can2cup-<version>.tgz from the repo root
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tgz = `${pkg.name}-${pkg.version}.tgz`;
if (!fs.existsSync(tgz)) { console.error(`${tgz} not found — run npm run release:relay first (the relay and npm must serve the same file)`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync("relay-assets/dl/manifest.json", "utf8"));
if (manifest.version !== pkg.version) { console.error(`manifest is ${manifest.version}, package is ${pkg.version} — stage and sign first`); process.exit(1); }
if (!fs.existsSync("relay-assets/dl/manifest.sig")) { console.error("relay-assets/dl/manifest.sig missing — sign first (release:relay)"); process.exit(1); }
const win = process.platform === "win32";
const r = win
  ? spawnSync("cmd.exe", ["/d", "/s", "/c", `npm publish "${tgz}" --access public`], { stdio: "inherit", windowsVerbatimArguments: true })
  : spawnSync("npm", ["publish", tgz, "--access", "public"], { stdio: "inherit" });
process.exit(r.status ?? 1);
