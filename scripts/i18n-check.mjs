// v0.17.0 — npm run check:i18n
//
// The console's sentences are written in Traditional Chinese in the code and translated in src/relay/i18n/<lang>.json,
// keyed by the Chinese sentence itself (src/relay/i18n.ts). This script keeps the two in step:
//   · every tr(lang, "…") key used in src/relay has a translation in every catalog
//   · a translation carries exactly the {placeholders} its key does
//   · no catalog entry is left over from a sentence that no longer exists (warned, not failed)
//   · tr() is only ever called with a string LITERAL as its key, so this scan sees every sentence
//   · no Chinese string literal in the console's files escapes tr() — unless its line says `// i18n-ok`
//     (words the bot parses, texts written for the agent, first-contact messages that are deliberately bilingual)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SRC = path.join(ROOT, "src", "relay");
const FILES = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => path.join(SRC, f));
// The console's own files: every Chinese literal in these is either translated or marked. Web pages (/terms, the
// join page, the consent page) are separate work and not scanned for escapes.
const CONSOLE = new Set(["bot.ts", "bridge.ts", "line.ts", "discord.ts", "telegram.ts", "channel.ts", "channels.ts"]);
const CATALOG_DIR = path.join(SRC, "i18n");
// every catalog must be complete, and every one is imported by i18n.ts
const catalogs = Object.fromEntries(fs.readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), "utf8"))]));

const CJK = /[一-鿿]/;
const TR_LIT = /\btr\(\s*[^,()]+?,\s*("(?:[^"\\\n]|\\.)*")/g;
const TR_ANY = /\btr\(\s*[^,()]+?,\s*([^\s])/g;
const holes = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");

let fails = 0;
const fail = (m) => { console.log(`FAIL ${m}`); fails++; };
const used = new Map(); // key → "file:line"

for (const file of FILES) {
  const name = path.basename(file);
  if (name === "i18n.ts") continue;
  const src = fs.readFileSync(file, "utf8");
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(TR_LIT)) used.set(JSON.parse(m[1]), `${name}:${lineOf(m.index)}`);
  // the chat apps' own words (channel.ts vocabIn translates them): app / group / pull / pullShort in each `vocab`
  const voc = /readonly vocab: Vocab = \{([^}]*)\}/.exec(src);
  if (voc) for (const m of voc[1].matchAll(/\b(app|group|pull|pullShort): ("(?:[^"\\]|\\.)*")/g)) { const k = JSON.parse(m[2]); if (CJK.test(k)) used.set(k, `${name}:${lineOf(voc.index)} vocab.${m[1]}`); }
  for (const m of src.matchAll(TR_ANY)) if (m[1] !== '"') fail(`${name}:${lineOf(m.index)} tr() with a non-literal key — the scan cannot see that sentence`);
  if (!CONSOLE.has(name)) continue;
  // Chinese string literals outside tr(): strip comments and tr("…") keys, then look for what is left.
  src.split("\n").forEach((line, i) => {
    if (/\/\/\s*i18n-ok\b/.test(line)) return;
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const code = line.replace(TR_LIT, "tr(_)").replace(/\/\/.*$/, "");
    const lits = code.match(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g) ?? [];
    for (const l of lits) if (CJK.test(l)) { fail(`${name}:${i + 1} Chinese literal outside tr(): ${l.slice(0, 70)}`); break; }
  });
}

// --dump <file>: every key in use, as a JSON array — what a translator starts from
const di = process.argv.indexOf("--dump");
if (di > 0) { fs.writeFileSync(process.argv[di + 1], "[\n" + [...used.keys()].map((k) => JSON.stringify(k)).join(",\n") + "\n]\n"); console.log(`dumped ${used.size} keys to ${process.argv[di + 1]}`); }

for (const [lang, cat] of Object.entries(catalogs)) {
  let missing = 0;
  for (const [k, where] of used) {
    if (!(k in cat)) { missing++; if (missing <= 400) fail(`${lang}: no translation for ${where} ${JSON.stringify(k).slice(0, 90)}`); continue; }
    if (holes(k) !== holes(cat[k])) fail(`${lang}: placeholders differ for ${where} — key {${holes(k)}} vs translation {${holes(cat[k])}}`);
  }
  const extra = Object.keys(cat).filter((k) => !used.has(k));
  for (const k of extra) console.log(`warn ${lang}: unused entry ${JSON.stringify(k).slice(0, 90)}`);
  console.log(`${lang}: ${used.size - missing}/${used.size} sentences translated${extra.length ? `, ${extra.length} unused` : ""}`);
}
console.log(fails ? `\n${fails} FAILED` : "\ncheck:i18n: all sentences translated");
process.exit(fails ? 1 : 0);
