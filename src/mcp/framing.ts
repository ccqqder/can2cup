/**
 * Pure text-framing guards for what the model reads. Hardened per the sixth opinion (2026-09-09).
 *
 * A room message — and a peer's display name, a room title, and even a signed envelope's `ts` field — is
 * untrusted data written by another party. None of it may forge the structure the agent relies on to tell
 * principal instructions from peer data: not the principal-channel sentinel, not a `#seq [type] who` header
 * line, not a VERIFIED label. These helpers are the single place that enforces that, kept PURE (no I/O, no
 * identity, no relay) so they can be unit-tested and cannot drift between the local and hosted floors.
 *
 * The guarantee both floors depend on: after fenceBody, EVERY visual line of a body begins with the fence
 * marker, so any `#...` / `---` / VERIFIED a body contains reads as content, not framing. Holding that meant
 * closing three gaps the first version missed (sixth opinion): line breaks other than "\n" (CR, NEL, LS, PS,
 * VT, FF) that a renderer may still break on; bidi / zero-width characters that reorder or hide a marker;
 * and whitespace-obfuscated sentinels (a non-breaking space between the two words) that reconstructed
 * because scrub ran before whitespace was folded.
 *
 * Code points are matched by numeric predicate on purpose — writing the control characters as literals (or
 * as \u escapes) into this file mangles them; a charCodeAt/codePointAt check is stable and readable.
 */

// A renderer may break a line on any of these; String.split("\n") catches only LF.
const CR = 13, LF = 10, NEL = 0x85, LS = 0x2028, PS = 0x2029, VT = 0x0b, FF = 0x0c;
const isLineBreak = (n: number): boolean => n === LF || n === CR || n === NEL || n === LS || n === PS || n === VT || n === FF;
// Bidi controls (overrides / embeddings / isolates) and zero-width / invisible code points.
const isBidiInvisible = (n: number): boolean =>
  (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) || (n >= 0x200b && n <= 0x200d) || n === 0x2060 || n === 0xfeff;
// Horizontal whitespace (space, tab, NBSP, the Unicode spaces) — NOT the line breaks.
const isHSpace = (n: number): boolean =>
  n === 9 || n === 0x20 || n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) || n === 0x202f || n === 0x205f || n === 0x3000;
// C0 controls, DEL, and the C1 range.
const isControl = (n: number): boolean => n < 32 || (n >= 127 && n <= 159);

// The principal channel owns this marker (F9 from the 2026-08-19 design review); a room message must never
// smuggle it into the text the model reads.
export const SENTINEL_RE = /PRINCIPAL (INSTRUCTIONS|RELAY CHANNEL)/gi;
const redactSentinel = (s: string): string => s.replace(SENTINEL_RE, "[redacted-marker]");
const nfkc = (t: unknown): string => { const s = String(t ?? ""); try { return s.normalize("NFKC"); } catch { return s; } };

/**
 * Redact the principal-channel sentinel from an untrusted BODY. Line breaks are PRESERVED (fenceBody fences
 * each line afterwards); bidi / zero-width are dropped and horizontal whitespace folded to a single space
 * BEFORE the scan, so an obfuscated marker cannot reconstruct or hide, while the body stays multi-line.
 */
export const scrub = (t: unknown): string => {
  let out = "";
  for (const ch of nfkc(t)) {
    const n = ch.codePointAt(0)!;
    if (isBidiInvisible(n)) continue;
    if (isLineBreak(n)) { out += ch; continue; }   // keep — fenceBody fences it
    out += isHSpace(n) ? " " : ch;
  }
  return redactSentinel(out.replace(/ {2,}/g, " "));
};

/** Grapheme-aware truncation, so a cap never leaves a lone surrogate or splits a combining sequence. */
function truncate(s: string, max: number): string {
  const cap = Math.max(1, Math.floor(Number.isFinite(max) ? max : 80));
  if (s.length <= cap) return s;
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let out = "";
    for (const { segment } of seg.segment(s)) { if (out.length + segment.length > cap - 1) break; out += segment; }
    return out + "…";
  } catch {
    let end = cap - 1;
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1; // don't cut a surrogate pair
    return s.slice(0, end) + "…";
  }
}

/**
 * Untrusted free-text placed into a STRUCTURAL, single-line position — a message-header line, a room
 * heading, or the header `ts` field — must not forge that structure. NFKC-fold, drop bidi / zero-width,
 * turn every control character and line break into a space, FOLD whitespace, THEN redact the sentinel (so a
 * whitespace-obfuscated one is caught), trim, and grapheme-truncate. Used for peer display names, room
 * titles, and the timestamp field.
 */
export function safeLabel(t: unknown, max = 80): string {
  let out = "";
  for (const ch of nfkc(t)) {
    const n = ch.codePointAt(0)!;
    if (isBidiInvisible(n)) continue;
    out += (isLineBreak(n) || isControl(n) || isHSpace(n)) ? " " : ch;
  }
  return truncate(redactSentinel(out.replace(/\s+/g, " ").trim()), max);
}

/**
 * Fence every line of an untrusted BODY with a marker real structure never starts with, so the body cannot
 * forge a header or a separator. Splits on ALL line-break variants (not just "\n"), so no visual line a
 * renderer produces escapes the fence.
 */
export const BODY_FENCE = "│ "; // "│ "
function splitLines(s: string): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i);
    if (n === CR) { lines.push(cur); cur = ""; if (s.charCodeAt(i + 1) === LF) i++; } // CRLF is one break
    else if (isLineBreak(n)) { lines.push(cur); cur = ""; }
    else cur += s[i];
  }
  lines.push(cur);
  return lines;
}
export const fenceBody = (body: unknown): string =>
  splitLines(String(body ?? "")).map((l) => BODY_FENCE + l).join("\n");
