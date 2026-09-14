/**
 * v0.18.0: the operator's own pages — the guide, the privacy page, the note at the top of /terms — are static assets of
 * one deployment, not code. A fork serves its own or none, so the Worker looks before it links. Lookups go through the
 * ASSETS binding with redirects followed (html_handling sends /x.html → /x and /dir → /dir/) and are cached per isolate
 * for 5 minutes, like dlSha256 in index.ts.
 */
export type AssetsEnv = { ASSETS?: { fetch(r: Request): Promise<Response> } };

const cache = new Map<string, { text: string | null; at: number }>();

/** The asset's text, or null when this deployment does not ship it (or has no assets binding at all). */
export async function assetText(env: AssetsEnv, path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.text;
  let text: string | null = null;
  try {
    let url = new URL(path, "https://assets.local");
    for (let hop = 0; hop < 3 && env.ASSETS; hop++) {
      const r = await env.ASSETS.fetch(new Request(url));
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url); continue; }
      if (r.ok) text = await r.text();
      break;
    }
  } catch { /* no assets binding (dev) */ }
  if (cache.size > 100) cache.clear();
  cache.set(path, { text, at: Date.now() });
  return text;
}

export async function hasAsset(env: AssetsEnv, path: string): Promise<boolean> {
  return (await assetText(env, path)) !== null;
}

/** Whether this deployment mirrors the install files under /dl (mirror-dl puts them there; a fork may skip it). */
export async function hasMirror(env: AssetsEnv): Promise<boolean> {
  return hasAsset(env, "/dl/VERSION");
}

/** The install line to hand a person: this relay's mirror when it has one, the npm registry otherwise — a relay
 *  without /dl would otherwise hand out a 404. Both carry the same signed package. */
export function installLine(origin: string, mirrored: boolean): string {
  return mirrored ? `npm i -g ${origin}/dl/can2cup.tgz` : "npm i -g can2cup";
}
