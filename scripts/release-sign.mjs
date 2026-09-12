// v0.10.0 (security G-3, P2): sign relay-assets/dl/manifest.json with the maintainer's offline release key.
// Runs inside `npm run release:relay` AFTER stage-tarball wrote the manifest and BEFORE wrangler deploy. A machine
// without the key cannot release — that is the point: only the maintainer publishes, whatever else can deploy.
import fs from "node:fs";
import { canon, signHex, pubFromPriv } from "../dist/protocol/index.js";
import { loadReleaseKey, RELEASE_KEY_FILE } from "./release-key.mjs";

let key;
try { key = loadReleaseKey(); } catch { console.error(`release-sign: no release key at ${RELEASE_KEY_FILE}. Only the maintainer's machine can release (node scripts/release-key.mjs init).`); process.exit(1); }
if (pubFromPriv(key.priv) !== key.pub) { console.error("release-sign: release.json pub does not match priv — refusing"); process.exit(1); }
const trusted = fs.readFileSync(new URL("../src/protocol/release.ts", import.meta.url), "utf8");
if (!trusted.includes(key.pub)) { console.error(`release-sign: this key (${key.pub.slice(0, 8)}…) is not in src/protocol/release.ts RELEASE_PUBS — clients would refuse it. Add it, build, then release.`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync("relay-assets/dl/manifest.json", "utf8"));
const sig = signHex(canon(manifest), key.priv);
fs.writeFileSync("relay-assets/dl/manifest.sig", sig + "\n");
console.log(`release-sign: manifest ${manifest.version} signed by ${key.pub.slice(0, 8)}… (sig ${sig.slice(0, 16)}…)`);
