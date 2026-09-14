import fs from "node:fs";
import { cmpSemver } from "../protocol/semver.js";

/** This client's version (package.json). The relay learns it from the `x-can2cup-client` header on every call. */
export const CLIENT_VERSION: string = (() => {
  try { return (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version; }
  catch { return "0.0.0"; }
})();

/** What the relay said about versions on its last reply (headers `x-can2cup-latest` / `x-can2cup-min`). */
export interface RelayVersions { latest: string | null; min: string | null; at: number }
let relayVersions: RelayVersions = { latest: null, min: null, at: 0 };

export function noteRelayVersions(latest: string | null, min: string | null): void {
  if (!latest && !min) return;
  relayVersions = { latest: latest || relayVersions.latest, min: min || relayVersions.min, at: Date.now() };
}
export function getRelayVersions(): RelayVersions { return relayVersions; }

export type UpgradeLevel = "none" | "patch" | "minor" | "required";
/** How urgent an upgrade is, from the relay's point of view. `required` = below the relay's minimum: A2A calls get 426. */
export function upgradeLevel(mine = CLIENT_VERSION, rv = relayVersions): UpgradeLevel {
  if (rv.min && cmpSemver(mine, rv.min) < 0) return "required";
  if (!rv.latest || cmpSemver(mine, rv.latest) >= 0) return "none";
  const [maj, min] = mine.split(".").map(Number);
  const [lmaj, lmin] = rv.latest.split(".").map(Number);
  return maj === lmaj && min === lmin ? "patch" : "minor";
}

/** v0.9.11: the `!!` lines (PERMISSION CHANGE / DATA FLOW) of every changelog entry newer than `from` and not
 *  newer than `to`. A release that changes who may do what, or where data goes, must be shown to the principal
 *  before it is installed — patch or not. Pure text parsing of relay-assets/changelog.txt. */
export function changelogFlags(changelog: string, from: string, to?: string | null): string[] {
  const out: string[] = [];
  let ver: string | null = null;
  for (const raw of changelog.split(/\r?\n/)) {
    const h = /^## (\d+\.\d+\.\d+)\b/.exec(raw);
    if (h) { const v = h[1]; ver = cmpSemver(v, from) > 0 && (!to || cmpSemver(v, to) <= 0) ? v : null; continue; }
    if (ver && raw.startsWith("!!")) out.push(`${ver}: ${raw.trim()}`);
  }
  return out;
}

/** v0.18.0: whether either end of an upgrade range is a prerelease (1.2.3-rc.1). changelogFlags matches `## x.y.z`
 *  headings and cmpSemver compares x.y.z only, so 1.2.3-beta.1 → 1.2.3 would skip a flagged 1.2.3-rc.1: such a range
 *  cannot be checked line by line, and the caller treats it as unverified. */
export function isPrereleaseRange(from: string | null | undefined, to: string | null | undefined): boolean {
  return [from, to].some((v) => /^v?\d+\.\d+\.\d+-/.test((v ?? "").trim()));
}

/** One paragraph for the agent (watch output / MCP context). null when up to date or the relay never said. */
export function upgradeNotice(relay: string, mine = CLIENT_VERSION, rv = relayVersions): string | null {
  const lvl = upgradeLevel(mine, rv);
  if (lvl === "none") return null;
  const cmd = `can2cup upgrade`;
  const head = lvl === "required"
    ? `!! can2cup ${mine} is below this relay's minimum ${rv.min} — opening rooms, wiring groups and speaking in rooms are refused (426) until you upgrade.`
    : `can2cup ${mine} → ${rv.latest} is available (${lvl} release).`;
  const rule = lvl === "required" ? "Upgrade now." : lvl === "patch" ? "Patch releases: just upgrade." : "Minor releases: tell your principal first, then upgrade when they say so.";
  return `${head} ${rule} Run \`${cmd}\` on this computer (it checks the signed release manifest (the one the relay serves under /dl, or, when the relay does not mirror /dl, the one attached to the GitHub Release of that version) against the maintainer's signing key, downloads that version from the npm registry, checks its sha256 against the manifest, then installs), then restart Claude Code once so the MCP server loads the new code. Changes: ${relay}/changelog.txt — if the versions in between carry a \`!! PERMISSION CHANGE\` or \`!! DATA FLOW\` line, \`can2cup upgrade\` prints them and stops; show them to your principal and run it again with --yes.`;
}
