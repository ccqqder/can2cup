import type { Envelope, Head, RoomExport, RoomInfo, RoomPolicy, Submitted, SignedPrincipalMsg } from "../protocol/index.js";
import { signRequestHeaders, signAgentClaim, type SignedAgentClaim, chatAppLabel } from "../protocol/index.js";
import { randomBytes } from "node:crypto";
import { CLIENT_VERSION, noteRelayVersions } from "./version.js";
/** review R5: this process's claim id — the relay hands an instruction to one instance at a time. */
export const INSTANCE_ID = randomBytes(6).toString("hex");

export class RelayError extends Error {
  constructor(public status: number, public payload: Record<string, unknown>) {
    super(`relay ${status}: ${String(payload.error ?? JSON.stringify(payload))}`);
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  // v0.9.0 upgrade protocol: every call says which client this is; every reply says what the relay serves / requires.
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", "x-can2cup-client": CLIENT_VERSION, ...(init.headers ?? {}) } });
  noteRelayVersions(res.headers.get("x-can2cup-latest"), res.headers.get("x-can2cup-min"));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new RelayError(res.status, json);
  return json as T;
}

type Key = { pub: string; priv: string };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface CreateResult { id: string; secret: string; cap: string; room: RoomInfo }
export interface JoinResult extends RoomInfo { cap: string }
export interface Poll { messages: Envelope[]; lastSeq: number; lastHash: string; state: "open" | "closed"; head?: Head; relayPub?: string }
export interface RelayHealth { canonical?: string; aliases?: string[]; /* v0.9.14 G-4 R1: display only, never a trust input */ ok: boolean; service: string; v: number; pub?: string; lineOa?: string; telegramBot?: string /* v0.15.1 */ }

/** A room call authenticates with the participant's cap when we have one, else the invite secret. */
export const relay = {
  health(base: string) {
    return call<RelayHealth>(`${base}/`, {});
  },
  create(base: string, key: string, body: { name?: string; policy?: Partial<RoomPolicy>; creator: { pubkey: string; name: string }; e2e?: boolean }) {
    return call<CreateResult>(`${base}/rooms`, { method: "POST", headers: { "x-parley-key": key }, body: JSON.stringify(body) });
  },
  info(base: string, id: string, token: string) {
    return call<RoomInfo>(`${base}/rooms/${id}/info`, { headers: bearer(token) });
  },
  /** Join is signed by the joining key (proof of possession) — that is what earns the per-participant cap. */
  join(base: string, id: string, secret: string, me: Key & { name: string }) {
    const path = `/rooms/${id}/join`;
    const body = JSON.stringify({ pubkey: me.pub, name: me.name });
    return call<JoinResult>(`${base}${path}`, { method: "POST", headers: { ...bearer(secret), ...signRequestHeaders("POST", path, body, me) }, body });
  },
  poll(base: string, id: string, token: string, since: number, wait: number) {
    return call<Poll>(`${base}/rooms/${id}/messages?since=${since}&wait=${wait}`, { headers: bearer(token) });
  },
  head(base: string, id: string, token: string) {
    return call<Head>(`${base}/rooms/${id}/head`, { headers: bearer(token) });
  },
  send(base: string, id: string, token: string, s: Submitted) {
    return call<Envelope>(`${base}/rooms/${id}/messages`, { method: "POST", headers: bearer(token), body: JSON.stringify(s) });
  },
  rotate(base: string, id: string, token: string, me: Key) {
    const path = `/rooms/${id}/rotate`;
    return call<{ ok: boolean; secret: string }>(`${base}${path}`, { method: "POST", headers: { ...bearer(token), ...signRequestHeaders("POST", path, "", me) } });
  },
  eject(base: string, id: string, token: string, me: Key, pubkey: string) {
    const path = `/rooms/${id}/eject`;
    const body = JSON.stringify({ pubkey });
    return call<{ ok: boolean; secret: string }>(`${base}${path}`, { method: "POST", headers: { ...bearer(token), ...signRequestHeaders("POST", path, body, me) }, body });
  },
  /** v0.9.5: take yourself out of a room. Signed by the leaver, so it can only ever be self-aimed. */
  leave(base: string, id: string, token: string, me: Key) {
    const path = `/rooms/${id}/leave`;
    return call<{ ok: boolean; remaining: number; roomClosed: boolean }>(`${base}${path}`, { method: "POST", headers: { ...bearer(token), ...signRequestHeaders("POST", path, "", me) } });
  },
  /** v0.9.5: ask the relay to forget this agent. scope "binding" = the LINE link; "all" = everything. */
  erase(base: string, me: Key, scope: "binding" | "all") {
    const body = JSON.stringify({ scope });
    return call<{ ok: boolean; scope: string; wasBound: boolean; channel?: string | null; deleted: Record<string, number> }>(`${base}/p/erase`, { method: "POST", headers: { "content-type": "application/json", ...signRequestHeaders("POST", "/p/erase", body, me) }, body });
  },
  /** Portable rooms (v0.4.15): the full transcript + meta, for re-homing on another relay. */
  exportRoom(base: string, id: string, token: string) {
    return call<RoomExport>(`${base}/rooms/${id}/export`, { headers: bearer(token) });
  },
  /** Import an export onto `base` (needs that relay's room-creation key). The relay re-verifies the chain. */
  importRoom(base: string, key: string, id: string, ex: RoomExport & { role?: "mirror"; origin?: string }) {
    return call<{ id: string; secret: string; imported: number; room: RoomInfo }>(`${base}/rooms/${id}/import`, { method: "POST", headers: { "x-parley-key": key }, body: JSON.stringify(ex) });
  },
  /** Mirrors (v0.4.16): tell the primary where to replicate every append. Signed by a participant. */
  mirrors(base: string, id: string, token: string, me: Key, b: { add?: string; remove?: string }) {
    const path = `/rooms/${id}/mirrors`;
    const body = JSON.stringify(b);
    return call<{ ok: boolean; mirrors: string[] }>(`${base}${path}`, { method: "POST", headers: { ...bearer(token), ...signRequestHeaders("POST", path, body, me) }, body });
  },
  /** Failover: a participant turns a mirror into the primary. Signature-only (no cap exists there yet). */
  promote(base: string, id: string, me: Key) {
    const path = `/rooms/${id}/promote`;
    return call<{ ok: boolean; secret: string }>(`${base}${path}`, { method: "POST", headers: signRequestHeaders("POST", path, "", me) });
  },
};

// ---- principal bridge (agent-signed) ---------------------------------------

export interface InboxItem { seq: number; at: string; text: string; redelivered?: boolean; signed?: SignedPrincipalMsg; via?: string; group?: string; groupAlias?: string; groupName?: string; invite?: string; roomRequest?: { name?: string; group: string }; guest?: { name: string; group: string; groupName?: string }; lang?: string /* v0.17.0: the language to answer in, a code from LANGS */; bound?: { channel: string; lang?: string } /* v0.17.0: a chat account just bound this agent */ }
export interface KnownGroup { id: string; alias: string; name?: string; lastAt: string; channel?: string /* v0.15.1: which chat app */ }
export interface InboxResult { messages: InboxItem[]; paused: boolean; bound: boolean; lastSeq: number }
export interface IdleState { days: number; forever: boolean; by: string | null; lastSeen: string | null; idleMs: number; ttlMs: number; expiresAt: string | null } // v0.9.12
/** v0.13.0: whether the principal channel is actually delivering. `unknown` means nothing has been
 *  pushed through it yet — an unproven escape hatch, which an agent about to block on a principal
 *  decision needs to know before it waits. */
export interface ChannelHealth { state: "ok" | "failing" | "unknown"; channel: string; okAt?: string; failAt?: string; status?: number; detail?: string }
export interface BridgeState { bound: boolean; boundAt?: string | null; idle?: IdleState | null; paused: boolean; agentMode: boolean; inboxSeq: number; principalPub: string | null; signedPause: SignedPrincipalMsg | null; channel?: ChannelHealth | null; lang?: string | null /* v0.17.0: the boss's language */ }

/** Requests to /p/* are signed with the agent's key over "METHOD\nPATH\nTS\nBODY". */
async function signed<T>(base: string, method: string, path: string, body: unknown, me: Key): Promise<T> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const url = new URL(base + path);
  return call<T>(url.toString(), { method, body: text || undefined, headers: signRequestHeaders(method, url.pathname, text, me) });
}

/** v0.17.0: a notification as a code the relay renders in the boss's language; `text` stays the Chinese fallback for
 *  relays older than 0.17.0. */
export type Note = { code: string; vars?: Record<string, string | number | undefined> };

export const bridge = {
  link(base: string, me: Key & { name: string }) {
    return signed<{ code: string; expiresInSec: number; alreadyBound: boolean; boundTo?: string }>(base, "POST", "/p/link", { name: me.name }, me);
  },
  state(base: string, me: Key) {
    return signed<BridgeState>(base, "GET", "/p/state", undefined, me);
  },
  /** v0.9.12: how long this binding may sit with the agent absent before it lapses. {} = just read it back. */
  keep(base: string, me: Key, body: { days?: number; forever?: boolean } = {}) {
    return signed<{ ok: boolean; idle: IdleState }>(base, "POST", "/p/keep", body, me);
  },
  /** Reverse link: claim a code the bot handed the human ("/link" with no code). */
  claim(base: string, me: Key & { name: string }, code: string) {
    return signed<{ ok: boolean; userId: string; channel?: string }>(base, "POST", "/p/claim", { code, name: me.name }, me);
  },
  inbox(base: string, me: Key, since: number, opts: { peek?: boolean } = {}) {
    return signed<InboxResult>(base, "GET", `/p/inbox?since=${since}&instance=${INSTANCE_ID}${opts.peek ? "&peek=1" : ""}`, undefined, me);
  },
  /** v0.8.1: file a diagnostic report with the relay operator (no room content). */
  report(base: string, me: Key, r: { note: string; doctor: string; version: string; platform: string; errors: string[] }) {
    return signed<{ ok: boolean; id?: string; operatorNotified?: boolean; reason?: string }>(base, "POST", "/p/report", r, me);
  },
  /** v0.8.0: "I am handling everything up to seq" — stops the relay's unanswered-reminder and redelivery. */
  ack(base: string, me: Key, seq: number) {
    return signed<{ ok: boolean; acked: number }>(base, "POST", "/p/ack", { seq }, me);
  },
  notify(base: string, me: Key, n: { kind: "blocked" | "escalate" | "info"; room?: string; seq?: number; text: string; where?: string; image?: string; handled?: number; note?: Note }) {
    return signed<{ ok: boolean; to?: string; reason?: string; channel?: ChannelHealth | null }>(base, "POST", "/p/notify", n, me);
  },
  /** v0.4.5: groups the principal has /a'd from — addressable as where "group:<alias>". */
  groups(base: string, me: Key) {
    return signed<{ groups: KnownGroup[]; lastGroup: string | null }>(base, "GET", "/p/groups", undefined, me);
  },
  /** v0.4.5: host an image on the relay for `ttl` seconds (default 1 h); returns a public https URL for LINE. */
  image(base: string, me: Key, data: string, mime: string, ttl?: number) {
    return signed<{ ok: boolean; id: string; url: string; expiresInSec: number }>(base, "POST", "/p/image", { data, mime, ttl }, me);
  },
  /** Invite-by-LINE (v0.4.2): register a room invite; get a short code + line.me deep link for the invitee's phone. */
  inviteLine(base: string, me: Key & { name: string }, room: string, invite: string, name: string) {
    return signed<{ code: string; url?: string; expiresInSec: number }>(base, "POST", "/p/invite", { room, invite, name, fromName: me.name }, me);
  },
  /** v0.14.3: resolve a short join code (ABCD-1234) to its invite — the local-agent twin of the LINE /join.
   *  Binding-gated on the relay (bindingByPub) and rate-limited; returns the full invite link for opJoin. */
  joinCode(base: string, me: Key, code: string) {
    return signed<{ invite: string; room: string; name?: string; from?: string }>(base, "POST", "/p/join-code", { code }, me);
  },
  /** v0.5.1: answer a /room typed in a LINE group — report the room this client just created; the
   *  bridge posts the invite into that group and mirrors the room there. */
  /** v0.8.2: open a room as a LINE-bound agent — no operator key needed. */
  createRoom(base: string, me: Key, body: { name?: string; policy?: Partial<RoomPolicy>; e2e?: boolean }) {
    return signed<CreateResult>(base, "POST", "/p/rooms", body, me);
  },
  roomCreated(base: string, me: Key, r: { room: string; name: string; invite: string; group: string }) {
    return signed<{ ok: boolean; code: string; url?: string; expiresInSec: number }>(base, "POST", "/p/room-created", r, me);
  },
  /** Presence (v0.3.1): `online` on start (returns what to resume), `heartbeat` every 60 s, `offline` on shutdown. */
  /** v0.9.10: `tier` tells the bridge whether this agent's mandate is widened and whether the commit gate is on,
   *  so the LINE side can say "money and grants need a signature on the computer" instead of a button that does nothing. */
  online(base: string, me: Key, body: { tier?: { widened: boolean; unsigned_may_commit: boolean } } = {}) {
    return signed<{ ok: boolean; bound: boolean; pendingInbox: number; openRooms: Array<{ id: string; name: string; lastSeq: number }> }>(base, "POST", "/p/online", body, me);
  },
  heartbeat(base: string, me: Key) {
    return signed<{ ok: boolean }>(base, "POST", "/p/heartbeat", {}, me);
  },
  offline(base: string, me: Key) {
    return signed<{ ok: boolean }>(base, "POST", "/p/offline", {}, me);
  },
  /** Pin the principal's pubkey for this agent (so /principal/* can be verified server-side too). */
  registerPrincipal(base: string, me: Key, principalPub: string, proof?: SignedAgentClaim) {
    return signed<{ ok: boolean; principalPub: string; changed: boolean; proven?: boolean }>(base, "POST", "/p/principal", { principalPub, ...(proof ? { proof } : {}) }, me);
  },
  /** v0.15.2: register the principal WITH the principal-signed claim (protocol/principal.ts) — the relay then groups
   *  this agent under that principal for the dashboard. Needs the relay's signing pub (GET /), which the claim is
   *  bound to; a relay without one gets a claim over "". */
  async registerPrincipalProven(base: string, me: Key, principal: { pub: string; priv: string }) {
    let relayPubHex = "";
    try { relayPubHex = (await relay.health(base)).pub ?? ""; } catch { /* legacy relay: no signing key */ }
    const proof = signAgentClaim({ agent: me.pub, principalPub: principal.pub, relayPub: relayPubHex }, principal.priv, principal.pub);
    return bridge.registerPrincipal(base, me, principal.pub, proof);
  },
  /** v0.15.2: the principal-scoped dashboard (docs/dashboard-tool.md). */
  dashboard(base: string, me: Key) {
    return signed<Dashboard>(base, "GET", "/p/dashboard", undefined, me);
  },
};

// ---- principal → bridge (principal-signed body; no other auth) --------------

export const principalApi = {
  say(base: string, m: SignedPrincipalMsg) {
    return call<{ ok: boolean; seq: number }>(`${base}/principal/say`, { method: "POST", body: JSON.stringify(m) });
  },
  pause(base: string, m: SignedPrincipalMsg) {
    return call<{ ok: boolean; paused: boolean }>(`${base}/principal/pause`, { method: "POST", body: JSON.stringify(m) });
  },
};

/** v0.15.2: the dashboard DTO as the relay returns it (src/relay/bridge.ts Dashboard). Mirrored here so the client
 *  does not import the Worker; keep the two in step. */
export interface DashboardAgent {
  pub: string; short: string; self: boolean; name: string; custody: "local" | "hosted"; relayHost: string | null; version: string | null;
  presence: { online: boolean; lastSeen: string | null; sinceMin: number | null };
  paused: boolean; unreadInstructions: number;
  binding: { channel: string; userIdHint: string; boundAt: string | null; idle: { days: number; forever: boolean; expiresAt: string | null }; agentMode: boolean } | null;
  channelHealth: { state: string; channel: string; okAt: string | null; failAt: string | null; status: number | null } | null;
  groups: Array<{ alias: string; name?: string; channel: string; wiredRoom: string | null }>;
  rooms: { open: number; total: number; items: Array<{ id: string; name: string; state: string; lastSeq: number }> };
}
export interface Dashboard {
  generatedAt: string; callerPub: string; scope: "self" | "principal";
  principalStatus: "proven" | "registered-unproven" | "hosted" | "none";
  principal: string | null; truncated: boolean; hint?: string; agents: DashboardAgent[];
}
/** One line per agent, the same words the hosted can2cup_status tool prints. */
export function dashboardLines(dash: Dashboard): string[] {
  const line = (a: DashboardAgent) => {
    const dot = a.custody === "hosted" ? "☁️" : a.presence.online ? "🟢" : "🔴";
    const via = a.binding ? `${chatAppLabel(a.binding.channel)}${a.paused ? " · paused" : ""}` : "not bound";
    const wired = a.groups.filter((g) => g.wiredRoom).length;
    return `${dot} ${a.name || a.short}${a.self ? " (this agent)" : ""} — ${via}, ${a.rooms.open} open room(s), ${a.groups.length} known group(s)${wired ? ` (${wired} wired)` : ""}${a.unreadInstructions ? `, ${a.unreadInstructions} unread instruction(s)` : ""}${a.version ? ` · v${a.version}` : ""}${a.relayHost ? ` · via ${a.relayHost}` : ""}`;
  };
  return [`scope: ${dash.scope} (principal ${dash.principalStatus})${dash.truncated ? " — list truncated" : ""}`, ...dash.agents.map(line), ...(dash.hint ? ["", `note: ${dash.hint}`] : [])];
}
