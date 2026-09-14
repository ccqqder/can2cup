/**
 * Where `can2cup upgrade` finds the signed release manifest when the relay does not mirror /dl.
 *
 * The relay stays the first source: /dl/manifest.json + /dl/manifest.sig when it serves them. A relay deployed from a
 * fork without scripts/mirror-dl.mjs serves neither, but the same maintainer-signed manifest is attached to the GitHub
 * Release of that version (scripts/gh-release.mjs). Nothing here is trusted: every manifest still has to verify against
 * the compiled-in release keys, name the target version, and list the exact bytes npm hands over.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME, loadIdentity } from "../mcp/state.js";
import { bridge } from "../mcp/relay-client.js";
import { getRelayVersions } from "../mcp/version.js";

const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name?: string; repository?: string | { url?: string } }; }
  catch { return {}; }
})();

/** The npm package this client is. */
export const PACKAGE_NAME = PKG.name || "can2cup";

/** A version string that is safe to put in a URL path. */
export const isVersion = (v: string | null | undefined): v is string => !!v && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);

/** The npm registry the tarball bytes come from. CAN2CUP_NPM_REGISTRY overrides it: dev and smoke only. It moves only
 *  where the bytes are fetched; they still have to match the hash in the signed manifest. */
export function npmRegistry(): string {
  return (process.env.CAN2CUP_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
}

/** owner/repo from package.json's repository field, the way scripts/mirror-dl.mjs reads it. */
export function releaseRepo(): { owner: string; repo: string } | null {
  const spec = (typeof PKG.repository === "string" ? PKG.repository : PKG.repository?.url) ?? "";
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(spec) ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(spec);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The directory the GitHub Release of v<version> serves its assets from (no trailing slash). CAN2CUP_RELEASE_BASE
 *  replaces `https://github.com/<owner>/<repo>/releases/download`: dev and smoke only. A manifest fetched from there
 *  must still be signed by a trusted release key, so the override cannot widen what installs. */
export function releaseBase(version: string): string | null {
  if (!isVersion(version)) return null;
  const env = (process.env.CAN2CUP_RELEASE_BASE ?? "").trim().replace(/\/+$/, "");
  if (env) return `${env}/v${version}`;
  const r = releaseRepo();
  return r ? `https://github.com/${r.owner}/${r.repo}/releases/download/v${version}` : null;
}

/** A page a person can open for that release: the GitHub release page, or the overridden base. */
export function releasePage(version: string): string | null {
  if ((process.env.CAN2CUP_RELEASE_BASE ?? "").trim()) return releaseBase(version);
  const r = releaseRepo();
  return r && isVersion(version) ? `https://github.com/${r.owner}/${r.repo}/releases/tag/v${version}` : null;
}

/** The overrides in effect, for doctor to say out loud. */
export function sourceOverrides(): string[] {
  return ["CAN2CUP_RELEASE_BASE", "CAN2CUP_NPM_REGISTRY"].filter((k) => (process.env[k] ?? "").trim());
}

/** What the relay advertises as its latest client (x-can2cup-latest). A fresh CLI process has seen no reply yet, so
 *  one signed call to /p/groups fetches the headers. It changes no presence, but like every /p/* call it registers
 *  this client's version on the relay (ver:<pub>). Needs this machine's agent identity; without one (or with the relay
 *  silent) the answer is null. Never creates an identity. */
export async function advertisedLatest(relayUrl: string, ms = 8000): Promise<string | null> {
  const known = getRelayVersions().latest;
  if (isVersion(known)) return known;
  if (!fs.existsSync(path.join(HOME, "identity.json"))) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bridge.groups(relayUrl, loadIdentity()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); timer.unref?.(); }),
    ]);
  } catch { /* any reply (a 4xx too) carries the headers; a dead relay leaves nothing */ }
  finally { if (timer) clearTimeout(timer); }
  const v = getRelayVersions().latest;
  return isVersion(v) ? v : null;
}

/** dist-tags.latest of this package on the npm registry, or null. */
export async function npmLatest(ms = 10000): Promise<string | null> {
  try {
    const r = await fetch(`${npmRegistry()}/${PACKAGE_NAME}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const v = ((await r.json()) as { "dist-tags"?: { latest?: string } })["dist-tags"]?.latest;
    return isVersion(v) ? v : null;
  } catch { return null; }
}

/** The most fetchBytes reads from one URL: a changelog is a few hundred KiB, and a source must not make the client
 *  buffer whatever it chooses to send. */
export const FETCH_CAP = 2 * 1024 * 1024;

/** GET an absolute URL as raw bytes (a hash must see exactly what was served), at most `cap` bytes: a Content-Length
 *  over the cap is refused before reading, and the body is counted as it is read and abandoned past the cap. A capped
 *  fetch returns no bytes, like any other failure. `why` as in fetchText. */
export async function fetchBytes(url: string, ms = 10000, cap = FETCH_CAP): Promise<{ bytes: Buffer | null; why: string }> {
  const capLabel = cap % (1024 * 1024) === 0 ? `${cap / (1024 * 1024)} MiB` : `${cap} byte`;
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { bytes: null, why: `HTTP ${r.status}` }; }
    const len = Number(r.headers.get("content-length") ?? "");
    if (Number.isFinite(len) && len > cap) { await r.body?.cancel().catch(() => {}); return { bytes: null, why: `Content-Length ${len} is over the ${capLabel} cap` }; }
    if (!r.body) return { bytes: Buffer.alloc(0), why: "" };
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > cap) { await reader.cancel().catch(() => {}); return { bytes: null, why: `the body ran past the ${capLabel} cap` }; }
      parts.push(value);
    }
    return { bytes: Buffer.concat(parts), why: "" };
  } catch (e) {
    const err = e as { cause?: { code?: string }; message?: string };
    return { bytes: null, why: err.cause?.code ?? err.message ?? String(e) };
  }
}

/** GET an absolute URL as text. `why` says what went wrong when there is no body (HTTP status or network error). */
export async function fetchText(url: string, ms = 10000): Promise<{ text: string | null; why: string }> {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { text: null, why: `HTTP ${r.status}` };
    return { text: await r.text(), why: "" };
  } catch (e) {
    const err = e as { cause?: { code?: string }; message?: string };
    return { text: null, why: err.cause?.code ?? err.message ?? String(e) };
  }
}
