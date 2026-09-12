// v0.10.0 (security G-3, P2): release signing.
//
// The relay serves the install tarball; the maintainer SIGNS it. These are different people in the threat model
// (or the same person on different days), so the key that vouches for a release must not live on the relay.
// The private half stays on the maintainer's own machines (scripts/release-key.mjs) — off the relay and out of
// CI, which is the property that matters; it is not confined to one computer. This file carries the
// public half, compiled into every client. A client trusts a release only if manifest.sig verifies against one
// of these keys. Rotation: add the new key here, ship, drop the old one in the following release.
import { canon } from "./canon.js";
import { verifyHex } from "./crypto.js";

export const RELEASE_PUBS: string[] = [
  "7a025a45418ea95d0aaf6738749cf72d40207965610d1a31cb3db6233f50d571", // 2026-09-05; offline signing key, never stored in the relay or in CI
];

/** The one file-table entry a client checks a downloaded tarball against. The aliases (can2can.tgz, parley.tgz,
 *  can2cup-<version>.tgz) are for people fetching by hand; the upgrade path takes exactly this name's hash, never
 *  "any hash in the table" — that let an extra entry vouch for bytes the maintainer never signed. */
export const RELEASE_TARBALL = "can2cup.tgz";

export interface ReleaseManifest {
  v: number;
  version: string;
  date: string;
  /** file name → sha256 hex; every alias the relay serves maps to the same hash */
  files: Record<string, string>;
  changelogSha256?: string;
  permissionChange?: boolean;
  dataFlowChange?: boolean;
  minClient?: string;
}

/** Signature over canon(manifest) — the same canonical JSON every envelope uses; no new format. */
export function verifyManifest(m: unknown, sigHex: string, pubs: string[]): { ok: true; pub: string } | { ok: false; reason: string } {
  const x = m as Partial<ReleaseManifest> | null;
  if (!x || typeof x !== "object" || x.v !== 1 || typeof x.version !== "string" || !x.files || typeof x.files !== "object" || Array.isArray(x.files)) return { ok: false, reason: "release manifest is malformed" };
  // v0.14.5 (seventh opinion #1): the file table is a strict schema, not a bag. Every entry must be a plain file
  // name → 64-hex sha256; an own key that JSON.parse admits but a plain object would swallow (`__proto__`) is
  // refused outright. canon() now covers such keys too — this check is the second wall, so a manifest that
  // would parse differently from how it was signed never reaches a hash comparison.
  for (const [k, v] of Object.entries(x.files)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(k) || k === "__proto__" || k === "constructor" || k === "prototype") return { ok: false, reason: `release manifest lists an unacceptable file name ${JSON.stringify(k).slice(0, 40)}` };
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) return { ok: false, reason: `release manifest carries a malformed hash for ${k}` };
  }
  if (typeof x.files[RELEASE_TARBALL] !== "string") return { ok: false, reason: `release manifest does not name ${RELEASE_TARBALL}` };
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return { ok: false, reason: "release manifest signature is malformed" };
  const msg = canon(x);
  for (const pub of pubs) if (verifyHex(sigHex, msg, pub)) return { ok: true, pub };
  return { ok: false, reason: `release manifest signature does not verify against any release key this client trusts (${pubs.map((p) => p.slice(0, 8) + "…").join(", ")}) — release key not trusted by this client, or the manifest was altered` };
}
