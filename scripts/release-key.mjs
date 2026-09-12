// v0.10.0 (security G-3, P2): the maintainer's OFFLINE release key. It signs dl/manifest.json so a client can tell
// "this tarball was published by the maintainer" apart from "this is whatever the relay is serving today".
//
//   node scripts/release-key.mjs init     create ~/.can2cup-release/release.json (refuses to overwrite)
//   node scripts/release-key.mjs pub      print the public key — this is what goes into src/protocol/release.ts
//
// The private key never enters the repo, wrangler secrets, or the config repo. Back it up offline. Rotation: add the
// new pub to RELEASE_PUBS, ship, then remove the old one in the following release (clients keep trusting both meanwhile).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newKeypair } from "../dist/protocol/index.js";

export const RELEASE_KEY_DIR = process.env.CAN2CUP_RELEASE_DIR || path.join(os.homedir(), ".can2cup-release");
export const RELEASE_KEY_FILE = path.join(RELEASE_KEY_DIR, "release.json");

export function loadReleaseKey() {
  return JSON.parse(fs.readFileSync(RELEASE_KEY_FILE, "utf8"));
}

const cmd = process.argv[2];
if (cmd === "init") {
  if (fs.existsSync(RELEASE_KEY_FILE)) { console.error(`${RELEASE_KEY_FILE} already exists — not overwriting. Rotate by creating a second key elsewhere (CAN2CUP_RELEASE_DIR).`); process.exit(1); }
  fs.mkdirSync(RELEASE_KEY_DIR, { recursive: true });
  const kp = newKeypair();
  fs.writeFileSync(RELEASE_KEY_FILE, JSON.stringify({ ...kp, createdAt: new Date().toISOString(), purpose: "can2cup release manifest signing — keep offline, never commit" }, null, 2) + "\n", { mode: 0o600 });
  console.log(`release key created: ${RELEASE_KEY_FILE}\npublic key: ${kp.pub}\nPut the public key into src/protocol/release.ts RELEASE_PUBS and back the file up offline.`);
} else if (cmd === "pub") {
  console.log(loadReleaseKey().pub);
} else if (cmd) {
  console.error("usage: node scripts/release-key.mjs init|pub");
  process.exit(1);
}
