// v0.9.14 (security G-4 R1): the names this relay answers on must be the names it SAYS it answers on.
// Reads wrangler.toml: every [[routes]] pattern with custom_domain = true must appear in RELAY_CANONICAL or
// RELAY_ALIASES ([vars], or the env overrides of the same name), and nothing may be listed that is not routed.
// Exits non-zero on drift, so `npm run release:relay` refuses to ship a relay that would lie about its names.
//
//   node scripts/routes-check.mjs                     the repository's wrangler.toml
//   node scripts/routes-check.mjs --config <toml>     another deployment's config (a fork, a private instance repo)
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const i = argv.indexOf("--config");
if (i >= 0 && !argv[i + 1]) { console.error("usage: node scripts/routes-check.mjs [--config <wrangler.toml>]"); process.exit(2); }
const configPath = i >= 0 ? path.resolve(argv[i + 1]) : new URL("../wrangler.toml", import.meta.url);
const toml = fs.readFileSync(configPath, "utf8");
const routed = new Set();
let inRoute = false, pattern = null, custom = false;
for (const raw of toml.split(/\r?\n/)) {
  const line = raw.replace(/#.*$/, "").trim();
  if (/^\[\[routes\]\]$/.test(line)) { if (inRoute && custom && pattern) routed.add(pattern); inRoute = true; pattern = null; custom = false; continue; }
  if (/^\[/.test(line)) { if (inRoute && custom && pattern) routed.add(pattern); inRoute = false; continue; }
  if (!inRoute) continue;
  const m = /^pattern\s*=\s*"([^"]+)"/.exec(line); if (m) pattern = m[1];
  if (/^custom_domain\s*=\s*true/.test(line)) custom = true;
}
if (inRoute && custom && pattern) routed.add(pattern);

const varOf = (name) => {
  if (process.env[name] != null) return process.env[name];
  const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  return m ? m[1] : "";
};
const host = (u) => u.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
const declared = new Set([varOf("RELAY_CANONICAL"), ...varOf("RELAY_ALIASES").split(",")].map(host).filter(Boolean));

const missing = [...routed].filter((h) => !declared.has(h));
const extra = [...declared].filter((h) => !routed.has(h));
if (missing.length || extra.length) {
  if (missing.length) console.error(`routes-check: routed but not declared in RELAY_CANONICAL/RELAY_ALIASES: ${missing.join(", ")}`);
  if (extra.length) console.error(`routes-check: declared but not a custom-domain route: ${extra.join(", ")}`);
  console.error(`A relay must say every name it answers on, and only those. Fix ${i >= 0 ? argv[i + 1] : "wrangler.toml"} before releasing.`);
  process.exit(1);
}
console.log(`routes-check: ${routed.size} hostname(s), all declared — canonical ${varOf("RELAY_CANONICAL")}`);
