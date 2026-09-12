/** Shared room shapes and the invite encodings. */
export interface RoomPolicy {
  maxMessages: number; // hard cap per room; hitting it forces a close
  ttlSec: number;      // relay refuses appends after createdAt + ttl
}
export const DEFAULT_POLICY: RoomPolicy = { maxMessages: 200, ttlSec: 6 * 3600 };

export interface Participant { name: string; joinedAt: string; removed?: string /* ISO, set by eject */ }

export interface RoomInfo {
  id: string;
  name: string;
  policy: RoomPolicy;
  participants: Record<string, Participant>; // pubkey -> participant (ejected ones stay listed, with `removed`)
  createdAt: string;
  createdBy: string;
  state: "open" | "closed";
  lastSeq: number;
  lastHash: string;
  relayPub?: string; // the relay's signing pubkey (v0.3+); clients pin it per room
  secret?: string;   // the CURRENT invite secret — only returned to a caller authenticated by their own cap
  e2e?: boolean;     // v0.5.0: bodies are ciphertext; the key lives in the invite fragment, never here
  // Portable rooms / mirrors (v0.4.15+):
  pastRelayPubs?: string[];    // relay keys this room lived under before it was imported here
  role?: "mirror";             // absent = primary (writable); "mirror" = read-only replica fed by /replicate
  origin?: string;             // mirror only: the primary relay this replica follows
  mirrors?: string[];          // primary only: relays every append is replicated to
}

/** What GET /rooms/:id/export returns and POST /rooms/:id/import accepts. The chain is
 *  re-verified on import — an export is claimed evidence, never trusted evidence. */
export interface RoomExport {
  format: "parley-export-1";
  exportedAt: string;
  room: {
    id: string; name: string; policy: RoomPolicy; participants: Record<string, Participant>;
    createdAt: string; createdBy: string; state: "open" | "closed"; e2e?: boolean;
  };
  secret?: string;    // only present for a cap-authenticated exporter (same rule as info)
  messages: unknown[]; // Envelope[]; typed loosely so the importer must verify, not assume
  relayPub?: string;  // the exporting relay's signing key — system events verify against it
  head?: unknown;     // the exporting relay's signed head over the tail
}

/**
 * Invite = everything the other side needs: relay (u), room id (r), room secret (s), name (n).
 *
 * Two encodings of the same thing:
 *   URL     https://<relay>/j/<room>?n=<name>#<secret>   ← the one to hand to humans
 *   token   parley1.<base64url json>                     ← compact, for logs / agent-only paths
 *
 * The URL is the primary form: a human can click it (the relay serves a landing page
 * that explains what to paste to their agent), a phone can scan it as a QR code, and
 * an agent can paste it straight into can2cup_join. The secret rides in the fragment,
 * so it never appears in the relay's request logs. Whoever holds either form can read
 * and post in the room — treat an invite like a Telegram join link, not like a URL.
 */
/** k (v0.5.0): the E2E room key. It rides in the URL fragment after the secret
 *  (`#<secret>.<key>`), so like the secret it never reaches any server. */
export interface Invite { u: string; r: string; s: string; n?: string; p?: string /* relay signing pubkey, vouched by the inviter */; k?: string }

const PREFIX = "parley1.";
const TOKEN_RE = /parley1.[A-Za-z0-9_-]{16,}/;
const URL_RE = /https?:\/\/[^\s"'<>]+\/j\/[0-9a-f]{12}[^\s"'<>]*/;

export function encodeInvite(i: Invite): string {
  return PREFIX + b64url(JSON.stringify(i));
}

export function encodeInviteUrl(i: Invite): string {
  const base = i.u.replace(/\/+$/, "");
  const qs = new URLSearchParams();
  if (i.n) qs.set("n", i.n);
  if (i.p) qs.set("p", i.p);
  const qstr = qs.toString();
  const q = qstr ? `?${qstr}` : "";
  return `${base}/j/${i.r}${q}#${i.s}${i.k ? "." + i.k : ""}`;
}

/** Accepts a token, a URL, or any text that contains one of them (agents paste whole chat lines). */
export function decodeInvite(s: string): Invite {
  const t = s.trim();
  const url = URL_RE.exec(t)?.[0];
  if (url) return decodeInviteUrl(url);
  const tok = TOKEN_RE.exec(t)?.[0] ?? (t.startsWith(PREFIX) ? t : undefined);
  if (!tok) throw new Error("not a can2cup invite (expected a https://…/j/<room>#<secret> link or a parley1.… token)");
  const i = JSON.parse(unb64url(tok.slice(PREFIX.length))) as Invite;
  if (!i.u || !i.r || !i.s) throw new Error("malformed invite");
  return i;
}

export function decodeInviteUrl(url: string): Invite {
  const u = new URL(url);
  const m = /^(.*)\/j\/([0-9a-f]{12})$/.exec(u.pathname);
  if (!m) throw new Error("malformed invite link (expected /j/<room>)");
  const [s, k] = u.hash.replace(/^#/, "").split(".");
  if (!/^[0-9a-f]{16,}$/.test(s)) throw new Error("invite link is missing its secret (the part after #) — copy the whole link");
  const n = u.searchParams.get("n") ?? undefined;
  const p = u.searchParams.get("p") ?? undefined;
  return { u: u.origin + m[1], r: m[2], s, ...(n ? { n } : {}), ...(p && /^[0-9a-f]{64}$/.test(p) ? { p } : {}), ...(k && /^[0-9a-f]{64}$/.test(k) ? { k } : {}) };
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
