/**
 * BridgeDO — the principal-side bridge between can2cup identities and a chat app
 * (LINE today, via the lilinene bot). One instance ("bridge") for the relay.
 *
 * What it holds:
 *   link codes        agent → code (can2cup_link) → principal sends "/link CODE" to the bot → bound
 *   bindings          chat userId ↔ agent pubkey (+ agentMode: are 1:1 texts instructions?)
 *   inbox per pubkey  principal instructions written by the bot, read by the agent's can2cup_wait
 *   remote pause      principal says "/pause" in chat → agent's mandate check refuses to send
 *   room knowledge    learned from RoomDO events: which rooms each pubkey is in, recent messages
 *   mirrors           chat groupId → room: verified events are pushed into the group
 *   push budget       monthly counter so a free LINE plan is not exceeded
 *   presence (v0.3.1) lastSeen (any /p/* call, incl. a 60 s heartbeat from a live MCP process), lastRead
 *                     (the agent actually drained its inbox), offlineAt (the MCP said goodbye on shutdown).
 *                     Transitions push "agent offline / back online" to the bound principal; /bridge/inbox
 *                     and room pushes say so when the agent is not there to act.
 *                     v0.4.7: presence is keyed on the agent's pubkey, but every Claude Code session runs
 *                     its own MCP process under that one key — so closing one window used to fire 🔴 and
 *                     then 🟢 as soon as a sibling session's heartbeat landed. The goodbye is now held for
 *                     PRESENCE_GRACE_SEC (90 s > the 60 s heartbeat): any /p/* call in that window cancels
 *                     it silently, and "back online" is only sent if the principal was actually told
 *                     (offtold:) that the agent was gone — by the 🔴 push, an /a they typed while it was
 *                     away, or a room push carrying the offline warning.
 *
 * Auth:
 *   /p/*          signed by the agent's ed25519 key (x-parley-pub / x-parley-ts / x-parley-sig over
 *                 "METHOD\nPATH\nTS\nBODY"); ts must be within 5 minutes.
 *   /bridge/*     the bot's shared key (x-parley-bridge-key == BRIDGE_KEY secret).
 *   /principal/*  a principal-signed message in the body (see protocol/principal.ts), checked
 *                 against the principal pubkey the agent registered via POST /p/principal. v0.3:
 *                 these are the ONLY inbox items / pauses the MCP server will ever call verified —
 *                 the bridge verifies too (so the inbox cannot be spammed), but the agent's own
 *                 check is the trust anchor, not this one.
 *   /internal/*   only reachable from RoomDO (the worker never routes it).
 *
 * Delivery: LINE_FORWARD_URL (the bot's /parley/push, keyed with BRIDGE_KEY) is preferred so the
 * channel token stays in one place; LINE_CHANNEL_ACCESS_TOKEN set on the worker pushes directly.
 * Neither set → pushes are only recorded (smoke tests read them back via /bridge/debug/pushes).
 *
 * Pushes are queued in storage and delivered from alarm(): request handlers stay storage-only
 * (so RoomDO can await /internal/event cheaply and atomically), and slow/failed deliveries never
 * block a room append. Dangling promises after a response are not reliable in DOs — the queue is.
 */
import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { type Envelope, type SignedPrincipalMsg, type SignedAgentClaim, verifyAgentClaim, pubFromPriv, randomHex, short, verifyRequestHeaders, verifyPrincipal, decodeInviteUrl, encodeInviteUrl, isLang, normLang, langInfo, LANGS, DEFAULT_LANG, LEGACY_LANG } from "../protocol/index.js";
import { NO_VERSION, cmpSemver } from "../protocol/semver.js";
import {
  type McpDeps, handleMcp, authorizeGet, authorizePost,
  register as mcpRegister, token as mcpToken, hostedKeyOf, createHostedAgent,
} from "./mcp-http.js";
import { type Card, type Channel, type Incoming, type Out, type Quick, outText, vocabIn } from "./channel.js";
import { makeChannels, channelFor, channelNamed } from "./channels.js";
import { tr } from "./i18n.js";
import { safeLabel } from "../protocol/framing.js";
import { hasAsset, hasMirror, installLine } from "./assets.js";
import { type BotApi, type BotCtx, type Handled, BridgeError, SILENT, bridgeDown, GROUP_HELLO, nonTextReply, plainTextHint, WELCOME, chipsFor, handlePostback, handleText, isCommand } from "./bot.js";

export interface BridgeEnv {
  BRIDGE_KEY?: string;
  LINE_FORWARD_URL?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_CHANNEL_SECRET?: string;  // v0.12.0: set → POST /line/webhook is the bot; the Worker verifies LINE's signature and answers in-process
  LINE_MENU_CONSOLE?: string;    // rich menu name prefixes (per-user menus: bound → console, else onboard)
  LINE_MENU_ONBOARD?: string;
  DISCORD_APPLICATION_ID?: string; // v0.12.1: set all three → POST /discord/interactions is the Discord app (see discord.ts)
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;      // v0.15.0: set both → POST /telegram/webhook is the Telegram bot (see telegram.ts)
  TELEGRAM_WEBHOOK_SECRET?: string; // what setWebhook's secret_token was set to; verifies every webhook
  TELEGRAM_BOT_USERNAME?: string;   // var — t.me deep links, @mention stripping
  RELAY_CANONICAL?: string;      // the public base URL /setup prints (falls back to the request origin)
  PUSH_BUDGET?: string; // per month; default 180 (LINE free plan is 200)
  LINE_OA_ID?: string;  // "@xxxx" — the bot's public basic ID, for line.me deep links
  PRESENCE_GRACE_SEC?: string; // hold an MCP's goodbye this long before telling the principal; default 90
  PRESENCE_STALE_SEC?: string; // dev only: no /p/* call for this long = offline; default 180
  SEEN_PERSIST_SEC?: string;   // dev only: persist seen:<pub> at most this often; default 45 (keep persist + 120 s heartbeat < stale)
  OPERATOR_LINE_USER_ID?: string; // v0.8.1: where `can2cup report` lands (the person who runs this relay)
  INBOX_LEASE_SEC?: string;      // v0.8.0: override the 15-min unanswered lease (dev/smoke only)
  PUSH_USER_BUDGET?: string;   // monthly pushes per target (user or group); default 60 — one noisy stranger must not drain the shared LINE budget
  ROOMS_PER_DAY?: string;      // rooms a hosted identity may open per day; default 10
  GROUP_ROOM_TTL_DAYS?: string; // v0.9.2: how long a room wired to a LINE group lives after its last message; default 30
  MIN_CLIENT?: string;         // v0.9.0: least client version allowed to open rooms / wire groups / invite; default 0.0.0 (gate off)
  LATEST_CLIENT?: string;      // v0.9.0: what `x-can2cup-latest` says when the ASSETS binding (relay-assets/dl/VERSION) is absent
  ASSETS?: { fetch(req: Request): Promise<Response> }; // wrangler [assets] binding — /dl/VERSION is the source of "latest"
  IMG_BYTES_PER_DAY?: string;  // base64 bytes of images one key may host per day; default 5 MB
  IDLE_DAYS?: string;          // v0.9.12: a 1:1 binding expires after the AGENT has been absent this long; default 90 (the boss's call, 2026-09-05)
  IDLE_DAYS_SEC?: string;      // dev/smoke only: the same clock in seconds (per-user /keep values become seconds too)
  IDLE_WARN_SEC?: string;      // how long before expiry the warning goes out; default 14 days
  IDLE_GRACE_SEC?: string;     // after the first sweep on a relay, expiry waits this long (warnings still go); default 30 days
  GROUP_WARN_SEC?: string;     // a wired group is warned this long before its room expires; default 3 days
  IDLE_SWEEP_SEC?: string;     // how often the alarm sweeps; default 1 day
  RELAY_SIGNING_KEY?: string;  // the relay's identity; its public half is what an agent claim (v0.15.2) is bound to
  DEBUG_ROUTES?: string;       // v0.9.13: "1" enables /bridge/debug/* (smoke only). Absent in production → those routes are 404.
  // Hosted agents act on rooms through this binding, not over the network. Typed
  // structurally rather than as DurableObjectNamespace<RoomDO>: importing RoomDO
  // here would be circular (index.ts already imports this module), and fetch is
  // all this side needs.
  ROOMS: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { fetch(req: Request): Promise<Response> };
  };
}

interface Binding { pub: string; name: string; userId: string; agentMode: boolean; boundAt: string }
/** v0.15.2: what /p/principal stored when the registration came with a valid principal-signed claim. */
interface AgentProof { principalPub: string; relayPub: string; at: string; verifiedAt: string }
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
const DASHBOARD_MAX_AGENTS = 50;
const DASHBOARD_PER_HOUR = 60;
/** A chat-account id with only its channel prefix and the first characters kept — enough to tell two accounts apart in
 *  a list, never the whole id (short() keeps eight characters, which for some ids is the whole thing). */
const idHint = (id: string): string => { const i = id.lastIndexOf(":"); const head = i >= 0 ? id.slice(0, i + 1) : ""; const rest = id.slice(i + 1); return `${head}${rest.slice(0, 3)}…`; };
/** v0.8.0 delivery ledger: deliveredAt = handed to a client (lease starts); ackedAt = the agent acted (tell) or
 *  explicitly acked; remindedAt = the principal was told nobody answered. Unacked past the lease → redelivered. */
interface InboxItem { seq: number; at: string; text: string; deliveredAt?: string; deliveredTo?: string; ackedAt?: string; remindedAt?: string; redelivered?: boolean; signed?: SignedPrincipalMsg; via?: string; group?: string /* LINE group the /a came from */; groupAlias?: string; groupName?: string; invite?: string /* a can2cup invite the principal accepted on LINE — the agent auto-joins */; roomRequest?: { name?: string; group: string } /* v0.5.1: /room typed in that group — the agent creates the room and answers on /p/room-created */; guest?: { name: string; group: string; groupName?: string } /* v0.9.4: someone in the group who is NOT this agent's principal — data, never an instruction */; lang?: string /* v0.17.0 */; bound?: { channel: string; lang: string } /* v0.17.0 */ }
interface KnownGroup { id: string; alias: string; name?: string; lastAt: string } // v0.4.5: every group the principal has spoken from, addressable as "group:<alias>"
interface StoredInvite { invite: string; room: string; name: string; fromPub: string; fromName: string; at: number }
const INVITE_TTL_MS = 24 * 3600 * 1000;
interface RoomKnown { name: string; state: string; lastSeq: number; participants: Record<string, string> }
interface Mirror { room: string; all: boolean; by: string; at?: string; lang?: string /* v0.17.0: the group's language, the wirer's to set */ } // at: v0.9.9 (wired since); older mirrors have none
/** v0.9.12: a principal's override of the idle clock. days 0 = never expires (only an explicit "永久" writes 0). */
interface IdlePolicy { days: number; by: "line" | "agent"; at: string }
/** v0.15.0: see deliver(). */
interface Verdict { ok: boolean; channel?: string; status?: number; detail?: string; gate?: "over-budget" | "target-over-budget" | "target-banned" | "room-rate-limited"; text: string }
interface IdleState { days: number; forever: boolean; by: string | null; lastSeen: string | null; idleMs: number; ttlMs: number; expiresAt: string | null }
export interface RoomEvent { room: string; name: string; state: string; participants: Record<string, { name: string }>; envelope: Envelope }
interface Pushed { at: string; to: string; kind: string; text: string; delivered: string; image?: string; sender?: string; attempts?: number }
/** v0.13.0: what the last delivery attempt to a target — and to the channel as a whole — actually did.
 *  A channel that has started refusing (LINE's monthly push quota, a revoked Discord DM permission) used
 *  to be visible only in the relay's own log: `tell` answered "queued", the agent believed its principal
 *  could see it, and the principal saw nothing. The escape hatch has to be able to report that it is shut. */
interface Health { channel: string; okAt?: string; failAt?: string; status?: number; detail?: string }
interface ChannelHealth { state: "ok" | "failing" | "unknown"; channel: string; okAt?: string; failAt?: string; status?: number; detail?: string }
/** attempts/nextAt (review R2): a push that fails transiently (bot cold start, 5xx, rate limit) stays queued and is
 *  retried with backoff instead of being deleted — an escalate the human never saw is the worst failure we have.
 *  card (v0.12.0): a status card whose reply token had expired rides the queue as a push; forwarders get its alt text. */
interface Queued { at: string; to: string; kind: string; text: string; quick?: Quick[]; room?: string; image?: string; sender?: string; card?: Card; attempts?: number; nextAt?: number }
/** v0.12.0: one line of a group's recent chat, kept only while that group has /context on. */
interface GroupLine { at: number; name: string; text: string }
const GROUP_LOG_MAX = 50;
const GROUP_LOG_MS = 6 * 3600_000;
interface ImgMeta { mime: string; expires: number; chunks: number; by: string } // v0.4.5 ephemeral image store
interface OffPend { at: string; due: number } // v0.4.7: a goodbye waiting out its grace before the principal hears about it

/** Types worth a phone buzz. `text` is not — read those in the transcript. */
const DECISION_TYPES = new Set(["question", "proposal", "counter", "accept", "reject", "grant", "revoke", "escalate", "attachment", "close"]);
/** Message-type tags as a chat-app reader sees them (fmtEnvelope), in that reader's language. */
const typeLabel = (L: string): Record<string, string> => ({
  question: tr(L, "❓ 問"), proposal: tr(L, "📝 提案"), counter: tr(L, "↩️ 還價"), accept: tr(L, "✅ 接受"), reject: tr(L, "❌ 拒絕"), withdraw: tr(L, "↪️ 撤回"),
  escalate: tr(L, "🙋 交回老闆"), grant: tr(L, "🔑 授權"), revoke: tr(L, "🚫 撤銷授權"), attachment: tr(L, "📎 附件"), close: tr(L, "🔒 結束"),
});
const systemLabel = (L: string): Record<string, string> => ({ join: tr(L, "接上了"), leave: tr(L, "離開了"), eject: tr(L, "被請出"), rotate: tr(L, "邀請碼已換"), close: tr(L, "結束了"), "mirror-attached": tr(L, "群接上了") });
const CODE_TTL_MS = 10 * 60 * 1000;
const ROOMREQ_TTL_MS = 60 * 60 * 1000; // a /room request waits this long for the agent (it may be asleep)
const ROOM_HOURLY_PUSHES = 40; // one room's share of the shared push budget per hour
const CODE_MISS_PER_HOUR = 10;  // v0.10.3: wrong /link, /setup or /join codes one caller may try per hour before 429
const INVITE_MINT_PER_DAY = 50; // v0.14.3: short invite codes one agent (pub) may mint per day — an anti-amplifier cap; normal use is a handful
const PRESENCE_STALE_MS = 3 * 60 * 1000; // no /p/* call (heartbeat is every 120 s) for this long = offline
// ---- write budget (2026-09-14) -------------------------------------------------------------------------------------
// Workers Free: a SQLite DO may write 100,000 rows a day (put, delete and setAlarm each count; past it every write
// throws until 00:00 UTC). On 2026-09-11..13 our own clients' polling spent it daily — every empty /p/inbox wrote ~3
// rows — and /p/inbox + /p/heartbeat answered 500 until midnight. The rule since: an idle poll writes nothing, and the
// server's cost is bounded however badly a client behaves. The in-memory state below is only a supplement: DO instances
// are evicted after ~70-140 s idle and on every deploy, so each decision to SKIP a write must be safe with empty maps.
/** seen:<pub> is persisted at most this often while an agent stays online (presence also reads the in-memory lastCall).
 *  After an eviction only the stored seen: is left, and it may lag the real last call — if lag + the next heartbeat's
 *  gap reaches the stale limit, a live agent is announced "offline". So a heartbeat (/p/heartbeat, /p/online) persists
 *  seen: once BEAT_PERSIST_MS have passed, whatever SEEN_PERSIST_MS says.
 *  INVARIANT: BEAT_PERSIST_MS + the MCP heartbeat (120 s, src/mcp/index.ts) + jitter must stay < PRESENCE_STALE_MS
 *  (180 s): 30 + 120 leaves 30 s. (Review 2026-09-14: 45 s on every call left ~15 s after an eviction.) */
const SEEN_PERSIST_MS = 45_000;
const BEAT_PERSIST_MS = 30_000;
const UNBOUND_SEEN_PERSIST_MS = 3_600_000; // keys with no binding and no hosted: key — nobody is told about their presence
const META_PERSIST_MS = 600_000;           // ver:/host: rewrite at most this often per key (two processes on one key may disagree)
// per pub, in memory: 60 back-to-back reads, then one per 2 s. Generous on purpose: send, wait and the commit gate all
// read the inbox, and a refused read makes the gate refuse a commitment. The bucket is for a client stuck in a loop with
// no sleep at all — writes are already bounded above, and a 429 still counts as a DO request, so tighter buys little.
const INBOX_BUCKET = { burst: 60, refillMs: 2000 };
const BOOKKEEPING_WRITES_PER_HOUR = 1500;  // global cap on presence/version bookkeeping writes; spent → skip them (log once an hour)
const POLL_AFTER_SEC = 30;                 // x-can2cup-poll-after on an empty inbox / room poll
const POLL_AFTER_SLOW_SEC = 60;            // …when that key's inbox bucket is below half
const MAP_MAX = 10_000;                    // in-memory maps drop their oldest entries past this
const PUSH_MAX_ATTEMPTS = 6;                 // review R2: ~30s,1m,2m,4m,8m,16m of backoff before a push is given up
const REPORT_TTL_MS = 30 * 24 * 3600 * 1000; // review R4: what /privacy promises
const REPORT_PUSHES_PER_DAY = 20;            // review R4: reports must never eat the user-facing push budget
const INBOX_LEASE_MS_DEFAULT = 15 * 60 * 1000; // v0.8.0: delivered but not acked for this long = nobody was listening → remind + redeliver
const OFFLINE_GRACE_SEC = 90;            // > the 60 s heartbeat, so a sibling session cancels the goodbye before it is announced
const IMG_TTL_DEFAULT = 3600;  // LINE clients fetch the URL when each viewer first opens the chat — too short and late viewers see a broken image
const IMG_TTL_MIN = 2;         // floor exists for smoke tests; humans should stay >= 50
const IMG_TTL_MAX = 86400;
const IMG_CHUNK = 100_000;     // DO storage values are capped at 128 KiB; base64 chunks stay under it

export class BridgeDO extends DurableObject<BridgeEnv> {
  private app = new Hono();
  /** v0.12.0: the console (bot.ts) calls the /bridge/* routes in-process with this key. It is minted per DO
   *  instance and never leaves the isolate, so the routes stay gated for everyone else exactly as before. */
  private internalKey = randomHex(16);
  /** v0.15.0: every chat app this relay speaks, in id-resolution order (channels.ts). Nothing below names one. */
  private channels: Channel[];

  constructor(ctx: DurableObjectState, env: BridgeEnv) {
    super(ctx, env);
    const store = { get: <T,>(k: string) => this.get<T>(k), put: (k: string, v: unknown) => this.put(k, v), del: (k: string) => this.del(k).then(() => undefined) };
    this.channels = makeChannels(env, store);
    this.routes();
  }
  /** The channel an id belongs to (by the prefix it carries; bare ids fall to LINE) and the channel by name. */
  private chanFor(id: string | undefined): Channel { return channelFor(this.channels, id); }
  private chan(name: string): Channel { return channelNamed(this.channels, name); }

  override async fetch(req: Request): Promise<Response> {
    return this.app.fetch(req);
  }

  // ------------------------------------------------------------ helpers ---

  private get<T>(k: string): Promise<T | undefined> { return this.ctx.storage.get<T>(k); }
  // Every write in this DO goes through put / del / setAlarmAt, so the debug counter (DEBUG_ROUTES=1) sees all of them.
  private put(k: string, v: unknown): Promise<void> { this.countWrite("put", k); return this.ctx.storage.put(k, v); }
  private del(k: string): Promise<boolean> { this.countWrite("delete", k); return this.ctx.storage.delete(k); }
  private setAlarmAt(at: number): Promise<void> { this.countWrite("setAlarm", this.inAlarm > 0 ? "(alarm)" : "(request)"); return this.ctx.storage.setAlarm(at); }

  // ---- write budget: in-memory supplements (see SEEN_PERSIST_MS). Lost on eviction; nothing below may depend on them.
  private lastCall = new Map<string, number>();                     // pub → ms of its last presence-touching /p/* call
  private metaWritten = new Map<string, number>();                  // "ver:<pub>" / "host:<pub>" → ms we last wrote it
  private buckets = new Map<string, { tokens: number; at: number }>(); // pub → /p/inbox token bucket
  private bookkeeping = { hour: -1, n: 0, warned: false, failWarned: false };
  private inAlarm = 0;
  /** A bounded map set: re-inserting moves the key to the newest end, so the oldest entries go first. */
  private static remember<V>(m: Map<string, V>, k: string, v: V): void {
    m.delete(k); m.set(k, v);
    while (m.size > MAP_MAX) { const first = m.keys().next().value; if (first === undefined) break; m.delete(first); }
  }
  private staleMs(pub?: string): number {
    const d = pub && this.env.DEBUG_ROUTES === "1" ? this.debugTimers.get(pub)?.staleMs : undefined;
    if (d) return d;
    const s = Number(this.env.PRESENCE_STALE_SEC);
    return s > 0 ? s * 1000 : PRESENCE_STALE_MS;
  }
  private seenPersistMs(pub?: string): number {
    const d = pub && this.env.DEBUG_ROUTES === "1" ? this.debugTimers.get(pub)?.persistMs : undefined;
    if (d) return d;
    const s = Number(this.env.SEEN_PERSIST_SEC);
    return s > 0 ? s * 1000 : SEEN_PERSIST_MS;
  }
  /** One bookkeeping write allowed under the global hourly cap? Spent → false, and one console.error per hour. */
  private bookkeepingAllowed(): boolean {
    const hour = Math.floor(Date.now() / 3_600_000);
    if (hour !== this.bookkeeping.hour) this.bookkeeping = { hour, n: 0, warned: false, failWarned: false };
    if (this.bookkeeping.n >= BOOKKEEPING_WRITES_PER_HOUR) {
      if (!this.bookkeeping.warned) { this.bookkeeping.warned = true; console.error(`bridge: ${BOOKKEEPING_WRITES_PER_HOUR} presence/version bookkeeping writes spent this hour — skipping them until the hour turns`); }
      return false;
    }
    this.bookkeeping.n++;
    return true;
  }
  /** A bookkeeping write (seen / stale / host / ver / read): never allowed to fail the request it rides on. A write
   *  that throws (the daily row cap) is logged once an hour and swallowed. `budget: false` skips the hourly cap. */
  private async bookkeep(write: () => Promise<unknown>, opts: { budget?: boolean } = {}): Promise<boolean> {
    if (opts.budget !== false && !this.bookkeepingAllowed()) return false;
    try { await write(); return true; }
    catch (e) {
      if (!this.bookkeeping.failWarned) { this.bookkeeping.failWarned = true; console.error(`bridge: a bookkeeping write failed (${e instanceof Error ? e.message : String(e)}) — the request goes on without it`); }
      return false;
    }
  }
  /** /p/inbox token bucket, entirely in memory (no storage access on the 429 path). */
  private takeInboxToken(pub: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const spec = this.bucketSpec(pub);
    const b = this.buckets.get(pub) ?? { tokens: spec.burst, at: now };
    b.tokens = Math.min(spec.burst, b.tokens + (now - b.at) / spec.refillMs);
    b.at = now;
    BridgeDO.remember(this.buckets, pub, b);
    if (b.tokens < 1) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - b.tokens) * spec.refillMs) / 1000)) };
    b.tokens -= 1;
    return { ok: true };
  }

  // ---- debug-only (DEBUG_ROUTES=1): a write counter and per-agent presence timers, for the smoke suite ----
  private debugWrites = { put: 0, delete: 0, setAlarm: 0, keys: new Map<string, number>() };
  private debugInboxCalls = new Map<string, number>();
  private debugTimers = new Map<string, { staleMs?: number; persistMs?: number }>();
  /** The smoke suite drives single keys far faster than any agent; it lifts the inbox bucket relay-wide (stored, so a
   *  restarted instance still has it) and puts the production numbers back on the keys whose tests are about the bucket. */
  private debugBucket: { burst: number; refillMs: number } | null | undefined; // undefined = not loaded in this instance
  private debugBucketFor = new Map<string, { burst: number; refillMs: number }>();
  private bucketSpec(pub: string): { burst: number; refillMs: number } {
    if (this.env.DEBUG_ROUTES !== "1") return INBOX_BUCKET;
    return this.debugBucketFor.get(pub) ?? this.debugBucket ?? INBOX_BUCKET;
  }
  private countWrite(op: "put" | "delete" | "setAlarm", key: string): void {
    if (this.env.DEBUG_ROUTES !== "1") return;
    this.debugWrites[op]++;
    const k = op === "setAlarm" ? `setAlarm${key}` : key;
    BridgeDO.remember(this.debugWrites.keys, k, (this.debugWrites.keys.get(k) ?? 0) + 1);
  }

  private async bindingByPub(pub: string): Promise<Binding | undefined> { return this.get<Binding>(`pub:${pub}`); }
  private async bindingByUser(userId: string): Promise<Binding | undefined> { return this.get<Binding>(`user:${userId}`); }

  /** What the remote MCP connector may see and do. Two tiers live behind this:
   *  an agent whose key is on its owner's machine is read-only here (we cannot sign
   *  for it), while a hosted agent's key IS in this DO under `hosted:<pub>` and can
   *  be signed with — but only after the same mandate check the local client runs,
   *  so nothing binding leaves unless its owner widened the rules. Custody is
   *  disclosed publicly at GET /hosted/:pub. */
  private mcpDeps(): McpDeps {
    return {
      get: (k) => this.get(k),
      put: (k, v) => this.put(k, v),
      del: (k) => this.del(k).then(() => undefined),
      bindingByUser: (u) => this.bindingByUser(u),
      bindingByPub: (p) => this.bindingByPub(p),
      roomsFor: async (p) => (await this.get<Record<string, RoomKnown>>(`rooms:${p}`)) ?? {},
      pendingInbox: async (p) => {
        const lastRead = await this.get<string>(`read:${p}`);
        const items = (await this.get<InboxItem[]>(`inbox:${p}`)) ?? [];
        return items.filter((i) => !lastRead || i.at > lastRead).length;
      },
      awayAt: (p) => this.get<string>(`offline:${p}`),
      noteCall: (p) => BridgeDO.remember(this.lastCall, p, Date.now()),
      isPaused: async (p) => (await this.get<boolean>(`paused:${p}`)) ?? false,
      provenPrincipal: (p) => this.provenPrincipal(p),
      dashboardFor: async (p, o) => { const limited = await this.dashboardRateLimited(p); if (limited) throw new Error(limited); return this.dashboardFor(p, o); },
      lineOa: () => this.env.LINE_OA_ID,
      telegramBot: () => (this.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "") || undefined,
      limits: () => ({ roomsPerDay: Math.max(1, Number(this.env.ROOMS_PER_DAY ?? 10) || 10) }),
      newRoomId: () => randomHex(6),
      roomCall: (roomId, subpath, init) =>
        this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId))
          .fetch(new Request(`https://do/rooms/${roomId}${subpath}`, init)),
      // Same both-directions replacement as /bridge/link: one user ↔ one agent.
      bind: async (userId, pub, name) => {
        const prevByUser = await this.bindingByUser(userId);
        if (prevByUser) await this.del(`pub:${prevByUser.pub}`);
        const prevByPub = await this.bindingByPub(pub);
        if (prevByPub) await this.del(`user:${prevByPub.userId}`);
        const b: Binding = { pub, name, userId, agentMode: false, boundAt: new Date().toISOString() };
        await this.put(`user:${userId}`, b);
        await this.put(`pub:${pub}`, b);
      },
    };
  }

  private async verifyAgent(c: { req: { header: (n: string) => string | undefined; method: string; path: string; text: () => Promise<string> } }): Promise<{ pub: string; body: string } | Response> {
    const body = await c.req.text();
    const v = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, body);
    if (!v.ok) return Response.json({ error: `agent signature: ${v.error}` }, { status: 401 });
    return { pub: v.pub, body };
  }

  // ---- presence --------------------------------------------------------------------------
  private async presence(pub: string): Promise<{ online: boolean; lastSeen: string | null; lastRead: string | null; offlineAt: string | null; sinceMin: number | null }> {
    // 2026-09-14: seen: is persisted lazily (SEEN_PERSIST_MS); the in-memory last call fills the gap while this instance lives.
    const storedSeen = await this.get<string>(`seen:${pub}`);
    const seenMs = Math.max(storedSeen ? Date.parse(storedSeen) || 0 : 0, this.lastCall.get(pub) ?? 0);
    const lastSeen = seenMs ? new Date(seenMs).toISOString() : null;
    const lastRead = (await this.get<string>(`read:${pub}`)) ?? null;
    const offlineAt = (await this.get<string>(`offline:${pub}`)) ?? null;
    // A goodbye inside its grace is not yet an absence: it may be one of several sessions closing,
    // and the next heartbeat (<= 60 s) would take it back. Report "still here" until the grace runs
    // out — otherwise the bot tells the principal "away" for a minute and then has to take it back.
    const pend = await this.get<OffPend>(`offpend:${pub}`);
    const held = !!pend && Date.now() < pend.due;
    const online = !!lastSeen && (held || !(offlineAt && Date.parse(offlineAt) >= seenMs)) && Date.now() - seenMs < this.staleMs(pub);
    const sinceMin = online ? null : seenMs ? Math.max(0, Math.round((Date.now() - seenMs) / 60000)) : null;
    return { online, lastSeen, lastRead, offlineAt, sinceMin };
  }
  private graceMs(): number {
    const s = Number(this.env.PRESENCE_GRACE_SEC ?? OFFLINE_GRACE_SEC);
    return (Number.isFinite(s) && s >= 0 ? s : OFFLINE_GRACE_SEC) * 1000;
  }
  /** Move the alarm earlier if needed; never later (the push queue owns the near end of it). */
  /** v0.8.0: mark delivered items ≤ seq as acked. Returns how many changed. */
  private async ackInbox(pub: string, seq: number): Promise<number> {
    const all = (await this.get<InboxItem[]>(`inbox:${pub}`)) ?? [];
    let n = 0;
    const now = new Date().toISOString();
    for (const i of all) if (i.deliveredAt && !i.ackedAt && i.seq <= seq) { i.ackedAt = now; n++; }
    if (n) await this.put(`inbox:${pub}`, all);
    return n;
  }

  /** v0.8.0: items delivered, never acked, lease expired, principal not yet told → one LINE reminder each.
   *  Returns the next time something will be due, so the alarm keeps itself armed. */
  private async sweepUnacked(): Promise<number | null> {
    let next: number | null = null;
    const now = Date.now();
    for (const [key, all] of await this.ctx.storage.list<InboxItem[]>({ prefix: "inbox:" })) {
      const pub = key.slice("inbox:".length);
      let changed = false;
      const overdue: InboxItem[] = [];
      for (const i of all) {
        if (!i.deliveredAt || i.ackedAt || i.remindedAt) continue;
        const due = Date.parse(i.deliveredAt) + this.leaseMs();
        if (now >= due) { overdue.push(i); i.remindedAt = new Date(now).toISOString(); changed = true; }
        else next = next == null ? due : Math.min(next, due);
      }
      if (!changed) continue;
      await this.put(key, all);
      const b = await this.bindingByPub(pub);
      if (!b) continue;
      // review R17: one reminder per place they asked from (DM, group A, group B), not one lump to the first.
      const byDest = new Map<string, InboxItem[]>();
      for (const i of overdue) { const to = i.group || b.userId; byDest.set(to, [...(byDest.get(to) ?? []), i]); }
      for (const [to, list] of byDest) {
        const first = list[0];
        const L = await this.placeLang(to);
        await this.push(to, "inbox:unanswered",
          tr(L, "⚠️ 你 {min} 分鐘前交代的事（{which}）agent 收到了但沒有回應。\n它下次值班會再拿到一次；一直沒回就看看那台電腦的 Claude Code 是否開著、值班（can2cup watch）是否在跑。", { min: Math.round((now - Date.parse(first.at)) / 60000), which: list.length > 1 ? tr(L, "#{seq} 等 {n} 則", { seq: first.seq, n: list.length }) : `#${first.seq}` }),
          undefined, undefined, undefined, b.name || short(pub));
      }
    }
    return next;
  }

  /** review R4/R10/R25: storage that must not grow forever. */
  // ---------------------------------------------------------- binding lifetime (v0.9.12) ---
  // Security review "binding lifetime" (2026-09-05; the boss set 90 days). Principle: a 1:1 binding expires on
  // the AGENT's absence, never on the principal's silence — the binding is the principal's brake and their
  // notification path, and a quiet principal may have an agent busy on their behalf. seen:<pub> is written only
  // by signed /p/* calls, so nobody can age a binding from outside. Warned first (T-14 d: one LINE push + one inbox
  // item; reading that item is itself a renewal). On expiry, erase(binding) KEEPS principal:<pub> and spause:<pub>:
  // the signed layer is independent of the LINE binding, so a signed pause never lifts because a binding lapsed.
  // Hosted agents (key in this DO, no heartbeat) are excluded. Group wires follow their room's life instead.
  private idleUnitMs(): number { return Number(this.env.IDLE_DAYS_SEC) > 0 ? 1000 : 86400_000; }
  private idleSpec(): { ttlMs: number; warnMs: number; graceMs: number; groupWarnMs: number; sweepMs: number } {
    const devSec = Number(this.env.IDLE_DAYS_SEC);
    const ttlMs = devSec > 0 ? devSec * 1000 : Math.max(7, Number(this.env.IDLE_DAYS ?? 90) || 90) * 86400_000;
    const warnSec = Number(this.env.IDLE_WARN_SEC);
    const warnMs = Math.min(warnSec > 0 ? warnSec * 1000 : 14 * 86400_000, ttlMs / 2);
    const graceMs = this.env.IDLE_GRACE_SEC != null && Number.isFinite(Number(this.env.IDLE_GRACE_SEC)) ? Number(this.env.IDLE_GRACE_SEC) * 1000 : 30 * 86400_000;
    const gw = Number(this.env.GROUP_WARN_SEC);
    const sw = Number(this.env.IDLE_SWEEP_SEC);
    return { ttlMs, warnMs, graceMs, groupWarnMs: gw > 0 ? gw * 1000 : 3 * 86400_000, sweepMs: sw > 0 ? sw * 1000 : 86400_000 };
  }
  private fmtIdle(ms: number, L: string): string { return this.idleUnitMs() === 1000 ? tr(L, "{n} 秒", { n: Math.max(0, Math.round(ms / 1000)) }) : tr(L, "{n} 天", { n: Math.max(0, Math.round(ms / 86400_000)) }); }
  /** The clock for one binding: how long the agent has been gone, when it expires, and any /keep override. */
  private async idleOf(pub: string, b: Binding): Promise<IdleState> {
    const spec = this.idleSpec();
    const pol = await this.get<IdlePolicy>(`idle:${pub}`);
    const forever = pol?.days === 0;
    const ttlMs = pol && pol.days > 0 ? pol.days * this.idleUnitMs() : spec.ttlMs;
    // 2026-09-14: seen: is persisted lazily; this instance's last call (local agent or hosted connector) counts too.
    const storedSeen = (await this.get<string>(`seen:${pub}`)) ?? null;
    const seenMs = Math.max(storedSeen ? Date.parse(storedSeen) || 0 : 0, this.lastCall.get(pub) ?? 0);
    const lastSeen = seenMs ? new Date(seenMs).toISOString() : null;
    const base = Date.parse(lastSeen ?? b.boundAt ?? "") || Date.now();
    const idleMs = Date.now() - base;
    return { days: forever ? 0 : Math.round(ttlMs / this.idleUnitMs()), forever, by: pol?.by ?? null, lastSeen, idleMs, ttlMs, expiresAt: forever ? null : new Date(base + ttlMs).toISOString() };
  }
  /** Ask the RoomDO (in-process, not over the network) whether a wired room is still alive and when it ends. */
  private async roomMeta(room: string): Promise<{ state: string; expiresAt: string; keepAliveSec: number } | null> {
    try {
      const res = await this.env.ROOMS.get(this.env.ROOMS.idFromName(room)).fetch(new Request(`https://do/rooms/${room}/internal/meta`));
      return res.ok ? (await res.json()) as { state: string; expiresAt: string; keepAliveSec: number } : null;
    } catch { return null; }
  }
  /** The principal spoke to the agent from a wired group: that is use, so the room's sliding life moves forward. */
  private async touchRoom(room: string): Promise<void> {
    try { await this.env.ROOMS.get(this.env.ROOMS.idFromName(room)).fetch(new Request(`https://do/rooms/${room}/internal/keepalive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ touch: true }) })); }
    catch { /* best effort */ }
  }
  private async unwireGroup(gid: string, m: Mirror): Promise<void> {
    await this.del(`mirror:${gid}`);
    await this.del(`ctx:${gid}`);
    await this.del(`glog:${gid}`);
    await this.del(`quiet:${gid}`);
    await this.del(`mirrorwarn:${gid}`);
    const list = ((await this.get<string[]>(`mirrors:${m.room}`)) ?? []).filter((g) => g !== gid);
    if (list.length) await this.put(`mirrors:${m.room}`, list); else await this.del(`mirrors:${m.room}`);
  }
  /** One pass over bindings and group wires. `only` narrows it to one pub / one group (smoke uses that so the
   *  other agents in the run are never touched). Returns what it did. */
  private async sweepIdle(only: { pub?: string; gid?: string } = {}): Promise<{ warned: string[]; expired: string[]; groupsWarned: string[]; groupsEnded: string[] }> {
    const out = { warned: [] as string[], expired: [] as string[], groupsWarned: [] as string[], groupsEnded: [] as string[] };
    const spec = this.idleSpec();
    let since = await this.get<string>("idle:since"); // the first sweep on this relay starts the grace period
    if (!since) { since = new Date().toISOString(); await this.put("idle:since", since); }
    const graceOver = Date.now() - Date.parse(since) >= spec.graceMs;
    const targets: Array<[string, Binding]> = only.gid && !only.pub ? []
      : only.pub ? ((await this.get<Binding>(`pub:${only.pub}`)) ? [[only.pub, (await this.get<Binding>(`pub:${only.pub}`))!]] : [])
      : [...(await this.ctx.storage.list<Binding>({ prefix: "pub:" }))].map(([k, b]) => [k.slice(4), b] as [string, Binding]);
    for (const [pub, b] of targets) {
      // v0.9.14: hosted agents are covered too — the connector marks them seen on every call (mcp-http.ts).
      const st = await this.idleOf(pub, b);
      if (st.forever) continue;
      const name = b.name || short(pub);
      const L = await this.placeLang(b.userId); // read before erase() takes the binding away
      if (st.idleMs >= st.ttlMs && graceOver) {
        await this.erase(pub, "binding", { keepSigned: true });
        await this.del(`idlewarn:${pub}`);
        await this.push(b.userId, "idle:expired", tr(L, "已自動解除跟「{name}」的綁定：那台電腦上的 agent 已經 {idle} 沒出現。電腦上的檔案還在；要重接就打 /setup。你簽過的煞車和金鑰登記都沒有動。", { name, idle: this.fmtIdle(st.idleMs, L) }));
        out.expired.push(pub);
        continue;
      }
      if (st.idleMs >= st.ttlMs - spec.warnMs) {
        if (await this.get(`idlewarn:${pub}`)) continue;
        await this.put(`idlewarn:${pub}`, new Date().toISOString());
        const leftMs = Math.max(0, st.ttlMs - st.idleMs);
        await this.push(b.userId, "idle:warn", tr(L, "你的 agent「{name}」已經 {idle} 沒出現。再 {left} 這個綁定會自動解除；它只要開一次（Claude Code 打開）就會續。要一直留著就打 /keep 永久。", { name, idle: this.fmtIdle(st.idleMs, L), left: this.fmtIdle(leftMs, L) }));
        await this.appendInbox(pub, { at: new Date().toISOString(), via: "relay", text: `BINDING EXPIRES in ${this.fmtIdle(leftMs, "en")} — this agent has not been seen for ${this.fmtIdle(st.idleMs, "en")}. Any signed call renews it; reading this is one. Nothing else to do.` });
        out.warned.push(pub);
      } else if (await this.get(`idlewarn:${pub}`)) await this.del(`idlewarn:${pub}`); // renewed after a warning
    }
    // group wires follow their room: dead room → wire goes, group is told; T-3 d → group is warned once
    const wires: Array<[string, Mirror]> = only.pub && !only.gid ? []
      : only.gid ? ((await this.get<Mirror>(`mirror:${only.gid}`)) ? [[only.gid, (await this.get<Mirror>(`mirror:${only.gid}`))!]] : [])
      : [...(await this.ctx.storage.list<Mirror>({ prefix: "mirror:" }))].map(([k, m]) => [k.slice(7), m] as [string, Mirror]);
    for (const [gid, m] of wires) {
      const meta = await this.roomMeta(m.room);
      const known = await this.get<RoomKnown>(`room:${m.room}`);
      const dead = !meta ? known?.state === "closed" : meta.state !== "open" || Date.now() >= Date.parse(meta.expiresAt);
      const GL = isLang(m.lang) ? m.lang : LEGACY_LANG; // the group's language, read off the wire before it goes
      if (dead) {
        await this.unwireGroup(gid, m);
        await this.push(gid, "group:ended", tr(GL, "這個群跟 agent 的連線已結束（那段對話{why}）。要重接，群裡有綁定的人打 /room。", { why: meta && meta.state === "open" ? tr(GL, "已到期，{idle}沒有人說話", { idle: this.fmtIdle(meta.keepAliveSec * 1000, GL) }) : tr(GL, "已關閉") }));
        out.groupsEnded.push(gid);
        continue;
      }
      if (!meta) continue;
      const left = Date.parse(meta.expiresAt) - Date.now();
      if (left <= spec.groupWarnMs) {
        if (await this.get(`mirrorwarn:${gid}`)) continue;
        await this.put(`mirrorwarn:${gid}`, new Date().toISOString());
        await this.push(gid, "group:warn", tr(GL, "這個群跟 agent 的對話已經很久沒動了，再 {left} 會自動斷開。任何人打 /a 說一句、或 agent 在這裡講話，就會續。", { left: this.fmtIdle(left, GL) }));
        out.groupsWarned.push(gid);
      } else if (await this.get(`mirrorwarn:${gid}`)) await this.del(`mirrorwarn:${gid}`);
    }
    return out;
  }
  /** /keep from either side. days 7..365, or forever:true → 0. Neither given = no change (the caller just wants to see). */
  private async setIdle(pub: string, body: { days?: unknown; forever?: unknown }, by: "line" | "agent"): Promise<{ ok: true } | { error: string }> {
    if (body.forever === true) { await this.put(`idle:${pub}`, { days: 0, by, at: new Date().toISOString() } satisfies IdlePolicy); return { ok: true }; }
    if (body.days === undefined || body.days === null) return { ok: true };
    const d = Math.round(Number(body.days));
    if (!Number.isFinite(d) || d < 7 || d > 365) return { error: "days must be between 7 and 365 (or forever: true)" };
    await this.put(`idle:${pub}`, { days: d, by, at: new Date().toISOString() } satisfies IdlePolicy);
    return { ok: true };
  }
  /** Runs from the alarm at most once per sweep interval; returns when to look again. */
  private async maybeSweepIdle(): Promise<number> {
    const spec = this.idleSpec();
    const last = Date.parse((await this.get<string>("idle:sweptAt")) ?? "") || 0;
    if (Date.now() - last >= spec.sweepMs) {
      await this.put("idle:sweptAt", new Date().toISOString());
      try { await this.sweepIdle(); } catch (e) { console.error(`sweepIdle: ${e instanceof Error ? e.message : String(e)}`); }
      return Date.now() + spec.sweepMs;
    }
    return last + spec.sweepMs;
  }

  private async purgeExpired(): Promise<void> {
    const now = Date.now();
    for (const [k, v] of await this.ctx.storage.list<{ at: string }>({ prefix: "report:" })) if (now - Date.parse(v.at) > REPORT_TTL_MS) await this.del(k);
    for (const [k, v] of await this.ctx.storage.list<StoredInvite>({ prefix: "inv:" })) if (now - v.at > INVITE_TTL_MS) await this.del(k);
    for (const [k, v] of await this.ctx.storage.list<{ at: number }>({ prefix: "evt:" })) if (now - v.at > 24 * 3600 * 1000) await this.del(k);
    // v0.16.0: a link code that was never redeemed used to stay forever (only redemption deleted it)
    for (const [k, v] of await this.ctx.storage.list<{ at: number; ttlMs?: number }>({ prefix: "code:" })) if (now - v.at > (v.ttlMs ?? CODE_TTL_MS) + 3600_000) await this.del(k);
    for (const [k, v] of await this.ctx.storage.list<{ at: number; ttlMs?: number }>({ prefix: "pcode:" })) if (now - v.at > (v.ttlMs ?? CODE_TTL_MS) + 3600_000) await this.del(k);
    await this.purgeCounters(now);
  }
  /** v0.16.0 (pre-release review): every rate / quota counter is keyed by a time bucket — an ISO hour (q:code, q:guest,
   *  q:oauthmiss), an hour index (rl:, q:dash), a day (q:inv, q:rooms, q:img, q:reportpush) or a month (quota:*,
   *  opwarn:) — and nothing ever deleted the old buckets, so the DO grew by one key per (subject, period) forever.
   *  Once a day, drop buckets older than two periods; the current and previous period stay, so no live gate moves. */
  private async purgeCounters(now: number): Promise<void> {
    const today = new Date(now).toISOString().slice(0, 10);
    if ((await this.get<string>("purge:counters")) === today) return;
    await this.put("purge:counters", today);
    const H = 3600_000, D = 24 * H;
    const ageOf = (bucket: string): number | null => {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(bucket)) return now - Date.parse(`${bucket}:00:00Z`);          // ISO hour
      if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return now - Date.parse(`${bucket}T00:00:00Z`);              // day
      if (/^\d{4}-\d{2}$/.test(bucket)) return now - Date.parse(`${bucket}-01T00:00:00Z`);                 // month
      if (/^\d{5,9}$/.test(bucket)) return now - Number(bucket) * H;                                        // hour index
      return null;
    };
    const keep = (bucket: string, age: number): boolean =>
      /T\d{2}$/.test(bucket) || /^\d{5,9}$/.test(bucket) ? age <= 3 * H : bucket.length === 10 ? age <= 3 * D : age <= 62 * D;
    for (const prefix of ["q:", "rl:", "quota:", "opwarn:", "reports:"]) {
      for (const k of (await this.ctx.storage.list({ prefix })).keys()) {
        const bucket = k.slice(k.lastIndexOf(":") + 1);
        const age = ageOf(bucket);
        if (age != null && !keep(bucket, age)) await this.del(k);
      }
    }
  }

  /** review R2: one operator warning per key per month (the operator push shares the budget, so it must be rare). */
  private async warnOperatorOnce(what: string, text: string): Promise<void> {
    const op = this.env.OPERATOR_LINE_USER_ID;
    if (!op) return;
    const k = `opwarn:${what}:${new Date().toISOString().slice(0, 7)}`;
    if (await this.get(k)) return;
    await this.put(k, true);
    // straight to the operator's channel (or the forwarder), bypassing the quota gate that just tripped
    const ch = this.chanFor(op);
    if (ch.enabled) { await ch.push(op, { text }); return; }
    if (this.env.LINE_FORWARD_URL) { try { await fetch(this.env.LINE_FORWARD_URL, { method: "POST", headers: { "content-type": "application/json", "x-parley-bridge-key": this.env.BRIDGE_KEY ?? "" }, body: JSON.stringify({ to: op, text, quick: [] }), signal: AbortSignal.timeout(20000) }); } catch { /* best effort */ } }
  }

  // ---- v0.12.0: the LINE webhook, answered here ------------------------------------------------
  /** The console's view of this DO: the /bridge/* routes, called in-process (no network, no shared key on the wire). */
  private botApi(): BotApi {
    return { call: async <T,>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> => {
      const res = await this.app.request(path, { method, headers: { "content-type": "application/json", "x-parley-bridge-key": this.internalKey }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new BridgeError(res.status, j);
      return j as T;
    } };
  }
  private botCtx(origin: string, ch: Channel, lang: string): BotCtx {
    return {
      lang,
      origin: (this.env.RELAY_CANONICAL ?? "").trim().replace(/\/+$/, "") || origin,
      vocab: vocabIn(ch, lang),
      userName: (u, g) => this.chanFor(u).userName(u, g),
      groupName: (g) => this.chanFor(g).groupName(g),
      groupTranscript: (g) => this.groupTranscript(g),
      hasPage: (p) => hasAsset(this.env, p),
    };
  }
  // ---- language (v0.17.0) -----------------------------------------------------------------------
  /** The language this chat account is spoken to in, by the bot and by its agent — chosen with /lang or the picker at
   *  /setup. Unset: an account bound before languages existed keeps Traditional Chinese (it was onboarded in it);
   *  anyone else gets the platform's locale when it names one of LANGS, else English. */
  private async userLang(userId: string | undefined, locale?: string): Promise<string> {
    if (userId) {
      const set = await this.get<string>(`ulang:${userId}`);
      if (isLang(set)) return set;
      if (await this.bindingByUser(userId)) return LEGACY_LANG;
    }
    return normLang(locale) ?? DEFAULT_LANG;
  }
  /** A wired group's language (its wirer's to set); a mirror from before languages speaks Traditional Chinese. */
  private async groupLang(gid: string): Promise<string | undefined> {
    const m = await this.get<Mirror>(`mirror:${gid}`);
    return m ? (isLang(m.lang) ? m.lang : LEGACY_LANG) : undefined;
  }
  /** Where a push goes → the language to say it in. */
  private async placeLang(to: string): Promise<string> { return (await this.groupLang(to)) ?? (await this.userLang(to)); }
  /** One channel event → the console's language: the group's when it is wired, else the speaker's. */
  private async eventLang(ev: Incoming): Promise<string> {
    if (ev.place.kind === "group") { const g = await this.groupLang(ev.place.id); if (g) return g; }
    return this.userLang(ev.userId, ev.locale);
  }
  /** A chat account has just bound this agent. Its language is fixed now (so it no longer drifts with the platform's
   *  locale), and the agent is asked to introduce itself, in that language and in its own words. The text is for
   *  clients from before 0.17.0; a current one builds its own from `bound` and reads nothing but the code. */
  private async onBound(userId: string, pub: string, lang: string): Promise<void> {
    if (!isLang(await this.get<string>(`ulang:${userId}`))) await this.put(`ulang:${userId}`, lang);
    const ch = this.chanFor(userId);
    const l = langInfo(lang) ?? langInfo(DEFAULT_LANG)!;
    await this.appendInbox(pub, {
      at: new Date().toISOString(), via: ch.name, lang, bound: { channel: ch.name, lang },
      // an event, not an instruction: handed out once, never redelivered, never an "unanswered" reminder to the boss
      ackedAt: new Date().toISOString(),
      text: `CHAT APP CONNECTED — your boss just bound this agent to their ${ch.label} account. Introduce yourself once, with can2cup_tell_principal, in ${l.name}: your name, that you are the AI agent on their computer, what they can hand you (${l.roles}), and that anything that commits them comes back to them first. Address them as ${l.address ? `"${l.address}"` : "their name"}.`,
    });
  }
  /** Group chat is kept ONLY while that group has said /context on, and only the last 50 lines / 6 h — the words
   *  belong to everyone in the group, so nothing is stored until the wirer opted in and anyone can turn it off. */
  private async logGroup(ev: Incoming): Promise<void> {
    if (ev.place.kind !== "group" || !ev.text || !(await this.get<boolean>(`ctx:${ev.place.id}`))) return;
    const name = (ev.userId ? await this.chan(ev.channel).userName(ev.userId, ev.place.id) : undefined) ?? (ev.userId ? short(ev.userId) : "?");
    const now = Date.now();
    const lines = ((await this.get<GroupLine[]>(`glog:${ev.place.id}`)) ?? []).filter((l) => now - l.at < GROUP_LOG_MS);
    lines.push({ at: now, name, text: ev.text.slice(0, 500) });
    await this.put(`glog:${ev.place.id}`, lines.slice(-GROUP_LOG_MAX));
  }
  private async groupTranscript(gid: string): Promise<string> {
    if (!(await this.get<boolean>(`ctx:${gid}`))) return "";
    const now = Date.now();
    return ((await this.get<GroupLine[]>(`glog:${gid}`)) ?? []).filter((l) => now - l.at < GROUP_LOG_MS).map((l) => `${l.name}：${l.text}`).join("\n");
  }
  /** One channel event, end to end: dedup → the console → reply (free) or, when the token has died, the push queue. */
  private async onChannelEvent(ev: Incoming, origin: string): Promise<void> {
    if (ev.eventId) { const k = `evt:wh:${ev.eventId}`; if (await this.get(k)) return; await this.put(k, { at: Date.now() }); }
    const ch = this.chan(ev.channel);
    const api = this.botApi(); const ctx = this.botCtx(origin, ch, await this.eventLang(ev));
    const isGroup = ev.place.kind === "group";
    const say = (s: string): Quick => ({ label: s, text: s });
    let out: Handled = null;
    switch (ev.kind) {
      case "follow": {
        if (ev.userId) await ch.setMenu?.(ev.userId, (await this.bindingByUser(ev.userId)) ? "console" : "onboard");
        out = [{ text: WELCOME, quick: [say("/setup"), say("/help")] }];
        break;
      }
      case "join": out = [{ text: GROUP_HELLO }]; break;
      case "media": out = isGroup ? null : [{ text: nonTextReply(ctx.lang) }]; break;
      case "postback":
        if (ev.postback === "parley:fill" || ev.postback === "menu:a") return; // open-keyboard buttons; nothing to answer
        if (isGroup && ev.cannotPost) { out = [{ text: this.needInstall(ch, ctx.lang) }]; break; }
        out = await handlePostback(ev, api, ctx);
        break;
      case "text": {
        if (!isGroup && ev.userId) await ch.markRead?.(ev.userId);
        // v0.12.1: a Discord server that has the app only as a user install — the bot cannot post there later, so
        // wiring, /a and the rest would silently fail at the first push. Say what to do instead; /help still helps.
        if (isGroup && ev.cannotPost && isCommand(ev.text) && !/^\/(help|advance|can2cup|can2can|parley)\b/i.test(ev.text.trim())) { out = [{ text: this.needInstall(ch, ctx.lang) }]; break; }
        out = await handleText(ev, api, ctx);
        if (out === null && isGroup) { await this.logGroup(ev); if (ev.mentioned) out = [{ text: plainTextHint(ctx.lang) }]; }
        break;
      }
      default: return;
    }
    if (out === SILENT || !out?.length) return;
    if (!isGroup && ev.userId && ev.kind === "text") {
      await ch.setMenu?.(ev.userId, (await this.bindingByUser(ev.userId)) ? "console" : "onboard");
      const last = out[out.length - 1];
      if (!last.quick) { const chips = chipsFor(ev.text, out.map(outText).join("\n"), ctx.lang); if (chips) out[out.length - 1] = { ...last, quick: chips }; }
    }
    await this.replyOrPush(ev, out);
  }
  /** v0.17.0: a notification the client sent as a code (with its Chinese text, for relays older than this) — said in
   *  the language of the place it lands. Only known codes are rendered; the values are inserted as data. Unknown → the text. */
  private noteText(L: string, note: { code?: unknown; vars?: unknown }): string | undefined {
    const v: Record<string, string> = {};
    if (note.vars && typeof note.vars === "object") for (const [k, x] of Object.entries(note.vars as Record<string, unknown>)) if (typeof x === "string" || typeof x === "number") v[k] = String(x).slice(0, 300);
    switch (note.code) {
      case "blocked": return tr(L, "你的 agent 有一則 {type} 被擋下（{why}）。內容留在那台電腦的 audit log，沒有送出。", { type: v.type ?? "", why: v.rule === "never_disclose" ? tr(L, "never_disclose：內容含不可外流字串") : v.rule === "max_commit_amount" ? tr(L, "max_commit_amount：金額超過上限") : v.rule === "may_grant" ? tr(L, "may_grant：授權範圍不在允許清單") : v.rule === "max_grant_hours" ? tr(L, "max_grant_hours：授權期限太長") : v.rule === "paused" ? tr(L, "煞車中") : v.rule === "gate" ? tr(L, "承諾閘：要電腦上的簽章核准") : tr(L, "mandate") });
      case "dropped": return tr(L, "你剛才的 {n} 則指令沒有簽章，這台 agent 設了 require_signed_principal，所以沒有執行。要下指令請在電腦上用 can2cup say。", { n: v.n ?? "?" });
      case "room-failed": return tr(L, "開房失敗：{msg}", { msg: v.msg ?? "" });
      case "e2e-escalate": return tr(L, "（傳音入密的房 {room}：內容不經過 relay。到電腦上看：can2cup history {room}）", { room: v.room ?? "" });
      case "expired-group": return tr(L, "⌛ 這個群接上的房到期了（{at} UTC），我發不出話。在這個群打 /room 就會重新接上一間，之前的紀錄還在。", { at: v.at ?? "" });
      case "expired-room": return tr(L, "⌛ 房 {room}{name} 到期了，我發不出話。要繼續談就得開新的一間。", { room: v.room ?? "", name: v.name ? tr(L, "「{name}」", { name: v.name }) : "" });
      case "mech-deal": return tr(L, "密封競價成交:{price}{cur}(房 {room} #{seq},k={k})——這是一筆已定案的金額,到電腦上看:can2cup mechanism {room} status {seq}", { price: v.price ?? "", cur: v.cur ?? "", room: v.room ?? "", seq: v.seq ?? "", k: v.k ?? "" });
      case "mech-nodeal": return tr(L, "密封競價無成交:買方出價低於賣方,雙方都不成交(房 {room} #{seq})", { room: v.room ?? "", seq: v.seq ?? "" });
      default: return undefined;
    }
  }
  /** A place the bot can answer in but cannot post to later: the adapter that raised `cannotPost` says what to do. */
  private needInstall(ch: Channel, L: string): string {
    return ch.installHint?.(L) ?? tr(L, "我在這裡回得了你，但之後貼不了訊息，所以群組功能先不開。私訊我的話，所有 1 對 1 功能都能用。");
  }
  /** The reply token is free and lives 60 s; a button tapped an hour later, or a redelivered event, has none that
   *  works. Then the answer goes out as a push — quota-gated like every other push, so it can only cost what a
   *  human's reply is worth. */
  private async replyOrPush(ev: Incoming, out: Out[]): Promise<void> {
    const ch = this.chan(ev.channel);
    if (ev.replyToken && ch.enabled) {
      try { await ch.reply(ev.replyToken, out); return; }
      catch (e) { console.warn(`${ch.name} reply failed, pushing instead: ${e instanceof Error ? e.message : String(e)}`); }
    }
    for (const m of out) await this.push(ev.place.id, "reply", outText(m), m.quick, undefined, undefined, undefined, m.card);
  }

  /** review R1/R3: is this agent a current participant of the room, as far as the bridge knows? */
  /** v0.9.5 — everything this relay holds about one agent, and about the LINE account bound to it.
   *  `binding` unbinds the phone: the inbox, the groups it could address, the pause state, the
   *  presence bookkeeping. The agent keeps its keys and its rooms — a room belongs to the people in
   *  it, not to the bot. `all` additionally forgets the rooms and unwires every group it wired.
   *
   *  Deliberately NOT deleted: `ban:*`. Otherwise unbinding would launder a ban.
   *  Deliberately NOT claimed: the other participants' copies. A room transcript is a signed chain
   *  that the other side already holds; deleting our copy does not retract it, and saying otherwise
   *  would be a lie. The caller reports that in words. */
  /** opts.keepSigned (v0.9.12, idle expiry only): leave principal:<pub> and spause:<pub> — the signed layer outlives the LINE binding. */
  private async erase(pub: string, scope: "binding" | "all", opts: { keepSigned?: boolean } = {}): Promise<Record<string, number>> {
    const gone: Record<string, number> = {};
    const tally = (k: string) => { const g = k.split(":")[0]; gone[g] = (gone[g] ?? 0) + 1; };
    const drop = async (k: string) => {
      if ((await this.ctx.storage.get(k)) === undefined) return;
      await this.del(k);
      tally(k);
    };
    const dropPrefix = async (p: string) => { for (const k of (await this.ctx.storage.list({ prefix: p })).keys()) await drop(k); };

    const b = await this.bindingByPub(pub);
    const groups = (await this.get<KnownGroup[]>(`groups:${pub}`)) ?? [];
    const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};

    // Unwire the LINE groups this agent wired, so no group is left pointing at a room nobody reads.
    // Only the ones it is actually in — another agent may have wired the same group since.
    for (const g of groups) {
      const m = await this.get<Mirror>(`mirror:${g.id}`);
      if (m && (await this.inRoom(pub, m.room))) {
        await drop(`mirror:${g.id}`);
        const list = ((await this.get<string[]>(`mirrors:${m.room}`)) ?? []).filter((x) => x !== g.id);
        if (list.length) await this.put(`mirrors:${m.room}`, list);
        else { await drop(`mirrors:${m.room}`); await this.keepAlive(m.room, false); }
      }
      await drop(`quiet:${g.id}`);
      await drop(`ctx:${g.id}`);
      await drop(`glog:${g.id}`);
    }

    if (!opts.keepSigned) { // v0.15.2: the agent claim (proof + principal index) is part of the signed layer
      const P = await this.get<string>(`principal:${pub}`);
      if (P) await drop(`principalAgent:${P}:${pub}`);
      await drop(`principalProof:${pub}`);
    }
    for (const k of [`inbox:${pub}`, `inboxSeq:${pub}`, `read:${pub}`, `seen:${pub}`, `groups:${pub}`,
                     `galias:${pub}`, ...(opts.keepSigned ? [] : [`principal:${pub}`, `spause:${pub}`]), `paused:${pub}`,
                     `lastGroup:${pub}`, `offline:${pub}`, `offpend:${pub}`, `offtold:${pub}`,
                     `oldnag:${pub}`, `stale:${pub}`, `ver:${pub}`, `tier:${pub}`, `idle:${pub}`, `idlewarn:${pub}`]) await drop(k);
    await dropPrefix(`roomreq:${pub}:`);
    this.lastCall.delete(pub); this.metaWritten.delete(`ver:${pub}`); this.metaWritten.delete(`host:${pub}`); // presence forgotten means forgotten here too

    if (b) {
      await drop(`pub:${pub}`);
      await drop(`user:${b.userId}`);
      if (scope === "all") await drop(`ulang:${b.userId}`); // v0.17.0: /forgetme forgets the language too; /unbind keeps it
      // Anything still queued for that phone, and the delivery log naming it. A push that has already
      // left for LINE is on LINE's servers and out of our hands — the caller says so.
      for (const [k, q] of await this.ctx.storage.list<Queued>({ prefix: "pq:" })) if (q.to === b.userId) await drop(k);
      const log = (await this.get<Pushed[]>("pushes")) ?? [];
      const kept = log.filter((p) => p.to !== b.userId);
      if (kept.length !== log.length) { await this.put("pushes", kept); tally(`push-log:${log.length - kept.length}`); gone["push-log"] = log.length - kept.length; }
    }

    if (scope === "all") {
      for (const id of Object.keys(rooms)) {
        const known = await this.get<RoomKnown>(`room:${id}`);
        // The registry entry is shared by everyone in the room; drop it only when nobody else is left.
        if (known && Object.keys(known.participants).filter((p) => p !== pub).length === 0) {
          await drop(`room:${id}`);
          await drop(`recent:${id}`);
          await drop(`mirrors:${id}`);
        }
      }
      await drop(`rooms:${pub}`);
    }
    return gone;
  }

  private async inRoom(pub: string, room: string): Promise<boolean> {
    const known = await this.get<RoomKnown>(`room:${room}`);
    return !!known && known.state === "open" && !!known.participants[pub];
  }

  /** v0.9.9 (security G-2 §6.1, T4): a connected group may only be re-pointed by the person who connected it,
   *  while they are still bound and the room is still open. Before this, any bound member of the group could
   *  /room or /mirror it onto their own agent — and everything the group said from then on went to a different
   *  computer, with no one asked. 0.9.7 closed /context on the same way; this closes the wire itself.
   *  Returns the holder's name when somebody ELSE holds the wire; undefined when the caller may proceed.
   *  /unmirror stays open to everyone: the protective direction never needs permission. */
  private async wiredByOther(gid: string, userId: string | undefined): Promise<{ by: string | null } | undefined> {
    const cur = await this.get<Mirror>(`mirror:${gid}`);
    if (!cur || !cur.by || cur.by === userId) return undefined;
    const holder = await this.bindingByUser(cur.by);
    const room = await this.get<RoomKnown>(`room:${cur.room}`);
    if (!holder || !room || room.state !== "open") return undefined; // wirer gone or room dead: the wire is free
    return { by: holder.name || null };
  }

  /** v0.10.3 (review item left over from 0.9.4): a link / setup / invite code is 32 bits of hex or 40 bits of alphanumerics,
   *  alive for minutes to a day. Guessing one would take a very long time — unless nothing counts the misses. Now
   *  something does: CODE_MISS_PER_HOUR wrong codes per caller (LINE userId, or agent pub) per hour, then 429. Right
   *  codes are never counted, so a person who typos once is not punished; a script that hammers is. */
  private async codeBlocked(kind: string, who: string): Promise<boolean> {
    const n = (await this.get<number>(`q:code:${kind}:${who}:${new Date().toISOString().slice(0, 13)}`)) ?? 0;
    if (n >= CODE_MISS_PER_HOUR) { await this.flagAbuse("codes", who, `一小時內猜錯 ${n} 次 ${kind} 碼`); return true; } // i18n-ok: to the operator
    return false;
  }
  private async codeMiss(kind: string, who: string): Promise<void> {
    const k = `q:code:${kind}:${who}:${new Date().toISOString().slice(0, 13)}`;
    await this.put(k, ((await this.get<number>(k)) ?? 0) + 1);
  }
  /** codex 6.0: allocate an inv: code that is not already a LIVE record — a blind put could silently overwrite a
   *  valid invite (birthday collision in a 32-bit space). The BridgeDO serialises requests, so read-then-write here
   *  is effectively atomic within the instance. Returns undefined if it cannot find a free code in a few tries. */
  private async freshInvCode(): Promise<string | undefined> {
    for (let i = 0; i < 5; i++) {
      const cand = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
      const existing = await this.get<StoredInvite>(`inv:${cand}`);
      if (!existing || Date.now() - existing.at > INVITE_TTL_MS) return cand;
    }
    return undefined;
  }
  private static readonly TOO_MANY_CODES = "too many wrong codes this hour — wait, then ask for a fresh code";
  /** v0.10.6: a quota trip is a signal, not just a refusal. Record it under abuse:<kind>:<who> (last 30, for
   *  /admin/activity) and tell the operator once a month per (kind, who) so a pattern is seen while it is forming. */
  private async flagAbuse(kind: string, who: string, detail: string): Promise<void> {
    const k = `abuse:${kind}:${who}`;
    const list = (await this.get<Array<{ at: string; detail: string }>>(k)) ?? [];
    list.push({ at: new Date().toISOString(), detail });
    await this.put(k, list.slice(-30));
    const b = await this.bindingByPub(who) ?? await this.bindingByUser(who);
    await this.warnOperatorOnce(`abuse:${kind}:${who}`, `⚠️ 可能濫用（${kind}）：${b?.name ? `agent「${b.name}」` : short(who)}，${detail}。看 /admin/activity；要停權：can2cup admin ban ${who.length === 64 ? `--pub ${who}` : `--user ${who}`}`); // i18n-ok: to the operator
  }

  /** review R3: a LINE group mirrors exactly one room. Re-pointing it detaches it from the old room first. */
  private async setMirror(gid: string, m: Mirror): Promise<void> {
    const old = await this.get<Mirror>(`mirror:${gid}`);
    if (!isLang(m.lang)) m.lang = isLang(old?.lang) ? old!.lang : await this.userLang(m.by || undefined); // v0.17.0: a group starts in its wirer's language
    if (old && old.room !== m.room) {
      const prev = ((await this.get<string[]>(`mirrors:${old.room}`)) ?? []).filter((g) => g !== gid);
      if (prev.length) await this.put(`mirrors:${old.room}`, prev); else await this.del(`mirrors:${old.room}`);
    }
    await this.put(`mirror:${gid}`, m);
    const list = new Set((await this.get<string[]>(`mirrors:${m.room}`)) ?? []);
    list.add(gid);
    await this.put(`mirrors:${m.room}`, [...list]);
    // v0.9.2: a room that IS a LINE group must not die on the 6 h default TTL. Wiring turns on the
    // room's sliding keep-alive; the room then expires that long after its LAST message, not after
    // its creation. A room nothing points at any more goes back to the ordinary TTL.
    await this.keepAlive(m.room, true);
    if (old && old.room !== m.room && !((await this.get<string[]>(`mirrors:${old.room}`)) ?? []).length) await this.keepAlive(old.room, false);
  }

  /** Turn a room's sliding keep-alive on or off. Best-effort: a room that has moved away or was
   *  never created here must not break wiring, which is the caller's actual job. */
  private async keepAlive(room: string, on: boolean): Promise<void> {
    const days = Math.max(1, Number(this.env.GROUP_ROOM_TTL_DAYS ?? 30) || 30);
    try {
      const res = await this.env.ROOMS.get(this.env.ROOMS.idFromName(room)).fetch(new Request(`https://do/rooms/${room}/internal/keepalive`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ on, keepAliveSec: days * 24 * 3600 }),
      }));
      if (!res.ok) console.error(`keepalive ${on ? "on" : "off"} for room ${room}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) { console.error(`keepalive ${on ? "on" : "off"} for room ${room} threw: ${e instanceof Error ? e.message : String(e)}`); }
  }

  private leaseMs(): number { const s = Number(this.env.INBOX_LEASE_SEC); return s > 0 ? s * 1000 : INBOX_LEASE_MS_DEFAULT; }

  private async armAlarm(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > at) await this.setAlarmAt(at);
  }
  /** Remember that the principal has heard the agent is away — only then is a "back online" push worth sending. */
  private async markToldOffline(pub: string, p: { online: boolean }): Promise<void> {
    if (p.online) return;
    if (!(await this.get<string>(`offtold:${pub}`))) await this.put(`offtold:${pub}`, new Date().toISOString());
  }
  /** Every authenticated agent call lands here. Detects offline→online and tells the principal once. */
  // ---- v0.9.0 upgrade protocol -------------------------------------------------------------
  // Every /p/* call carries `x-can2cup-client`; every reply carries `x-can2cup-latest` (what /dl/VERSION serves)
  // and `x-can2cup-min` (below it, the A2A routes answer 426). The agent reads those and decides; a client
  // too old to send the header at all gets one LINE nudge a month to its principal (see /p/online).
  private latestCache: { v: string | null; at: number } = { v: null, at: 0 };
  private async latestVersion(): Promise<string | null> {
    if (Date.now() - this.latestCache.at < 5 * 60_000) return this.latestCache.v;
    let v: string | null = null;
    try {
      const r = await this.env.ASSETS?.fetch(new Request("https://assets.local/dl/VERSION"));
      if (r?.ok) v = (await r.text()).trim() || null;
    } catch { /* no assets binding (dev) */ }
    v = v ?? this.env.LATEST_CLIENT?.trim() ?? this.latestCache.v;
    this.latestCache = { v, at: Date.now() };
    return v;
  }
  private minClient(): string { return (this.env.MIN_CLIENT ?? "").trim() || NO_VERSION; }
  private async upgradeRequired(c: { req: { url: string }; json: (o: unknown, s: number) => Response }, ver: string): Promise<Response> {
    const origin = new URL(c.req.url).origin;
    const latest = await this.latestVersion();
    const min = this.minClient();
    const who = ver === NO_VERSION ? "(pre-0.9, version unknown)" : ver;
    return c.json({ error: `upgrade required: can2cup ${who} is below this relay's minimum ${min} — run \`can2cup upgrade\` on that computer (= ${installLine(origin, await hasMirror(this.env))}), then restart Claude Code once`, min, latest, cmd: "can2cup upgrade" }, 426);
  }

  private async touch(pub: string, path: string, host?: string): Promise<void> {
    const nowMs = Date.now();
    // /p/offline: remember the call in memory only (so offlineAt >= seenMs holds), persist nothing; the route does the rest.
    if (path === "/p/offline") { BridgeDO.remember(this.lastCall, pub, nowMs); return; }
    const before = await this.presence(pub);
    const offpend = await this.get<OffPend>(`offpend:${pub}`);
    // 2026-09-14 write budget: an agent that stays online writes seen: at most every SEEN_PERSIST_MS, and nothing else.
    const transition = !before.online || !!offpend;
    BridgeDO.remember(this.lastCall, pub, nowMs);
    const storedSeen = await this.get<string>(`seen:${pub}`);
    const age = nowMs - (storedSeen ? Date.parse(storedSeen) || 0 : 0);
    const beat = path === "/p/heartbeat" || path === "/p/online"; // see BEAT_PERSIST_MS: the stale clock after an eviction
    let persistSeen = transition || age >= this.seenPersistMs(pub) || (beat && age >= Math.min(BEAT_PERSIST_MS, this.seenPersistMs(pub)));
    if (persistSeen && !transition && age < Math.max(UNBOUND_SEEN_PERSIST_MS, this.seenPersistMs(pub))
        && !(await this.bindingByPub(pub)) && !(await this.get(`hosted:${pub}`))) persistSeen = false; // nobody is told about an unbound key's presence
    if (persistSeen) await this.bookkeep(() => this.put(`seen:${pub}`, new Date(nowMs).toISOString()));
    // v0.9.14 (G-4 R8): which of this relay's names the agent last used — so an old name is retired on numbers, not guesses.
    if (host && (await this.get<string>(`host:${pub}`)) !== host && nowMs - (this.metaWritten.get(`host:${pub}`) ?? 0) >= META_PERSIST_MS) {
      if (await this.bookkeep(() => this.put(`host:${pub}`, host))) BridgeDO.remember(this.metaWritten, `host:${pub}`, nowMs);
    }
    // review R20: a session that dies without a goodbye (power loss, kill -9) never posts /p/offline. Arm a check for
    // when it would count as stale; sweepStale() announces it if nothing touched us by then. 2026-09-14: armed once —
    // sweepStale() works out the real deadline from seen: and the last call, and keeps the key while the agent is here.
    if (!(await this.get<number>(`stale:${pub}`))) {
      await this.bookkeep(async () => {
        await this.put(`stale:${pub}`, nowMs + this.staleMs(pub) + 1000);
        await this.armAlarm(nowMs + this.staleMs(pub) + 2000);
      });
    }
    try {
      // Any call from the agent means it is here. A goodbye still inside its grace was never announced
      // (another session of the same agent is alive, or this one restarted at once) — drop it silently;
      // `before.online` is true while it is held, so the "back" push below is correctly skipped.
      if (offpend) {
        await this.del(`offpend:${pub}`);
        await this.del(`offline:${pub}`);
      }
      if (!before.online) {
        await this.del(`offline:${pub}`);
        const told = await this.get<string>(`offtold:${pub}`);
        if (told) await this.del(`offtold:${pub}`);
        const b = await this.bindingByPub(pub);
        if (b && before.lastSeen && told) { // never-seen agents, and absences nobody was told about, get no "back" push
          const queued = ((await this.get<InboxItem[]>(`inbox:${pub}`)) ?? []).filter((i) => !before.lastRead || i.at > before.lastRead).length;
          const L = await this.placeLang(b.userId);
          const gone = before.sinceMin != null ? tr(L, "（離線 {min} 分鐘後）", { min: before.sinceMin }) : "";
          await this.push(b.userId, "presence:online", tr(L, "🟢 你的 agent（{name}）回來了{gone}。{queued}", { name: b.name || short(pub), gone, queued: queued ? tr(L, "排隊中的 {n} 則指令會在它下次讀取時送達。", { n: queued }) : "" }).trim());
        }
      }
    } catch (e) {
      // Presence is bookkeeping too: a request (an inbox read above all) must not fail because it could not be saved.
      console.error(`bridge: presence transition for ${short(pub)} not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  private offlineNote(p: { online: boolean; sinceMin: number | null; lastSeen: string | null }, L: string): string {
    if (p.online) return "";
    if (!p.lastSeen) return tr(L, "（你的 agent 還沒上線過）");
    return tr(L, "（你的 agent 目前離線{tail}）", { tail: p.sinceMin != null ? tr(L, "，最後在線 {min} 分鐘前", { min: p.sinceMin }) : "" });
  }

  private async appendInbox(pub: string, item: Omit<InboxItem, "seq">): Promise<number> {
    const seq = ((await this.get<number>(`inboxSeq:${pub}`)) ?? 0) + 1;
    const items = (await this.get<InboxItem[]>(`inbox:${pub}`)) ?? [];
    items.push({ seq, ...item });
    // review R19: never silently drop an unanswered instruction — shed acked ones first.
    let kept = items;
    if (kept.length > 100) {
      const unacked = kept.filter((i) => !i.ackedAt);
      const acked = kept.filter((i) => !!i.ackedAt);
      kept = [...acked.slice(-Math.max(0, 100 - unacked.length)), ...unacked].sort((x, y) => x.seq - y.seq).slice(-200);
    }
    await this.put(`inbox:${pub}`, kept);
    await this.put(`inboxSeq:${pub}`, seq);
    return seq;
  }

  /** v0.4.5: remember every group the principal speaks from, with a stable short alias (g1, g2, …). */
  private async noteGroup(pub: string, groupId: string, groupName?: string): Promise<KnownGroup> {
    const list = (await this.get<KnownGroup[]>(`groups:${pub}`)) ?? [];
    let g = list.find((x) => x.id === groupId);
    if (!g) { const n = ((await this.get<number>(`galias:${pub}`)) ?? list.length) + 1; await this.put(`galias:${pub}`, n); g = { id: groupId, alias: `g${n}`, ...(groupName ? { name: groupName } : {}), lastAt: new Date().toISOString() }; list.push(g); }
    else { g.lastAt = new Date().toISOString(); if (groupName) g.name = groupName; }
    await this.put(`groups:${pub}`, list.slice(-30));
    return g;
  }

  /** v0.15.1: the month's pushes PER CHANNEL. A channel with a `monthlyBudget` (LINE) is gated on its own count; the
   *  others are counted for /quota only — they have no platform allowance, so the per-target and per-room gates are
   *  their whole protection. The bare-id channel's counter is seeded from the pre-0.15.1 global counter, so a month in
   *  progress keeps its LINE count instead of starting over at zero against LINE's real cap. */
  private async channelCount(ch: Channel): Promise<{ key: string; n: number }> {
    const month = new Date().toISOString().slice(0, 7);
    const key = `quota:ch:${ch.name}:${month}`;
    let n = await this.get<number>(key);
    if (n == null && ch.idPrefix === "") { n = (await this.get<number>(`quota:${month}`)) ?? 0; await this.put(key, n); }
    return { key, n: n ?? 0 };
  }
  private async pushCount(): Promise<{ key: string; n: number; budget: number }> {
    const key = `quota:${new Date().toISOString().slice(0, 7)}`;
    const n = (await this.get<number>(key)) ?? 0;
    const budget = Number(this.env.PUSH_BUDGET ?? 180) || 180;
    return { key, n, budget };
  }

  /** Queue a push (with optional quick-reply buttons); alarm() delivers. Storage-only, so callers stay atomic. */
  /** `sender` (v0.7.4) is the LINE bubble's author name — an agent speaking in a mirrored group reads as that
   *  agent, not as the bot. Name only (LINE caps it at 20 chars); the icon stays the OA's. */
  /** v0.15.0: a push text that names the chat app reads the word off `this.chanFor(to).vocab` where it is built (see
   *  link:claimed, erase, the budget warning). Nothing is rewritten here: the queue carries exactly what was said. */
  private async push(to: string, kind: string, text: string, quick?: Quick[], room?: string, image?: string, sender?: string, card?: Card): Promise<void> {
    const n = ((await this.get<number>("pqSeq")) ?? 0) + 1;
    await this.put("pqSeq", n);
    await this.put(`pq:${String(n).padStart(10, "0")}`, { at: new Date().toISOString(), to, kind, text, quick, room, image, ...(sender ? { sender: sender.slice(0, 20) } : {}), ...(card ? { card } : {}) } as Queued);
    await this.armAlarm(Date.now() + 10);
  }

  /** A goodbye whose grace has expired: announce it only if the agent really is still gone. */
  /** review R20: agents that stopped heartbeating without a goodbye. */
  private async sweepStale(): Promise<number | null> {
    let next: number | null = null;
    for (const [key, storedDue] of await this.ctx.storage.list<number>({ prefix: "stale:" })) {
      const pub = key.slice("stale:".length);
      // 2026-09-14: touch() no longer rewrites stale: on every call, so the deadline is worked out here: the stored one,
      // or later if the agent was seen (stored seen:, or this instance's last call) after it was armed. Not due yet →
      // keep the key and look again then, rounded up to a grid so many agents share one alarm instead of one each.
      const st = this.staleMs(pub);
      const seen = await this.get<string>(`seen:${pub}`);
      const due = Math.max(storedDue, (seen ? Date.parse(seen) || 0 : 0) + st + 1000, (this.lastCall.get(pub) ?? 0) + st + 1000);
      if (Date.now() < due) {
        const grid = Math.min(60_000, Math.max(1000, Math.round(st / 4)));
        const at = Math.ceil(due / grid) * grid;
        next = next == null ? at : Math.min(next, at);
        continue;
      }
      await this.del(key);
      const p = await this.presence(pub);
      if (p.online) continue; // touched again meanwhile (the key was re-armed and we will see the new one)
      if (await this.get<string>(`offtold:${pub}`)) continue; // already announced by the goodbye path
      const b = await this.bindingByPub(pub);
      if (!b) continue;
      await this.put(`offtold:${pub}`, new Date().toISOString());
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};
      const open = Object.values(rooms).filter((r) => r.state === "open").length;
      const L = await this.placeLang(b.userId);
      await this.push(b.userId, "presence:offline", tr(L, "🔴 你的 agent（{name}）沒有回應了（可能電腦睡眠或 Claude Code 被關掉）。{open}你在這裡打的 /a 會排隊，等它回來再送達。", { name: b.name || short(pub), open: open ? tr(L, "還有 {n} 個對話開著；", { n: open }) : "" }));
    }
    return next;
  }

  private async sweepOffline(): Promise<number | null> {
    let next: number | null = null;
    for (const [key, p] of await this.ctx.storage.list<OffPend>({ prefix: "offpend:" })) {
      if (Date.now() < p.due) { next = next == null ? p.due : Math.min(next, p.due); continue; }
      const pub = key.slice("offpend:".length);
      await this.del(key);
      if (!(await this.get<string>(`offline:${pub}`))) continue; // a /p/* call cleared it: the agent is still around
      const seen = await this.get<string>(`seen:${pub}`);
      const seenMs = Math.max(seen ? Date.parse(seen) || 0 : 0, this.lastCall.get(pub) ?? 0);
      if (seenMs > Date.parse(p.at)) continue; // heartbeat after the goodbye: a sibling session is holding the fort
      const b = await this.bindingByPub(pub);
      if (!b) continue;
      await this.put(`offtold:${pub}`, p.at);
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};
      const open = Object.values(rooms).filter((r) => r.state === "open").length;
      const L = await this.placeLang(b.userId);
      await this.push(b.userId, "presence:offline", tr(L, "🔴 你的 agent（{name}）已離線（Claude Code 關閉）。{open}你在這裡打的 /a 會排隊，等它回來再送達。", { name: b.name || short(pub), open: open ? tr(L, "還有 {n} 個對話開著；", { n: open }) : "" }));
    }
    return next;
  }

  override async alarm(): Promise<void> {
    this.inAlarm++;
    try { await this.alarmBody(); } finally { this.inAlarm--; }
  }
  private async alarmBody(): Promise<void> {
    const nextOffline = await this.sweepOffline(); // may queue a push, so run it before the queue drains
    const nextStale = await this.sweepStale();     // review R20
    const nextUnacked = await this.sweepUnacked(); // v0.8.0: may queue a reminder push, same reason
    await this.purgeExpired();                     // review R4/R10: reports (30 d), invites (24 h), webhook dedup (1 d)
    const nextIdle = await this.maybeSweepIdle();  // v0.9.12: bindings whose agent is gone, wires whose room is dead
    let nextRetry: number | null = null;
    const items = await this.ctx.storage.list<Queued>({ prefix: "pq:" });
    for (const [key, item] of items) {
      if (item.nextAt && Date.now() < item.nextAt) { nextRetry = nextRetry == null ? item.nextAt : Math.min(nextRetry, item.nextAt); continue; }
      const v = await this.deliver(item);
      const delivered = v.text;
      const attempts = (item.attempts ?? 0) + 1;
      // review R2: transient failures are retried with backoff; only a final verdict removes the push. v0.15.0: decided
      // on the structured verdict — a channel call that came back 5xx / 429 / threw, or our own room rate gate — so
      // a new channel is retried like the others instead of falling out of a name list.
      const transient = (v.channel && !v.ok && (v.status === undefined || v.status >= 500 || (v.status === 429 && v.channel !== "forward"))) || v.gate === "room-rate-limited"; // the legacy forwarder was never retried on 429; adapters are
      if (transient && attempts < PUSH_MAX_ATTEMPTS) {
        const nextAt = Date.now() + 30_000 * 2 ** (attempts - 1);
        await this.put(key, { ...item, attempts, nextAt } as Queued);
        nextRetry = nextRetry == null ? nextAt : Math.min(nextRetry, nextAt);
        continue;
      }
      const log = (await this.get<Pushed[]>("pushes")) ?? [];
      log.push({ at: item.at, to: item.to, kind: item.kind, text: item.text, delivered, ...(item.image ? { image: item.image } : {}), ...(item.sender ? { sender: item.sender } : {}), ...(attempts > 1 ? { attempts } : {}) });
      await this.put("pushes", log.slice(-50));
      await this.del(key);
      if (v.gate === "over-budget") await this.warnOperatorOnce("budget", `⚠️ relay 這個月的 ${this.chanFor(this.env.OPERATOR_LINE_USER_ID).vocab.chat} 推播額度用完了（${item.kind} 給 ${short(item.to)} 沒送出）。之後到月底的推播都會消失。`); // i18n-ok: to the operator
    }
    if (nextRetry != null) await this.armAlarm(nextRetry);
    // v0.4.5: purge expired ephemeral images; re-arm the alarm for the next expiry.
    const metas = await this.ctx.storage.list<ImgMeta>({ prefix: "img:" });
    let next: number | null = null;
    for (const t of [nextOffline, nextStale, nextUnacked, nextIdle]) if (t != null) next = next == null ? t : Math.min(next, t);
    for (const [k, m] of metas) {
      if (Date.now() >= m.expires) await this.purgeImage(k.slice(4), m.chunks);
      else next = next == null ? m.expires : Math.min(next, m.expires);
    }
    if (next != null) await this.armAlarm(next + 1000);
  }

  private async purgeImage(id: string, chunks: number): Promise<void> {
    await this.del(`img:${id}`);
    for (let i = 0; i < chunks; i++) await this.del(`imgc:${id}:${i}`);
  }

  /** v0.15.0: what happened to one push, as a structure. `text` is the legacy one-line verdict for the push log and
   *  the debug view ("line", "discord 429: …", "forwarded", "over-budget"…); everything that DECIDES — retry, quota,
   *  health — reads the fields, so a channel's name never has to appear in a regex. `channel` is set only when an
   *  adapter (or the legacy forwarder) was actually called; `gate` names our own refusal instead. */
  private async deliver({ to, text, quick, room, image, sender, card }: Queued): Promise<Verdict> {
    const q = await this.pushCount();
    const tKey = `quota:u:${to}:${new Date().toISOString().slice(0, 7)}`;
    const tN = (await this.get<number>(tKey)) ?? 0;
    const tBudget = Math.max(1, Number(this.env.PUSH_USER_BUDGET ?? 60) || 60);
    const rlKey = room ? `rl:${room}:${Math.floor(Date.now() / 3600000)}` : "";
    const rlN = rlKey ? ((await this.get<number>(rlKey)) ?? 0) : 0;
    let v: Verdict = { ok: false, text: "recorded" };
    const ch = this.chanFor(to);
    const cn = await this.channelCount(ch);
    if (ch.monthlyBudget != null && cn.n >= ch.monthlyBudget) v = { ok: false, gate: "over-budget", text: "over-budget" };
    else if (tN >= tBudget) v = { ok: false, gate: "target-over-budget", text: "target-over-budget" };
    else if (await this.get(`ban:user:${to}`)) v = { ok: false, gate: "target-banned", text: "target-banned" };
    else if (rlKey && rlN >= ROOM_HOURLY_PUSHES) v = { ok: false, gate: "room-rate-limited", text: "room-rate-limited" };
    else if (ch.enabled) { // v0.12.0: the Worker is the bot — push straight to the channel
      const r = await ch.push(to, { text, quick, image, sender, card });
      v = r.ok ? { ok: true, channel: ch.name, text: ch.name }
        : { ok: false, channel: ch.name, ...(r.status ? { status: r.status } : {}), ...(r.detail ? { detail: r.detail } : {}),
            text: r.status ? `${ch.name} ${r.status}${r.detail ? `: ${r.detail}` : ""}` : `${ch.name} error: ${r.detail ?? "?"}` };
      // v0.12.2: a push that the channel refused used to be recorded in the push log and nowhere else, so an
      // outage looked exactly like a delivered message from every side. Target is shortened, body never logged.
      if (!r.ok) console.error(`push refused: channel=${ch.name} status=${r.status} to=${short(to)} detail=${(r.detail ?? "").slice(0, 200)}`);
    } else if (this.env.LINE_FORWARD_URL && ch.idPrefix === "") { // the legacy external bot speaks bare (LINE) ids only
      try {
        const r = await fetch(this.env.LINE_FORWARD_URL, { method: "POST", headers: { "content-type": "application/json", "x-parley-bridge-key": this.env.BRIDGE_KEY ?? "" }, body: JSON.stringify({ to, text, quick: quick ?? [], ...(image ? { image } : {}), ...(sender ? { sender } : {}) }), signal: AbortSignal.timeout(20000) });
        v = r.ok ? { ok: true, channel: "forward", text: "forwarded" } : { ok: false, channel: "forward", status: r.status, text: `forward ${r.status}` };
      } catch (e) { const d = e instanceof Error ? e.message : String(e); v = { ok: false, channel: "forward", detail: d, text: `forward error: ${d}` }; }
    }
    if (v.ok) {
      await this.put(q.key, q.n + 1);
      await this.put(cn.key, cn.n + 1);
      await this.put(tKey, tN + 1);
      if (rlKey) await this.put(rlKey, rlN + 1);
    }
    // Only verdicts from an actual channel call: our own gates (over-budget, banned, rate-limited) say
    // nothing about whether the channel works, and recording them as failures would hide a real outage.
    if (v.channel) await this.noteHealth(to, v);
    return v;
  }

  /** Record a delivery verdict per target and per channel. Quota exhaustion refuses every target on the
   *  channel at once, so the channel-wide record catches it on the first refusal — before the target the
   *  principal actually reads has been tried. The per-target record is what separates "this group is gone"
   *  from "LINE is down". A success clears the failure: health is about now, not about history. */
  private async noteHealth(to: string, v: Verdict): Promise<void> {
    const channel = this.chanFor(to).name;
    const ok = v.ok;
    const rec: Health = ok
      ? { channel, okAt: new Date().toISOString() }
      : { channel, failAt: new Date().toISOString(), ...(v.status ? { status: v.status } : {}), detail: (v.detail ?? v.text).slice(0, 200) };
    // v0.15.2: a refusal that is about THIS target — 400 "chat not found", 403 "bot was blocked", a 404 — says nothing
    // about the channel, and used to mark the whole channel failing (one forged test id turned every Telegram
    // health line red). Only outage-shaped failures reach the channel-wide record: a throw / network error, 429, 5xx.
    const channelWide = ok || v.status === undefined || v.status === 401 || v.status === 429 || v.status >= 500; // 401 = the bot token itself is dead (pre-release review)
    for (const key of channelWide ? [`dh:${to}`, `dh:ch:${channel}`] : [`dh:${to}`]) {
      const prev = (await this.get<Health>(key)) ?? { channel };
      await this.put(key, ok ? rec : { ...prev, ...rec });
    }
  }

  private relayPub(): string { return this.env.RELAY_SIGNING_KEY ? pubFromPriv(this.env.RELAY_SIGNING_KEY) : ""; }
  /** v0.15.2: the principal this agent is PROVEN to belong to — registered, and the stored proof still names that
   *  same key on this relay. Null for an unproven registration, a hosted agent, or none at all. */
  private async provenPrincipal(pub: string): Promise<string | null> {
    const P = await this.get<string>(`principal:${pub}`);
    if (!P) return null;
    const proof = await this.get<AgentProof>(`principalProof:${pub}`);
    return proof && proof.principalPub === P && proof.relayPub === this.relayPub() ? P : null;
  }
  private async dashboardRateLimited(pub: string): Promise<string | null> {
    const k = `q:dash:${pub}:${Math.floor(Date.now() / 3600000)}`;
    const n = (await this.get<number>(k)) ?? 0;
    if (n >= DASHBOARD_PER_HOUR) return `dashboard rate limit: ${DASHBOARD_PER_HOUR} reads per hour per agent`;
    await this.put(k, n + 1);
    return null;
  }
  /** v0.15.2 (docs/dashboard-tool.md): every agent under the caller's principal, as metadata — no transcripts, no
   *  keys, no other participants' identities. Authorisation is decided HERE, once, for every surface:
   *    scope "principal"  the caller is PROVEN to belong to P (and, for a connector token, that token was issued
   *                       while the agent belonged to the same P) → the agents indexed under P that still verify
   *    scope "self"       anything else — an unproven caller learns nothing about P, not even whether it exists
   *  `opts.principal`: undefined = decide from the caller alone (the CLI's signed request); a string/null = what
   *  the caller's OAuth token was scoped to at issuance (null = a pre-0.15.2 token → self). */
  private async dashboardFor(callerPub: string, opts: { principal?: string | null }): Promise<Dashboard> {
    const registered = (await this.get<string>(`principal:${callerPub}`)) ?? null;
    const proven = await this.provenPrincipal(callerPub);
    const hosted = !!(await this.get(`hosted:${callerPub}`));
    const principalStatus: Dashboard["principalStatus"] = proven ? "proven" : registered ? "registered-unproven" : hosted ? "hosted" : "none";
    const scope: Dashboard["scope"] = proven && (opts.principal === undefined || opts.principal === proven) ? "principal" : "self";
    const pubs = new Set<string>([callerPub]);
    let truncated = false;
    if (scope === "principal") {
      const idx = await this.ctx.storage.list<string>({ prefix: `principalAgent:${proven}:`, limit: DASHBOARD_MAX_AGENTS + 1 });
      let n = 0;
      for (const k of idx.keys()) { if (++n > DASHBOARD_MAX_AGENTS) { truncated = true; break; } pubs.add(k.slice(`principalAgent:${proven}:`.length)); }
    }
    const hint =
      principalStatus === "proven" ? undefined
      : principalStatus === "registered-unproven" ? "this agent's principal is registered but not proven: after upgrading to 0.15.2+, run `can2cup principal init` on that machine (with its existing principal.json) or restart its MCP — the client then registers a principal-signed proof"
      : principalStatus === "hosted" ? "a hosted agent has no principal key, so this view is itself only; to see your locally-run agents here, bind this chat account to one of them (/link) and sign in again"
      : "no principal key registered for this agent: copy the same principal.json to that machine (a fresh `can2cup principal init` there would create a DIFFERENT principal) and restart its MCP";
    const agents: DashboardAgent[] = [];
    for (const pub of pubs) {
      const self = pub === callerPub;
      if (!self && (await this.provenPrincipal(pub)) !== proven) continue; // the index is a hint; the main record decides
      const b = await this.bindingByPub(pub);
      const pres = await this.presence(pub);
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};
      const items = Object.entries(rooms).map(([id, r]) => ({ id, name: safeLabel(r.name ?? "", 80), state: r.state, lastSeq: r.lastSeq }));
      const groups: DashboardAgent["groups"] = [];
      for (const g of ((await this.get<KnownGroup[]>(`groups:${pub}`)) ?? []).slice(0, 30)) {
        const m = await this.get<Mirror>(`mirror:${g.id}`);
        groups.push({ alias: g.alias, name: g.name ? safeLabel(g.name, 60) : undefined, channel: this.chanFor(g.id).name, wiredRoom: m && (await this.inRoom(pub, m.room)) ? m.room : null });
      }
      const h = await this.channelHealth(b);
      const lastRead = await this.get<string>(`read:${pub}`);
      const unread = ((await this.get<InboxItem[]>(`inbox:${pub}`)) ?? []).filter((i) => !lastRead || i.at > lastRead).length;
      agents.push({
        pub, short: short(pub), self, name: safeLabel(b?.name ?? "", 60), custody: (await this.get(`hosted:${pub}`)) ? "hosted" : "local",
        relayHost: (await this.get<string>(`host:${pub}`)) ?? null, version: (await this.get<string>(`ver:${pub}`)) ?? null,
        presence: { online: pres.online, lastSeen: pres.lastSeen, sinceMin: pres.sinceMin },
        paused: (await this.get<boolean>(`paused:${pub}`)) ?? false,
        unreadInstructions: unread,
        binding: b ? { channel: this.chanFor(b.userId).name, userIdHint: idHint(b.userId), boundAt: b.boundAt ?? null, idle: await this.idleOf(pub, b).then((i) => ({ days: i.days, forever: i.forever, expiresAt: i.expiresAt })), agentMode: b.agentMode } : null,
        channelHealth: h ? { state: h.state, channel: h.channel, okAt: h.okAt ?? null, failAt: h.failAt ?? null, status: h.status ?? null } : null,
        groups, rooms: { open: items.filter((r) => r.state === "open").length, total: items.length, items: items.slice(0, 20) },
      });
    }
    agents.sort((a, b) => (a.self ? -1 : b.self ? 1 : (b.presence.lastSeen ?? "").localeCompare(a.presence.lastSeen ?? "")));
    return { generatedAt: new Date().toISOString(), callerPub, scope, principalStatus, principal: scope === "principal" ? proven : null, truncated, ...(hint ? { hint } : {}), agents };
  }

  /** The principal channel's health as the agent should hear it. `unknown` until something has been
   *  delivered — an unproven channel is not a working one, and saying so is the whole point. */
  private async channelHealth(b: Binding | undefined): Promise<ChannelHealth | null> {
    if (!b) return null;
    const channel = this.chanFor(b.userId).name;
    const seen = [await this.get<Health>(`dh:${b.userId}`), await this.get<Health>(`dh:ch:${channel}`)].filter(Boolean) as Health[];
    if (!seen.length) return { state: "unknown", channel };
    const okAt = seen.map((x) => x.okAt).filter(Boolean).sort().pop();
    const bad = seen.find((x) => x.failAt && (!x.okAt || x.failAt > x.okAt));
    return bad
      ? { state: "failing", channel, failAt: bad.failAt, ...(bad.status ? { status: bad.status } : {}), ...(bad.detail ? { detail: bad.detail } : {}), ...(okAt ? { okAt } : {}) }
      : { state: "ok", channel, ...(okAt ? { okAt } : {}) };
  }

  /** One envelope as a LINE bubble. Phone width is ~16 CJK chars, so: a short header line
   *  (who + what kind + #seq — the seq is what APPROVE/REJECT buttons refer to), then the body.
   *  Plain text drops the type tag entirely: in a mirrored group it should read like chat. */
  private fmtEnvelope(e: Envelope, names: Record<string, string>, L: string): string {
    const { sender, text } = this.fmtBubble(e, names, L);
    if (!sender) return text;
    return e.type === "text" ? `${sender}：\n${text}` : `${sender} ${text}`;
  }

  /** (author, body) for one envelope. On LINE the author goes into the bubble's `sender` name, so a
   *  mirrored room reads like a chat between the agents; text form (/show, history) re-joins the two. */
  private fmtBubble(e: Envelope, names: Record<string, string>, L: string): { sender?: string; text: string } {
    const b = (e.body ?? {}) as Record<string, unknown>;
    const who = e.from === "relay" ? "relay" : (names[e.from] ?? short(e.from));
    const bits: string[] = [];
    if (e.type === "system") { const s = b as { event?: string; name?: string }; return { text: `· ${systemLabel(L)[s.event ?? ""] ?? s.event ?? "system"} ${s.name ?? ""}`.trim() }; }
    const label = e.type === "text" ? "" : `${typeLabel(L)[e.type] ?? e.type} #${e.seq}\n`;
    if (b.e2e === 1) return { sender: who, text: label + tr(L, "🔒 端對端加密,relay 讀不到\n請在電腦上看") };
    if (typeof b.text === "string") bits.push(b.text);
    if (b.amount != null) bits.push(tr(L, "金額 {amount}", { amount: String(b.amount) }));
    if (e.type === "grant") bits.push(tr(L, "範圍 {scope}\n到期 {expires}", { scope: String(b.scope), expires: String(b.expires) }));
    if (e.type === "revoke") bits.push(tr(L, "撤銷 #{ref}", { ref: String(b.ref) }));
    if (e.type === "attachment") bits.push(`📎 ${b.name ?? ""}\n${b.url ?? ""}`.trim());
    return { sender: who, text: `${label}${bits.join("\n")}`.trim() || tr(L, "（無內容）") };
  }

  // -------------------------------------------------------------- routes ---

  private routes() {
    const app = this.app;

    // ---- remote MCP connector (zero-install surface) -----------------------
    // Lives here because this DO already holds the LINE binding the OAuth step
    // authenticates against, and the room knowledge the tools read.
    app.post("/mcp", async (c) => handleMcp(this.mcpDeps(), c.req.raw, new URL(c.req.url).origin));
    app.get("/mcp", async (c) => handleMcp(this.mcpDeps(), c.req.raw, new URL(c.req.url).origin));
    app.post("/oauth/register", async (c) => mcpRegister(this.mcpDeps(), await c.req.json().catch(() => ({}))));
    app.get("/oauth/authorize", async (c) => authorizeGet(this.mcpDeps(), new URL(c.req.url), new URL(c.req.url).origin));
    app.post("/oauth/authorize", async (c) => authorizePost(this.mcpDeps(), new URL(c.req.url), await c.req.formData(), new URL(c.req.url).origin, c.req.header("cf-connecting-ip")));
    app.post("/oauth/token", async (c) => mcpToken(this.mcpDeps(), new URLSearchParams(await c.req.text())));

    // Public custody disclosure. Anyone reading a transcript can ask whether a
    // participant's key is held by this relay or by its owner — otherwise the two
    // tiers are indistinguishable from the signature alone and the strong one is
    // silently devalued. No auth: the whole point is that a third party can check.
    app.get("/hosted/:pub", async (c) => {
      const pub = c.req.param("pub");
      if (!/^[0-9a-f]{64}$/.test(pub)) return c.json({ error: "pub must be a 64-hex ed25519 key" }, 400);
      const h = await hostedKeyOf(this.mcpDeps(), pub);
      // Custody only. What a hosted agent may say is its owner's mandate, not ours to publish.
      return c.json({ pub, hosted: !!h, ...(h ? { since: h.createdAt } : {}) });
    });

    // ---- operator administration (the worker checks RELAY_KEY before routing /admin/* here) ----
    // A ban means "this person", not "this key": banning either side of a LINE binding bans both.
    const banTargets = async (b: { pub?: string; userId?: string }) => {
      const pubs = new Set<string>(); const users = new Set<string>();
      if (b.pub) { pubs.add(b.pub); const bd = await this.bindingByPub(b.pub); if (bd) users.add(bd.userId); }
      if (b.userId) { users.add(b.userId); const bd = await this.bindingByUser(b.userId); if (bd) pubs.add(bd.pub); }
      return { pubs, users };
    };
    app.post("/admin/ban", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { pub?: string; userId?: string; reason?: string };
      if (!b.pub && !b.userId) return c.json({ error: "pub or userId required" }, 400);
      if (b.pub && !/^[0-9a-f]{64}$/.test(b.pub)) return c.json({ error: "pub must be 64-hex" }, 400);
      const rec = { at: new Date().toISOString(), reason: b.reason ?? "" };
      const { pubs, users } = await banTargets(b);
      for (const p of pubs) await this.put(`ban:pub:${p}`, rec);
      for (const u of users) await this.put(`ban:user:${u}`, rec);
      return c.json({ ok: true, banned: { pubs: [...pubs], users: [...users].map(short) } });
    });
    app.post("/admin/unban", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { pub?: string; userId?: string };
      if (!b.pub && !b.userId) return c.json({ error: "pub or userId required" }, 400);
      const { pubs, users } = await banTargets(b);
      for (const p of pubs) await this.del(`ban:pub:${p}`);
      for (const u of users) await this.del(`ban:user:${u}`);
      return c.json({ ok: true });
    });
    // v0.9.14 (G-4 R8): how many agents still use each of this relay's names, and when they were last seen.
    // Retire an old name only when it reads zero for 30 days — pulling a name kills its invite links and configs.
    app.get("/admin/hosts", async (c) => {
      const hosts: Record<string, { agents: number; bound: number; lastSeen: string | null }> = {};
      for (const [k, host] of await this.ctx.storage.list<string>({ prefix: "host:" })) {
        const pub = k.slice(5);
        const h = (hosts[host] ??= { agents: 0, bound: 0, lastSeen: null });
        h.agents++;
        if (await this.get<Binding>(`pub:${pub}`)) h.bound++;
        const seen = (await this.get<string>(`seen:${pub}`)) ?? null;
        if (seen && (!h.lastSeen || seen > h.lastSeen)) h.lastSeen = seen;
      }
      return c.json({ hosts, note: "agents = distinct keys whose last call used that name; bound = of those, still LINE-bound. Retire a name at zero for 30 days, never sooner." });
    });
    // v0.10.6: the operator's audit view. The relay is open to anyone who adds the bot, so abuse is handled after
    // the fact, on evidence: who is here, how much they do, what tripped. Every number here is what the relay
    // already had to keep to enforce quotas; nothing new is recorded about people.
    app.get("/admin/activity", async (c) => {
      const day = new Date().toISOString().slice(0, 10);
      const roomsLim = Math.max(1, Number(this.env.ROOMS_PER_DAY ?? 10) || 10);
      const rows: Array<Record<string, unknown>> = [];
      for (const [k, b] of await this.ctx.storage.list<Binding>({ prefix: "pub:" })) {
        const pub = k.slice(4);
        const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};
        const open = Object.values(rooms).filter((r) => r.state === "open").length;
        const roomsToday = (await this.get<number>(`q:rooms:${pub}:${day}`)) ?? 0;
        const flags: string[] = [];
        for (const [ak, list] of await this.ctx.storage.list<Array<{ at: string; detail: string }>>({ prefix: "abuse:" })) {
          if (ak.endsWith(`:${pub}`) || ak.endsWith(`:${b.userId}`)) flags.push(`${ak.split(":")[1]}×${list.length} (last ${list[list.length - 1]?.at ?? "?"})`);
        }
        if (roomsToday >= roomsLim) flags.push("rooms-quota-hit-today");
        rows.push({
          pub, name: b.name, userId: short(b.userId), channel: this.chanFor(b.userId).name, boundAt: b.boundAt ?? null, lastSeen: (await this.get<string>(`seen:${pub}`)) ?? null,
          host: (await this.get<string>(`host:${pub}`)) ?? null, ver: (await this.get<string>(`ver:${pub}`)) ?? null,
          hosted: !!(await this.get(`hosted:${pub}`)), rooms: Object.keys(rooms).length, openRooms: open, roomsToday,
          instructions: (await this.get<number>(`inboxSeq:${pub}`)) ?? 0,
          banned: !!(await this.get(`ban:pub:${pub}`)) || !!(await this.get(`ban:user:${b.userId}`)), flags,
        });
      }
      rows.sort((x, y) => String(y.lastSeen ?? "").localeCompare(String(x.lastSeen ?? "")));
      const abuse: Record<string, unknown> = {};
      for (const [ak, v] of await this.ctx.storage.list({ prefix: "abuse:" })) abuse[ak] = v;
      const pushesByChannel: Record<string, { n: number; budget: number | null }> = {};
      for (const ch of this.channels) pushesByChannel[ch.name] = { n: (await this.channelCount(ch)).n, budget: ch.monthlyBudget ?? null };
      return c.json({ day, roomsPerDay: roomsLim, agents: rows, abuse, pushes: await this.pushCount(), pushesByChannel });
    });
    app.get("/admin/bans", async (c) => {
      const bans: Record<string, unknown> = {};
      for (const [k, v] of await this.ctx.storage.list({ prefix: "ban:" })) bans[k] = v;
      return c.json({ bans });
    });

    // ---- agent-signed -----------------------------------------------------
    app.use("/p/*", async (c, next) => {
      const v = await this.verifyAgent(c);
      if (v instanceof Response) return v;
      // 2026-09-14 write budget: inbox reads are paced per key, in memory, before any storage access — a client stuck
      // in a tight loop costs the relay a signature check and nothing else. Presence routes (online / offline /
      // heartbeat) and everything else are exempt: they are infrequent by construction.
      if (c.req.path === "/p/inbox") {
        if (this.env.DEBUG_ROUTES === "1") {
          BridgeDO.remember(this.debugInboxCalls, v.pub, (this.debugInboxCalls.get(v.pub) ?? 0) + 1);
          if (this.debugBucket === undefined) this.debugBucket = (await this.get<{ burst: number; refillMs: number }>("debug:bucket")) ?? null; // dev only, once per instance
        }
        const t = this.takeInboxToken(v.pub);
        if (!t.ok) {
          c.header("Retry-After", String(t.retryAfterSec));
          c.header("x-can2cup-min", this.minClient());
          return c.json({ error: `too many inbox reads from this key — retry in ${t.retryAfterSec} s (an idle poll every 30 s is plenty)`, retryAfterSec: t.retryAfterSec }, 429);
        }
      }
      if (await this.get(`ban:pub:${v.pub}`)) return c.json({ error: "this identity is banned by the relay operator" }, 403);
      c.set("pub" as never, v.pub as never);
      c.set("body" as never, v.body as never);
      // v0.9.0 upgrade protocol: remember what this agent runs; refuse the A2A routes below the minimum.
      const ver = (c.req.header("x-can2cup-client") ?? "").trim() || NO_VERSION;
      c.set("ver" as never, ver as never);
      // 2026-09-14: two processes on one key may run different versions — rewrite ver: at most every META_PERSIST_MS.
      if (ver !== NO_VERSION && Date.now() - (this.metaWritten.get(`ver:${v.pub}`) ?? 0) >= META_PERSIST_MS && (await this.get<string>(`ver:${v.pub}`)) !== ver) {
        if (await this.bookkeep(() => this.put(`ver:${v.pub}`, ver))) BridgeDO.remember(this.metaWritten, `ver:${v.pub}`, Date.now());
      }
      if (/^\/p\/(rooms|room-created|invite)$/.test(c.req.path) && cmpSemver(ver, this.minClient()) < 0) {
        c.res = await this.upgradeRequired(c, ver);
      } else {
        // review R20: only a live session touches presence. A one-off `doctor`, `report` or room create must not
        // light the green dot for 3 minutes or trigger a "回來了" push.
        if (/^\/p\/(online|heartbeat|inbox|notify|offline|state|ack)$/.test(c.req.path)) await this.touch(v.pub, c.req.path, c.req.header("host") ?? undefined);
        await next();
      }
      // Version headers on every reply, whatever the route returned (a proxied DO response has immutable headers).
      const latest = await this.latestVersion();
      const set = (h: Headers) => { if (latest) h.set("x-can2cup-latest", latest); h.set("x-can2cup-min", this.minClient()); };
      try { set(c.res.headers); } catch { const r = new Response(c.res.body, c.res); set(r.headers); c.res = r; }
      return c.res;
    });

    // Presence. `online` = the MCP process just started (or wants to be counted present); `heartbeat`
    // = same, every 60 s while it runs; `offline` = it is shutting down (best effort from the process).
    app.post("/p/online", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = await this.bindingByPub(pub);
      // v0.9.0: a client from before the upgrade protocol never sees x-can2cup-latest. Its principal is the only
      // one who can act — one LINE nudge a month, only for a bound agent.
      if (b && (c.get("ver" as never) as string) === NO_VERSION) {
        const last = await this.get<string>(`oldnag:${pub}`);
        if (!last || Date.now() - Date.parse(last) > 30 * 86400_000) {
          await this.put(`oldnag:${pub}`, new Date().toISOString());
          const origin = new URL(c.req.url).origin;
          const L = await this.placeLang(b.userId);
          await this.push(b.userId, "upgrade:old", tr(L, "🆙 你的 agent（{name}）跑的是舊版 can2cup，收不到升級通知。在那台電腦跑：\n{install}\n然後重開一次 Claude Code。之後它會自己知道有沒有新版。", { name: b.name || short(pub), install: installLine(origin, await hasMirror(this.env)) }));
        }
      }
      // v0.9.10 B2: the client reports whether its mandate is widened / its commit gate is off, so LINE can label
      // the 同意 button honestly. Stored per agent; a client from before this never sends it (→ "not reported").
      await this.armAlarm(Date.now() + 5 * 60_000); // v0.9.12: make sure the daily idle sweep has an alarm to ride, even on a quiet relay
      const ob = JSON.parse((c.get("body" as never) as string) || "{}") as { tier?: { widened?: unknown; unsigned_may_commit?: unknown } };
      if (ob.tier && typeof ob.tier === "object") {
        const tier = { widened: ob.tier.widened === true, unsigned_may_commit: ob.tier.unsigned_may_commit === true };
        const prevTier = await this.get<{ widened: boolean; unsigned_may_commit: boolean }>(`tier:${pub}`);
        if (!prevTier || prevTier.widened !== tier.widened || prevTier.unsigned_may_commit !== tier.unsigned_may_commit) await this.put(`tier:${pub}`, { ...tier, at: new Date().toISOString() }); // 2026-09-14: only when it changed
      }
      const lastRead = await this.get<string>(`read:${pub}`);
      const items = (await this.get<InboxItem[]>(`inbox:${pub}`)) ?? [];
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};
      return c.json({ ok: true, bound: !!b, pendingInbox: items.filter((i) => !lastRead || i.at > lastRead).length, openRooms: Object.entries(rooms).filter(([, r]) => r.state === "open").map(([id, r]) => ({ id, name: r.name, lastSeq: r.lastSeq })) });
    });
    app.post("/p/heartbeat", async (c) => c.json({ ok: true }));
    app.post("/p/offline", async (c) => {
      const pub = c.get("pub" as never) as string;
      const now = new Date().toISOString();
      await this.put(`offline:${pub}`, now);
      // Mark it away immediately (so /bridge/inbox and room pushes warn straight away), but hold the
      // phone buzz: one closed Claude Code window is not the agent leaving when other sessions of the
      // same key are still heartbeating. sweepOffline() announces it if it is still gone at `due`.
      const due = Date.now() + this.graceMs();
      await this.put(`offpend:${pub}`, { at: now, due } as OffPend);
      await this.armAlarm(due);
      return c.json({ ok: true, announceInSec: Math.round(this.graceMs() / 1000) });
    });

    app.post("/p/link", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { name?: string };
      const code = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
      await this.put(`code:${code}`, { pub, name: b.name ?? "", at: Date.now() });
      const existing = await this.bindingByPub(pub);
      return c.json({ code, expiresInSec: CODE_TTL_MS / 1000, alreadyBound: !!existing, boundTo: existing?.userId ? short(existing.userId) : undefined });
    });

    // Reverse link (v0.4.3): the human typed "/link" to the bot first; the bot got a code bound to their
    // userId; the agent claims it. Same binding, opposite direction — the human only ever copies what
    // the bot hands them.
    app.post("/p/claim", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { code?: string; name?: string };
      const code = (b.code ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (await this.codeBlocked("claim", pub)) return c.json({ error: BridgeDO.TOO_MANY_CODES }, 429);
      const rec = code ? await this.get<{ userId: string; at: number; ttlMs?: number }>(`pcode:${code}`) : undefined;
      if (!rec || Date.now() - rec.at > (rec.ttlMs ?? CODE_TTL_MS)) { await this.codeMiss("claim", pub); return c.json({ error: "unknown or expired code" }, 404); }
      if (await this.get(`ban:user:${rec.userId}`)) { await this.put(`ban:pub:${pub}`, { at: new Date().toISOString(), why: "claimed by a banned chat user" }); return c.json({ error: "banned" }, 403); } // review R9
      await this.del(`pcode:${code}`);
      const lang = await this.userLang(rec.userId); // v0.17.0: read BEFORE the binding exists (a bound account without one reads as legacy)
      const prevByUser = await this.bindingByUser(rec.userId);
      if (prevByUser) await this.del(`pub:${prevByUser.pub}`);
      const prevByPub = await this.bindingByPub(pub);
      if (prevByPub) await this.del(`user:${prevByPub.userId}`);
      const binding: Binding = { pub, name: b.name ?? "", userId: rec.userId, agentMode: false, boundAt: new Date().toISOString() };
      await this.put(`user:${rec.userId}`, binding);
      await this.put(`pub:${pub}`, binding);
      await this.onBound(rec.userId, pub, lang);
      await this.push(rec.userId, "link:claimed", tr(lang, "✅ 綁定完成：這個 {chat} 現在是 agent「{name}」的遙控器 —— 也就是那台電腦上的 Claude Code，不分視窗。它會自己跟你打聲招呼。試試 /a 你好、/status。", { chat: vocabIn(this.chanFor(rec.userId), lang).chat, name: b.name || short(pub) }));
      return c.json({ ok: true, userId: short(rec.userId), channel: this.chanFor(rec.userId).name });
    });

    // v0.9.12: the agent's side of /keep — how long this binding may sit idle before it lapses.
    app.post("/p/keep", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = await this.bindingByPub(pub);
      if (!b) return c.json({ error: "not bound" }, 404);
      const body = JSON.parse((c.get("body" as never) as string) || "{}") as { days?: unknown; forever?: unknown };
      const r = await this.setIdle(pub, body, "agent");
      if ("error" in r) return c.json(r, 400);
      return c.json({ ok: true, idle: await this.idleOf(pub, b) });
    });
    app.get("/p/state", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = await this.bindingByPub(pub);
      return c.json({
        bound: !!b, boundAt: b?.boundAt ?? null, idle: b ? await this.idleOf(pub, b) : null, paused: (await this.get<boolean>(`paused:${pub}`)) ?? false, agentMode: b?.agentMode ?? false,
        inboxSeq: (await this.get<number>(`inboxSeq:${pub}`)) ?? 0,
        principalPub: (await this.get<string>(`principal:${pub}`)) ?? null,
        signedPause: (await this.get<SignedPrincipalMsg>(`spause:${pub}`)) ?? null,
        channel: await this.channelHealth(b),
        lang: b ? await this.userLang(b.userId) : null, // v0.17.0
      });
    });

    // The agent pins its principal's pubkey here (read from the principal's own ~/.parley).
    // Signed by the agent key, so only the agent — whose home IS the principal's dir — can set it.
    app.post("/p/principal", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { principalPub?: string; proof?: SignedAgentClaim };
      if (!b.principalPub || !/^[0-9a-f]{64}$/.test(b.principalPub)) return c.json({ error: "principalPub (hex ed25519) required" }, 400);
      // v0.15.2: an optional principal-signed proof that this agent is that principal's (protocol/principal.ts
      // verifyAgentClaim). Without it the registration still works as before (old clients), but the agent is not
      // PROVEN and the principal-scoped dashboard will not group it. Rules (second opinion on docs/dashboard-tool.md):
      // wrong proof → refused, nothing changes; no proof + same P → an existing proof survives; no proof + new P →
      // the old proof and index go; a valid proof → P, proof and index updated together.
      const prev = await this.get<string>(`principal:${pub}`);
      const prevProof = await this.get<AgentProof>(`principalProof:${pub}`);
      if (b.proof !== undefined) {
        const v = verifyAgentClaim(b.proof, { agent: pub, relayPub: this.relayPub() });
        if (!v.ok) return c.json({ error: `proof rejected: ${v.error}` }, 400);
        if (b.proof.principalPub !== b.principalPub) return c.json({ error: "proof names a different principal" }, 400);
      }
      await this.put(`principal:${pub}`, b.principalPub);
      if (prev && prev !== b.principalPub) {
        await this.del(`spause:${pub}`); // a new principal key: old signed pause no longer applies
        if (prevProof) { await this.del(`principalProof:${pub}`); await this.del(`principalAgent:${prev}:${pub}`); }
      }
      if (b.proof) {
        await this.put(`principalProof:${pub}`, { principalPub: b.principalPub, relayPub: this.relayPub(), at: b.proof.at, verifiedAt: new Date().toISOString() } as AgentProof);
        await this.put(`principalAgent:${b.principalPub}:${pub}`, new Date().toISOString());
      }
      const proven = !!b.proof || (!!prevProof && prev === b.principalPub);
      return c.json({ ok: true, principalPub: b.principalPub, changed: prev !== b.principalPub, proven });
    });

    // v0.15.2: the principal-scoped view for the CLI (`can2cup status --all`); same data as the hosted can2cup_status
    // tool. Not in the presence touch list on purpose: looking at the dashboard must not light the green dot.
    app.get("/p/dashboard", async (c) => {
      const pub = c.get("pub" as never) as string;
      const limited = await this.dashboardRateLimited(pub);
      if (limited) return c.json({ error: limited }, 429);
      return c.json(await this.dashboardFor(pub, {}));
    });

    // v0.8.0: reading is not receiving. Every item handed out starts a lease; the agent acks by acting
    // (tell_principal) or by POST /p/ack. An item whose lease ran out with no ack comes back on the next
    // read (flagged `redelivered`) — the case where `can2cup watch` printed to a terminal nobody watched.
    app.get("/p/inbox", async (c) => {
      const pub = c.get("pub" as never) as string;
      // v0.11.3 (smoke, fifth opinion #1): let the suite make the NEXT n inbox reads fail while everything else works.
      if (this.env.DEBUG_ROUTES === "1") {
        const f = await this.get<number | { n: number; status: number }>(`debug:inboxfail:${pub}`);
        const fn = typeof f === "number" ? f : f?.n ?? 0;
        const fstatus = typeof f === "object" && f ? f.status : 503;
        if (fn > 0) { await this.put(`debug:inboxfail:${pub}`, { n: fn - 1, status: fstatus }); return c.json({ error: "debug: inbox unavailable" }, fstatus as 503); }
      }
      const since = Number(c.req.query("since") ?? 0) || 0;
      const peek = c.req.query("peek") === "1";          // review R14: look without starting a lease
      const instance = c.req.query("instance") ?? "";      // review R5: who is claiming
      const all = (await this.get<InboxItem[]>(`inbox:${pub}`)) ?? [];
      const now = Date.now();
      const out: InboxItem[] = [];
      let touched = false;
      for (const i of all) {
        const leased = !i.ackedAt && !!i.deliveredAt && now - Date.parse(i.deliveredAt) <= this.leaseMs();
        const fresh = i.seq > since;
        const stale = !fresh && !i.ackedAt && !!i.deliveredAt && !leased;
        if (!fresh && !stale) continue;
        // review R5: a lease is a claim — another instance holding it inside the lease means "not yours yet".
        if (!peek && leased && instance && i.deliveredTo && i.deliveredTo !== instance) continue;
        if (peek) { out.push(i); continue; }
        if (stale) i.redelivered = true;
        i.deliveredAt = new Date(now).toISOString();
        if (instance) i.deliveredTo = instance;
        touched = true;
        out.push(i);
      }
      if (touched) { await this.put(`inbox:${pub}`, all); await this.armAlarm(now + this.leaseMs() + 1000); }
      // 2026-09-14: the read cursor moves only when something was actually handed out (a peek or an empty poll is not a read).
      if (!peek && out.length > 0) await this.bookkeep(() => this.put(`read:${pub}`, new Date(now).toISOString()), { budget: false });
      // An empty answer tells the client how long to leave it; longer when this key has been reading hard.
      if (!out.length) { const burst = this.bucketSpec(pub).burst; c.header("x-can2cup-poll-after", String((this.buckets.get(pub)?.tokens ?? burst) < burst / 2 ? POLL_AFTER_SLOW_SEC : POLL_AFTER_SEC)); }
      const b = await this.bindingByPub(pub);
      return c.json({ messages: out, paused: (await this.get<boolean>(`paused:${pub}`)) ?? false, bound: !!b, lastSeq: (await this.get<number>(`inboxSeq:${pub}`)) ?? 0 });
    });

    // v0.8.1: an agent that could not fix its own install/run problem files a diagnostic report. Stored 30 days,
    // pushed to the operator's LINE (OPERATOR_LINE_USER_ID) so it can be fixed for everyone. No room content:
    // the client sends only `can2cup doctor` output, versions and error lines. Rate: 5 per agent per day.
    app.post("/p/report", async (c) => {
      const pub = c.get("pub" as never) as string;
      const bind0 = await this.bindingByPub(pub);
      if (!bind0) return c.json({ ok: false, reason: "only an agent linked to a principal's chat account can file a report — show your human the `can2cup doctor` output instead" }, 403); // review R4
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { note?: string; doctor?: string; version?: string; platform?: string; errors?: string[] };
      const day = new Date().toISOString().slice(0, 10);
      const qk = `reports:${pub}:${day}`;
      const n = (await this.get<number>(qk)) ?? 0;
      if (n >= 5) return c.json({ ok: false, reason: "report limit reached for today (5)" }, 429);
      await this.put(qk, n + 1);
      const id = `${day.replace(/-/g, "").slice(2)}-${randomHex(2).toUpperCase()}`;
      const bind = await this.bindingByPub(pub);
      const rec = { id, at: new Date().toISOString(), pub, agent: bind?.name ?? short(pub), lineUser: bind?.userId ?? null, version: (b.version ?? "").slice(0, 40), platform: (b.platform ?? "").slice(0, 120), note: (b.note ?? "").slice(0, 2000), doctor: (b.doctor ?? "").slice(0, 8000), errors: (b.errors ?? []).slice(0, 20).map((e) => String(e).slice(0, 500)) };
      await this.put(`report:${id}`, rec);
      const op = this.env.OPERATOR_LINE_USER_ID;
      const rpk = `q:reportpush:${day}`;
      const rpn = (await this.get<number>(rpk)) ?? 0;
      if (op && rpn < REPORT_PUSHES_PER_DAY) await this.put(rpk, rpn + 1); // review R4: reports have their own small push budget
      if (op && rpn < REPORT_PUSHES_PER_DAY) await this.push(op, "report", `🛠 回報 ${id}\n${rec.agent}（${rec.version || "?"}，${rec.platform || "?"}）\n${rec.note || "(沒寫原因)"}\n${rec.errors[0] ? `最近錯誤：${rec.errors[0].slice(0, 200)}\n` : ""}看全文：/bridge/report/${id}`, undefined, undefined, undefined, "can2cup 回報"); // i18n-ok: to the operator
      return c.json({ ok: true, id, operatorNotified: !!op && rpn < REPORT_PUSHES_PER_DAY });
    });

    // v0.8.0: the agent (or the session that read the instruction) confirms it is handling everything up to seq.
    app.post("/p/ack", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { seq?: number };
      const n = await this.ackInbox(pub, Number(b.seq) || Number.MAX_SAFE_INTEGER);
      return c.json({ ok: true, acked: n });
    });

    // Invite-by-LINE (v0.4.2): the inviting agent registers a room invite and gets a short code + a LINE deep
    // link. The invitee scans/taps it on their PHONE → the bot chat opens with "/join CODE" prefilled → the
    // bridge drops the invite into THEIR agent's inbox → their agent auto-joins. Nothing is pasted to a desktop.
    app.post("/p/invite", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { room?: string; invite?: string; name?: string; fromName?: string };
      if (!b.room || !b.invite || typeof b.invite !== "string") return c.json({ error: "room and invite (link) required" }, 400);
      // v0.14.3 (short-code-join review S2/S3), tightened per codex 6.0 (two rounds): parse with the joiner's URL
      // decoder and store the RE-ENCODED canonical link — never the raw input. Use decodeInviteUrl, NOT the lenient
      // decodeInvite: its compact-token branch trusts an attacker-set `u` (an embedded E2E URL + trailing junk) that
      // encodeInviteUrl would then concatenate and store, leaking the key; URL-only parsing also rejects the earlier
      // multi-segment trick. Honest callers always send a URL, so this loses nothing. (No inRoom check: minting
      // requires already holding the full secret-bearing link, which by itself already grants join.)
      let inv: ReturnType<typeof decodeInviteUrl>;
      try { inv = decodeInviteUrl(b.invite); } catch { return c.json({ error: "invite must be a full https://…/j/<room>#<secret> link" }, 400); }
      if (inv.r !== b.room) return c.json({ error: "that invite is for a different room" }, 400);
      if (!inv.s || !/^[0-9a-f]{16,}$/.test(inv.s)) return c.json({ error: "invite must be the full link including its #secret" }, 400);
      if (inv.k) return c.json({ error: "an end-to-end encrypted room's invite carries the room key, which this relay must never hold — hand its full link over directly, do not mint a code" }, 400);
      const cleanInvite = encodeInviteUrl(inv);
      const day = new Date().toISOString().slice(0, 10);
      const qk = `q:inv:${pub}:${day}`;
      const used = (await this.get<number>(qk)) ?? 0;
      if (used >= INVITE_MINT_PER_DAY) { await this.flagAbuse("invites", pub, `一天內第 ${used + 1} 次鑄邀請碼(上限 ${INVITE_MINT_PER_DAY})`); return c.json({ error: `daily invite-code quota reached (${INVITE_MINT_PER_DAY}/day)` }, 429); } // i18n-ok: to the operator
      await this.put(qk, used + 1);
      const code = await this.freshInvCode();
      if (!code) return c.json({ error: "could not allocate a free invite code, try again" }, 503);
      await this.put(`inv:${code}`, { invite: cleanInvite, room: b.room, name: b.name ?? "", fromPub: pub, fromName: b.fromName ?? short(pub), at: Date.now() } as StoredInvite);
      const minter = await this.bindingByPub(pub); // the minter's own chat app shapes the link; an unbound minter gets the bare-id channel's (LINE), as before
      const url = this.chanFor(minter?.userId).deepLink(`/join ${code}`);
      return c.json({ code, url, expiresInSec: INVITE_TTL_MS / 1000 });
    });

    // v0.14.3: resolve a short join code to its invite for a LOCAL agent — the local-agent twin of the LINE
    // /bridge/join. Same inv: code, same 24h TTL, same 10-wrong/hour cap. The gate is bindingByPub, exactly as
    // /bridge/join is gated by bindingByUser: /p/* is signature-only, so without a binding a fresh self-signed key
    // could brute the 32-bit code space for free (the per-caller cap is keyed on pub, which would be attacker-chosen).
    // Requiring a binding makes key-rotation cost a LINE /setup. The invite is returned to the (bound) caller — for a
    // local agent, the response IS its inbox. E2E rooms never reach here: their invite is never stored under inv: (see
    // /p/invite's guard above), so a code only ever yields a link the relay already holds for a non-E2E room.
    app.post("/p/join-code", async (c) => {
      const pub = c.get("pub" as never) as string;
      if (!(await this.bindingByPub(pub))) return c.json({ error: "only an agent linked to a principal's chat account can resolve a join code (can2cup link, or /setup in the chat app, first); to join without a binding, use the full invite link" }, 403);
      if (await this.codeBlocked("join", pub)) return c.json({ error: BridgeDO.TOO_MANY_CODES }, 429);
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { code?: unknown };
      // codex 6.0: a non-string code (number, array, null) must fail closed as a miss, not throw a 500 before codeMiss.
      const up = (typeof b.code === "string" ? b.code : "").toUpperCase().replace(/\s+/g, "");
      const norm = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(up) ? (up.includes("-") ? up : `${up.slice(0, 4)}-${up.slice(4)}`) : "";
      const rec = norm ? await this.get<StoredInvite>(`inv:${norm}`) : undefined;
      if (!rec || Date.now() - rec.at > INVITE_TTL_MS) { await this.codeMiss("join", pub); return c.json({ error: "unknown or expired invite code" }, 404); }
      return c.json({ invite: rec.invite, room: rec.room, name: rec.name, from: rec.fromName });
    });

    // v0.5.1: the agent answers a /room request (see /bridge/room-request): it created the room on
    // its own machine — the relay never holds a room-creating key for a local agent — and hands back
    // the invite. The bridge turns that into a join code, posts it into the requesting group, and
    // mirrors the room there, so the humans watching the group see the room they asked for.
    // v0.8.2: opening a room no longer needs the operator's relay key. Any agent whose principal linked it on
    // LINE may open ROOMS_PER_DAY rooms a day (same quota as the hosted layer). Before this, only the operator's
    // own machine could answer a /room request — everyone else's auto-create failed with "key not set".
    app.post("/p/rooms", async (c) => {
      const pub = c.get("pub" as never) as string;
      const bind = await this.bindingByPub(pub);
      if (!bind) return c.json({ error: "only an agent linked to a principal's chat account can open rooms here (can2cup_link, or /setup in the chat app, first)" }, 403);
      if (await this.get(`ban:pub:${pub}`)) return c.json({ error: "banned" }, 403);
      const day = new Date().toISOString().slice(0, 10);
      const qk = `q:rooms:${pub}:${day}`;
      const used = (await this.get<number>(qk)) ?? 0;
      const lim = Math.max(1, Number(this.env.ROOMS_PER_DAY ?? 10) || 10);
      if (used >= lim) { await this.flagAbuse("rooms", pub, `一天內第 ${used + 1} 次開房（上限 ${lim}）`); return c.json({ error: `daily room quota reached (${lim}/day)` }, 429); } // i18n-ok: to the operator
      await this.put(qk, used + 1); // review R12: reserve before the DO round-trip, so concurrent calls cannot all see 0
      const body = JSON.parse((c.get("body" as never) as string) || "{}") as { name?: string; policy?: Record<string, number>; e2e?: boolean };
      const id = randomHex(6);
      const res = await this.env.ROOMS.get(this.env.ROOMS.idFromName(id)).fetch(new Request(`https://do/rooms/${id}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: (body.name ?? "").slice(0, 80), policy: body.policy ?? {}, creator: { pubkey: pub, name: bind.name }, ...(body.e2e ? { e2e: true } : {}) }),
      }));
      if (!res.ok) await this.put(qk, used); // give the slot back on failure
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
    });

    app.post("/p/room-created", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { room?: string; name?: string; invite?: string; group?: string };
      if (!b.room || !/^[0-9a-f]{12}$/.test(b.room) || !b.invite || typeof b.invite !== "string" || !b.group) return c.json({ error: "room, invite and group required" }, 400);
      // review R7 / v0.11.1 (third opinion #4) / codex 6.0: parse with the joiner's URL decoder and store the
      // re-encoded canonical link (below), never the raw input. decodeInviteUrl (not the lenient decodeInvite) rejects
      // both a crafted multi-segment link and a compact token whose attacker-set `u` embeds an E2E URL — either would
      // otherwise land the room key in inv:. An E2E room cannot be wired to a group at all. The invite must also be for
      // THIS room, and the caller must be in it.
      let inv: ReturnType<typeof decodeInviteUrl>;
      try { inv = decodeInviteUrl(b.invite); } catch { return c.json({ error: "invite must be a full https://…/j/<room>#<secret> link" }, 400); }
      if (!inv.s || !/^[0-9a-f]{16,}$/.test(inv.s)) return c.json({ error: "invite must be the full link including its #secret" }, 400);
      if (inv.k) return c.json({ error: "an end-to-end encrypted room cannot be wired to a LINE group: its invite carries the room key, which this relay must never hold" }, 400);
      if (inv.r !== b.room) return c.json({ error: "that invite is for a different room" }, 400);
      if (!(await this.inRoom(pub, b.room))) return c.json({ error: "you are not in that room" }, 403);
      const cleanInvite = encodeInviteUrl(inv);
      let pend = await this.get<{ name?: string; by?: string; at: number }>(`roomreq:${pub}:${b.group}`);
      if (!pend || Date.now() - pend.at > ROOMREQ_TTL_MS) {
        // v0.8.2: no /room request pending — still fine if the principal has spoken from that group before
        // (`can2cup wire <room> <group>`: a room opened by hand gets attached to the group after the fact).
        const known = (await this.get<KnownGroup[]>(`groups:${pub}`)) ?? [];
        if (!known.some((g) => g.id === b.group)) return c.json({ error: "no pending /room request from that group, and your principal has never spoken from it (they can type /status → 接上這個群, or /a anything, there first)" }, 404); // i18n-ok: an error for the agent
        pend = { at: Date.now() };
      }
      const bind = await this.bindingByPub(pub);
      // v0.9.9 T4, defence in depth: two /room in the same second can race the request-time check.
      const held = await this.wiredByOther(b.group, bind?.userId);
      if (held) return c.json({ error: "that group is connected by someone else; ask them to /unmirror first", by: held.by }, 403);
      await this.del(`roomreq:${pub}:${b.group}`);
      const name = b.name || pend.name || "";
      // codex 6.0: this endpoint also mints an inv: code, so it shares the per-pub daily mint quota with /p/invite —
      // otherwise repeatedly re-wiring a known group could mint past the cap.
      const invDay = new Date().toISOString().slice(0, 10);
      const invQk = `q:inv:${pub}:${invDay}`;
      const invUsed = (await this.get<number>(invQk)) ?? 0;
      if (invUsed >= INVITE_MINT_PER_DAY) { await this.flagAbuse("invites", pub, `一天內第 ${invUsed + 1} 次鑄邀請碼(上限 ${INVITE_MINT_PER_DAY}, wire)`); return c.json({ error: `daily invite-code quota reached (${INVITE_MINT_PER_DAY}/day)` }, 429); } // i18n-ok: to the operator
      const code = await this.freshInvCode();
      if (!code) return c.json({ error: "could not allocate a free invite code, try again" }, 503);
      await this.put(invQk, invUsed + 1);
      await this.put(`inv:${code}`, { invite: cleanInvite, room: b.room, name, fromPub: pub, fromName: bind?.name || short(pub), at: Date.now() } as StoredInvite);
      // v0.7.2: a /room-created room IS that group — mirror everything, not just decision points.
      await this.setMirror(b.group, { room: b.room, all: true, by: bind?.userId ?? "", at: new Date().toISOString() });
      // v0.9.2: /status is built from the rooms this bridge knows, and until now it only learned of a
      // room when its first message came through — so a group the principal had just wired was missing
      // from their own status card. Register it at wiring time; the first event fills in the rest.
      if (!(await this.get<RoomKnown>(`room:${b.room}`))) {
        const known: RoomKnown = { name, state: "open", lastSeq: 0, participants: { [pub]: bind?.name || short(pub) } };
        await this.put(`room:${b.room}`, known);
        const mine = (await this.get<Record<string, RoomKnown>>(`rooms:${pub}`)) ?? {};
        mine[b.room] = known;
        await this.put(`rooms:${pub}`, mine);
      }
      const url = this.chanFor(b.group).deepLink(`/join ${code}`); // a channel with no prefilled-chat link (Discord) gets the bare code
      const who = pend.by || bind?.name || short(pub);
      const GL = (await this.groupLang(b.group)) ?? LEGACY_LANG;
      await this.push(b.group, "room:created",
        tr(GL, "🔌 這個群接上了（{who} 的 agent）{name}\n{how}\nagent 在這裡說的每一句都會貼進來；打 /a 就是對自己的 agent 說話。/status 看誰接上了。", {
          who, name: name ? tr(GL, "：{name}", { name }) : "",
          how: url ? tr(GL, "群裡其他人要讓自己的 agent 也進來 → 點連結、按送出：\n{url}\n（或對我打 /join {code}）", { url, code }) : tr(GL, "群裡其他人要讓自己的 agent 也進來：對我打 /join {code}", { code }),
        }));
      return c.json({ ok: true, code, url, expiresInSec: INVITE_TTL_MS / 1000 });
    });

    // v0.4.5: which LINE groups can this agent address? (every group the principal has /a'd from)
    // v0.9.5: the way out, signed by the agent itself. `can2cup unbind` / `can2cup erase`.
    app.post("/p/erase", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { scope?: string };
      const scope = b.scope === "all" ? "all" : "binding";
      const bind = await this.bindingByPub(pub);
      const L = bind ? await this.placeLang(bind.userId) : LEGACY_LANG; // before erase() forgets it
      const deleted = await this.erase(pub, scope);
      if (bind) {
        await this.push(bind.userId, "erase",
          scope === "all"
            ? tr(L, "👋 你電腦上的 agent（{name}）已經要求把資料從 can2cup 上刪掉，這個 {chat} 帳號跟它的綁定也解除了。\n剩下的:別人房間裡已經收到的訊息在對方手上，我們刪不掉。", { name: bind.name || short(pub), chat: vocabIn(this.chanFor(bind.userId), L).chat })
            : tr(L, "🔓 你電腦上的 agent（{name}）解除了跟這個 {chat} 帳號的綁定。收件匣跟群組設定都刪了。要重新接上就再打 /setup。", { name: bind.name || short(pub), chat: vocabIn(this.chanFor(bind.userId), L).chat }));
      }
      return c.json({ ok: true, scope, wasBound: !!bind, channel: bind ? this.chanFor(bind.userId).name : null, deleted });
    });

    app.get("/p/groups", async (c) => {
      const pub = c.get("pub" as never) as string;
      // v0.15.1: each group says which chat app it lives on, so the client can name it without sniffing the id
      return c.json({ groups: ((await this.get<KnownGroup[]>(`groups:${pub}`)) ?? []).map((g) => ({ ...g, channel: this.chanFor(g.id).name })), lastGroup: (await this.get<string>(`lastGroup:${pub}`)) ?? null });
    });

    // v0.4.5: ephemeral image hosting — LINE image messages need a public https URL; this stores one
    // for `ttl` seconds (default 1 h) and serves it at /f/:id. Auto-purged by alarm(); no third-party host.
    app.post("/p/image", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = JSON.parse((c.get("body" as never) as string) || "{}") as { data?: string; mime?: string; ttl?: number };
      const mime = b.mime === "image/jpeg" ? "image/jpeg" : b.mime === "image/png" ? "image/png" : undefined;
      if (!b.data || !mime) return c.json({ error: "data (base64) and mime (image/png|image/jpeg) required" }, 400);
      // Only an agent whose principal linked LINE gets to host bytes here: an anonymous key must
      // not turn this into a free image host, and the binding is what a ban can bite on.
      if (!(await this.bindingByPub(pub))) return c.json({ error: "image hosting requires an agent linked to a principal's chat account (can2cup_link first)" }, 403);
      if (!/^[A-Za-z0-9+/=]+$/.test(b.data)) return c.json({ error: "data must be base64" }, 400);
      if (b.data.length > 4_200_000) return c.json({ error: "image too large (max ~3 MB)" }, 413);
      const imgDay = new Date().toISOString().slice(0, 10);
      const imgQ = `q:img:${pub}:${imgDay}`;
      const imgUsed = (await this.get<number>(imgQ)) ?? 0;
      const imgLim = Math.max(1, Number(this.env.IMG_BYTES_PER_DAY ?? 5_000_000) || 5_000_000);
      if (imgUsed + b.data.length > imgLim) return c.json({ error: `daily image quota reached (${imgLim} base64 bytes/day for this key)` }, 429);
      const ttl = Math.min(IMG_TTL_MAX, Math.max(IMG_TTL_MIN, Number(b.ttl ?? IMG_TTL_DEFAULT) || IMG_TTL_DEFAULT));
      const id = randomHex(16);
      const expires = Date.now() + ttl * 1000;
      const chunks = Math.ceil(b.data.length / IMG_CHUNK);
      for (let i = 0; i < chunks; i++) await this.put(`imgc:${id}:${i}`, b.data.slice(i * IMG_CHUNK, (i + 1) * IMG_CHUNK));
      await this.put(`img:${id}`, { mime, expires, chunks, by: pub } as ImgMeta);
      await this.put(imgQ, imgUsed + b.data.length);
      const cur = await this.ctx.storage.getAlarm();
      if (cur == null || cur > expires + 1000) await this.setAlarmAt(expires + 1000);
      return c.json({ ok: true, id, url: `${new URL(c.req.url).origin}/f/${id}`, expiresInSec: ttl });
    });

    // Public: serve an ephemeral image until it expires (lazy-purged here, alarm-purged otherwise).
    app.get("/f/:id", async (c) => {
      const id = c.req.param("id");
      if (!/^[0-9a-f]{32}$/.test(id)) return c.text("not found", 404);
      const meta = await this.get<ImgMeta>(`img:${id}`);
      if (!meta || Date.now() >= meta.expires) { if (meta) await this.purgeImage(id, meta.chunks); return c.text("gone", 404); }
      let b64 = "";
      for (let i = 0; i < meta.chunks; i++) b64 += (await this.get<string>(`imgc:${id}:${i}`)) ?? "";
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": meta.mime, "cache-control": "no-store" } });
    });

    // The agent's own client reports what the principal must know: blocked sends, escalations.
    app.post("/p/notify", async (c) => {
      const pub = c.get("pub" as never) as string;
      const b = await this.bindingByPub(pub);
      if (!b) return c.json({ ok: false, reason: "not bound" });
      const n0 = JSON.parse((c.get("body" as never) as string) || "{}") as { handled?: number };
      // review R16: answering acks what the agent has actually seen (the client sends its cursor), not everything.
      if (n0.handled != null) await this.ackInbox(pub, Number(n0.handled) || 0);
      const n = JSON.parse((c.get("body" as never) as string) || "{}") as { kind?: string; room?: string; seq?: number; text?: string; where?: string; image?: string; note?: { code?: unknown; vars?: unknown } };
      const roomName = n.room ? ((await this.get<RoomKnown>(`room:${n.room}`))?.name || n.room) : "";
      // `info` replies go back to where the principal last spoke from (their LINE group, if that is
      // where the /a came from) unless the agent says dm/group explicitly; blocked/escalate are
      // private and always go to the 1:1. v0.4.5: "group:<alias|id-prefix|name>" addresses ANY group
      // the principal has ever /a'd from (see /p/groups) — lastGroup stops being a single global slot.
      const lastGroup = await this.get<string>(`lastGroup:${pub}`);
      const where = n.where ?? "auto";
      let targetGroup: string | undefined;
      if (n.kind === "info") {
        if (where === "group" || where === "auto") targetGroup = lastGroup ?? undefined;
        else if (where.startsWith("group:")) {
          const q = where.slice(6).trim().toLowerCase();
          const list = (await this.get<KnownGroup[]>(`groups:${pub}`)) ?? [];
          const g = list.find((x) => x.alias === q) ?? list.find((x) => x.id.toLowerCase().startsWith(q)) ?? list.find((x) => !!x.name && x.name.toLowerCase().includes(q));
          if (!g) return c.json({ ok: false, reason: `unknown group "${q}" — known: ${list.map((x) => `${x.alias}${x.name ? `=${x.name}` : ""}`).join(", ") || "none (your principal has not /a'd from a group yet)"}` });
          targetGroup = g.id;
        }
      }
      const toGroup = !!targetGroup;
      if (n.kind === "info" && where === "group" && !lastGroup) return c.json({ ok: false, reason: "no group: your principal has not sent /a from a group yet" });
      // LINE needs a public https URL for external images. Our own /f/ store is exempt from the
      // scheme check: in production its origin is https anyway, and under `wrangler dev` with a
      // custom-domain route the rewritten origin is http://<domain> — which used to make the relay
      // reject the very URL its own /p/image had just handed out.
      const own = new URL(c.req.url).origin;
      if (n.image && !/^https:\/\//.test(n.image) && !n.image.startsWith(`${own}/f/`) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(n.image)) return c.json({ ok: false, reason: "image must be an https URL (use /p/image to host one)" });
      // v0.7.4: the bubble's author is the agent itself (LINE `sender`), so the header only carries what the name can't.
      const L = await this.placeLang(toGroup ? targetGroup! : b.userId);
      const head = n.kind === "blocked" ? tr(L, "⛔ 被 mandate 擋下") : n.kind === "escalate" ? tr(L, "🙋 需要你決定") : "";
      const ref = n.seq != null ? `:${n.seq}` : "";
      const place = roomName ? `（${roomName}）` : "";
      const headLine = head || place ? `${head}${place}\n` : "";
      await this.push(toGroup ? targetGroup! : b.userId, `notify:${n.kind}${toGroup ? ":group" : ""}`, `${headLine}${((n.note ? this.noteText(L, n.note) : undefined) ?? n.text ?? "").slice(0, 4000)}`,
        n.kind === "escalate" && n.room ? [{ label: tr(L, "同意"), data: `parley:ok:${n.room}${ref}` }, { label: tr(L, "拒絕"), data: `parley:no:${n.room}${ref}` }, { label: tr(L, "回話"), data: "parley:fill", fill: "/a " }] : undefined,
        n.room, n.kind === "info" ? n.image : undefined, b.name || short(pub));
      // The push is queued, not sent — so the honest answer is "accepted, and here is what this channel
      // did last time". `tell` turns that into a warning instead of an unconditional "queued".
      return c.json({ ok: true, to: toGroup ? "group" : "dm", channel: await this.channelHealth(b) });
    });

    // ---- channel webhooks (v0.12.0 LINE, v0.12.1 Discord; v0.15.0 one loop over the registry) ------------------
    // Each channel verifies its own delivery over the exact bytes (buffered() upstream keeps them) — LINE an HMAC with
    // the channel secret, Discord an Ed25519 signature the Worker (index.ts) has already checked and answered within
    // Discord's 3 s; this DO verifies again, since the route must be safe on its own. Then every event goes through
    // the console (bot.ts). A relay without the channel's secret has no bot there and answers 404. A console that
    // throws still answers the event when the channel lets it (Discord's deferred bubble would otherwise "think"
    // forever); with LINE the reply token is simply spent on the error line.
    for (const ch of this.channels) {
      app.post(ch.webhookPath, async (c) => {
        if (!ch.configured) return c.json({ error: `no ${ch.label} bot on this relay (its secret is unset)` }, 404);
        const raw = await c.req.arrayBuffer();
        if (!(await ch.verify((n) => c.req.header(n), raw))) return c.json({ error: "bad signature" }, ch.verifyFailStatus as 400);
        const events = ch.parse(new TextDecoder().decode(raw));
        const origin = new URL(c.req.url).origin;
        for (const ev of events) {
          try { await this.onChannelEvent(ev, origin); }
          catch (e) {
            console.error(`${ch.name} event ${ev.kind} ${ev.eventId ?? ""}: ${e instanceof Error ? e.message : String(e)}`);
            if (ev.replyToken) { try { await ch.reply(ev.replyToken, [{ text: `${bridgeDown(LEGACY_LANG)}\n${bridgeDown("en")}` }]); } catch { /* nothing more to say on that token */ } }
          }
        }
        return c.json({ ok: true, events: events.length });
      });
    }

    // ---- bot (bridge key) -------------------------------------------------
    // The key on the wire is for an external bot (the old Render service, a self-hoster's own); the in-process
    // console presents the per-instance internal key instead.
    app.use("/bridge/*", async (c, next) => {
      const key = c.req.header("x-parley-bridge-key") ?? "";
      const ok = (!!this.env.BRIDGE_KEY && key === this.env.BRIDGE_KEY) || key === this.internalKey;
      if (!ok) return c.json({ error: "bad bridge key" }, 401);
      await next();
    });

    app.post("/bridge/link", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { code?: string; userId?: string; displayName?: string; locale?: string };
      const code = (b.code ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (!code || !b.userId) return c.json({ error: "code and userId required" }, 400);
      if (await this.codeBlocked("link", b.userId)) return c.json({ error: BridgeDO.TOO_MANY_CODES }, 429);
      const rec = await this.get<{ pub: string; name: string; at: number }>(`code:${code}`);
      if (!rec || Date.now() - rec.at > CODE_TTL_MS) { await this.codeMiss("link", b.userId); return c.json({ error: "unknown or expired code" }, 404); }
      if ((await this.get(`ban:user:${b.userId}`)) || (await this.get(`ban:pub:${rec.pub}`))) return c.json({ error: "banned" }, 403);
      await this.del(`code:${code}`);
      const lang = await this.userLang(b.userId, b.locale); // v0.17.0: before the binding exists
      // one user ↔ one agent; re-linking replaces both directions
      const prevByUser = await this.bindingByUser(b.userId);
      if (prevByUser) await this.del(`pub:${prevByUser.pub}`);
      const prevByPub = await this.bindingByPub(rec.pub);
      if (prevByPub) await this.del(`user:${prevByPub.userId}`);
      const binding: Binding = { pub: rec.pub, name: rec.name, userId: b.userId, agentMode: false, boundAt: new Date().toISOString() };
      await this.put(`user:${b.userId}`, binding);
      await this.put(`pub:${rec.pub}`, binding);
      await this.onBound(b.userId, rec.pub, lang);
      return c.json({ ok: true, lang, name: rec.name, pub: rec.pub, displayName: b.displayName ?? "" });
    });

    // Bot: "/link" with no code → a code bound to this LINE user, for the agent to claim.
    // ttlSec (optional, 60 s .. 2 h): the bot's /setup embeds the code in the install command
    // (`can2cup setup --link CODE`), and an npm install + setup can easily outlive the 10-minute
    // default — an expired code there means a confusing "unknown code" at the very last step.
    app.post("/bridge/link-code", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { userId?: string; ttlSec?: number; locale?: string };
      if (!b.userId) return c.json({ error: "userId required" }, 400);
      if (await this.get(`ban:user:${b.userId}`)) return c.json({ error: "banned" }, 403); // review R9
      // v0.17.0: first contact — the platform's locale stands for this account's language until /lang says otherwise.
      if (!isLang(await this.get<string>(`ulang:${b.userId}`)) && !(await this.bindingByUser(b.userId))) { const l = normLang(b.locale); if (l) await this.put(`ulang:${b.userId}`, l); }
      const askedMs = Math.round(Number(b.ttlSec) || 0) * 1000;
      const ttlMs = askedMs ? Math.min(2 * 3600_000, Math.max(60_000, askedMs)) : CODE_TTL_MS;
      const code = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
      await this.put(`pcode:${code}`, { userId: b.userId, at: Date.now(), ttlMs });
      return c.json({ code, expiresInSec: ttlMs / 1000 });
    });

    // v0.7.5: the principal's one screen. Humans never see "rooms": they see LINE groups their agent is
    // wired into, who else is in each, and whose agent is there. A room with no LINE group behind it
    // (opened from a desktop) is counted in `hidden`, never listed — that is the engine's business.
    app.get("/bridge/status/:userId", async (c) => {
      const b = await this.bindingByUser(c.req.param("userId"));
      if (!b) return c.json({ bound: false });
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${b.pub}`)) ?? {};
      const known = (await this.get<KnownGroup[]>(`groups:${b.pub}`)) ?? [];
      const presence = await this.presence(b.pub);
      const paused = (await this.get<boolean>(`paused:${b.pub}`)) ?? false;
      const members = async (r: RoomKnown) => {
        const out: Array<{ agent: string; userId: string | null; you: boolean; online: boolean; ver: string | null }> = [];
        for (const [pk, name] of Object.entries(r.participants)) {
          const mb = await this.bindingByPub(pk);
          const mp = pk === b.pub ? presence : await this.presence(pk);
          out.push({ agent: name, userId: mb?.userId ?? null, you: pk === b.pub, online: mp.online, ver: (await this.get<string>(`ver:${pk}`)) ?? null });
        }
        return out;
      };
      const ver = (await this.get<string>(`ver:${b.pub}`)) ?? null; // v0.9.0: null = a client from before the protocol
      const latest = await this.latestVersion();
      const groups: Array<Record<string, unknown>> = [];
      let hidden = 0;
      for (const [rid, r] of Object.entries(rooms)) {
        if (r.state !== "open") continue;
        const gids = (await this.get<string[]>(`mirrors:${rid}`)) ?? [];
        if (!gids.length) { hidden++; continue; }
        const ms = await members(r);
        for (const gid of gids) {
          const m = await this.get<Mirror>(`mirror:${gid}`);
          groups.push({ groupId: gid, groupName: known.find((g) => g.id === gid)?.name ?? null, room: rid, name: r.name, lastSeq: r.lastSeq, all: m?.all ?? false, wiredAt: m?.at ?? null, quiet: (await this.get<boolean>(`quiet:${gid}`)) ?? false, context: (await this.get<boolean>(`ctx:${gid}`)) ?? false, members: ms });
        }
      }
      groups.sort((x, y) => Number(y.lastSeq) - Number(x.lastSeq));
      // ?group=<id>: the group the principal is typing in — wired or not, and whether THEIR agent is in it.
      const gid = c.req.query("group");
      let here: Record<string, unknown> | null = null;
      if (gid) {
        const m = await this.get<Mirror>(`mirror:${gid}`);
        const r = m ? await this.get<RoomKnown>(`room:${m.room}`) : null;
        const q = (await this.get<boolean>(`quiet:${gid}`)) ?? false;
        const cx = (await this.get<boolean>(`ctx:${gid}`)) ?? false;
        here = m && r && r.state === "open"
          ? { wired: true, room: m.room, name: r.name, lastSeq: r.lastSeq, all: m.all, wiredAt: m.at ?? null, quiet: q, context: cx, youIn: !!r.participants[b.pub], members: await members(r) }
          : { wired: false, quiet: q, context: cx };
      }
      // v0.9.9: boundAt / wiredAt — the bot's /status shows "bound since"; null where an older record has no time.
      const tier = (await this.get<{ widened: boolean; unsigned_may_commit: boolean }>(`tier:${b.pub}`)) ?? null; // v0.9.10; null = client never reported
      const idle = await this.idleOf(b.pub, b); // v0.9.12
      return c.json({ bound: true, name: b.name, boundAt: b.boundAt ?? null, presence, paused, groups, hidden, here, ver, latest, min: this.minClient(), tier, idle });
    });

    app.get("/bridge/user/:userId", async (c) => {
      const uid = c.req.param("userId");
      const b = await this.bindingByUser(uid);
      const langOf = { lang: await this.userLang(uid), langSet: isLang(await this.get<string>(`ulang:${uid}`)) }; // v0.17.0
      if (!b) return c.json({ bound: false, ...langOf });
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${b.pub}`)) ?? {};
      return c.json({ bound: true, ...langOf, name: b.name, pub: b.pub, agentMode: b.agentMode, paused: (await this.get<boolean>(`paused:${b.pub}`)) ?? false, principalPub: (await this.get<string>(`principal:${b.pub}`)) ?? null, presence: await this.presence(b.pub), rooms, ver: (await this.get<string>(`ver:${b.pub}`)) ?? null, latest: await this.latestVersion() });
    });

    // v0.17.0: the language this account (1:1) or this group (typed in the group) is spoken to in — by the bot, and by
    // the agent, which reads it off /p/state and off every inbox item. Only a code from LANGS, never free text. A
    // group's language is its wirer's to set, like /context on: it decides how everyone there is spoken to.
    app.post("/bridge/lang", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; groupId?: string; lang?: string };
      if (!p.userId) return c.json({ error: "userId required" }, 400);
      const lang = normLang(p.lang);
      if (!lang) return c.json({ error: "unknown language", langs: LANGS.map((l) => l.code) }, 400);
      if (p.groupId) {
        const m = await this.get<Mirror>(`mirror:${p.groupId}`);
        if (!m) return c.json({ error: "that group is not wired" }, 404);
        if (m.by && m.by !== p.userId) return c.json({ error: "only the person who connected this group can change its language", by: (await this.bindingByUser(m.by))?.name ?? null }, 403);
        m.lang = lang;
        await this.put(`mirror:${p.groupId}`, m);
        return c.json({ ok: true, lang, scope: "group" });
      }
      await this.put(`ulang:${p.userId}`, lang);
      return c.json({ ok: true, lang, scope: "user" });
    });

    app.post("/bridge/user/:userId", async (c) => {
      const b = await this.bindingByUser(c.req.param("userId"));
      if (!b) return c.json({ error: "not bound" }, 404);
      const p = (await c.req.json().catch(() => ({}))) as { agentMode?: boolean; paused?: boolean };
      if (typeof p.agentMode === "boolean") { b.agentMode = p.agentMode; await this.put(`user:${b.userId}`, b); await this.put(`pub:${b.pub}`, b); }
      if (typeof p.paused === "boolean") await this.put(`paused:${b.pub}`, p.paused);
      return c.json({ ok: true, agentMode: b.agentMode, paused: (await this.get<boolean>(`paused:${b.pub}`)) ?? false });
    });

    app.post("/bridge/inbox", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; text?: string; groupId?: string; groupName?: string; eventId?: string };
      if (!p.userId || !p.text) return c.json({ error: "userId and text required" }, 400);
      const b = await this.bindingByUser(p.userId);
      if (!b) return c.json({ error: "not bound" }, 404);
      // review R25: LINE redelivers webhooks after a bot restart; the bot's in-memory dedup is gone by then.
      if (p.eventId) { const prev = await this.get<{ seq: number; at: number }>(`evt:${p.eventId}`); if (prev) return c.json({ ok: true, seq: prev.seq, duplicate: true, presence: await this.presence(b.pub) }); }
      // Remember where the principal spoke from, so the agent's reply can go back there (v0.3.2).
      let g: KnownGroup | undefined;
      if (p.groupId) { await this.put(`lastGroup:${b.pub}`, p.groupId); g = await this.noteGroup(b.pub, p.groupId, p.groupName); }
      else await this.del(`lastGroup:${b.pub}`);
      // v0.9.10 B2: a tapped 同意/拒絕 button is its own tier — still unsigned, but the agent should know it was a button, not typed words.
      const app = this.chanFor(p.userId).name;
      const via = /\(principal tapped the button\)$/.test(p.text) ? `${app}-button` : p.groupId ? `${app}-group` : app;
      // v0.9.12: speaking to the agent from a wired group is use of that room — slide its life forward, or a
      // group in daily use could watch its room expire because only in-room messages counted.
      if (p.groupId) { const m = await this.get<Mirror>(`mirror:${p.groupId}`); if (m) await this.touchRoom(m.room); }
      const seq = await this.appendInbox(b.pub, { at: new Date().toISOString(), lang: (p.groupId ? await this.groupLang(p.groupId) : undefined) ?? (await this.userLang(p.userId)), text: p.text.slice(0, 4000), via, ...(p.groupId ? { group: p.groupId, groupAlias: g!.alias, ...(g!.name ? { groupName: g!.name } : {}) } : {}) });
      if (p.eventId) await this.put(`evt:${p.eventId}`, { seq, at: Date.now() });
      const pres = await this.presence(b.pub);
      await this.markToldOffline(b.pub, pres); // the bot renders this as "your agent is away" → a "back" push is then worth sending
      // v0.9.3: a group set to quiet gets no "handed to your agent" receipt. Answered here so the bot
      // needs no second call, and stored on the relay so it survives the bot's restarts.
      const quiet = p.groupId ? ((await this.get<boolean>(`quiet:${p.groupId}`)) ?? false) : false;
      // v0.9.4: `context` says whether this group has opted into sending its recent chat along with an
      // instruction. The bot caches the answer and attaches the transcript from the NEXT /a onwards —
      // so a bot that has just restarted sends nothing until the relay has told it the group said yes.
      const context = p.groupId ? ((await this.get<boolean>(`ctx:${p.groupId}`)) ?? false) : false;
      return c.json({ ok: true, seq, presence: pres, quiet, context });
    });

    // v0.9.4: does this group send its recent chat with an instruction? Off unless the group turns it on,
    // because the words belong to everyone in the group, not just to whoever typed /a.
    // v0.9.7: turning this ON sends everyone else's words in the group to somebody's computer.
    // That is the wirer's call, not any passer-by's — announcing it afterwards is not consent.
    // Turning it OFF is protective, so it stays open to anyone in the group.
    app.post("/bridge/context", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { groupId?: string; on?: boolean; userId?: string };
      if (!p.groupId) return c.json({ error: "groupId required" }, 400);
      if (p.on === false) { await this.del(`ctx:${p.groupId}`); await this.del(`glog:${p.groupId}`); return c.json({ ok: true, context: false }); }
      const m = await this.get<Mirror>(`mirror:${p.groupId}`);
      if (!m) return c.json({ error: "that group is not connected to any agent yet" }, 404);
      if (!p.userId || p.userId !== m.by) {
        const who = m.by ? await this.bindingByUser(m.by) : undefined;
        return c.json({ error: "only the person who connected this group can turn it on", by: who?.name ?? null }, 403);
      }
      await this.put(`ctx:${p.groupId}`, true);
      return c.json({ ok: true, context: true });
    });

    // v0.9.4: a question from someone in the group who has no agent of their own. It goes to the agent
    // that connected the group, marked as coming from a group member — data with no authority, never an
    // instruction. Only the principal's own words carry weight, and this is not them.
    app.post("/bridge/guest-ask", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { groupId?: string; text?: string; displayName?: string; groupName?: string; eventId?: string };
      if (!p.groupId || !p.text) return c.json({ error: "groupId and text required" }, 400);
      const m = await this.get<Mirror>(`mirror:${p.groupId}`);
      if (!m) return c.json({ error: "that group is not connected to any agent yet" }, 404);
      const host = m.by ? await this.bindingByUser(m.by) : undefined;
      if (!host) return c.json({ error: "the agent that connected this group is no longer bound" }, 404);
      if (p.eventId) { const prev = await this.get<{ seq: number }>(`evt:${p.eventId}`); if (prev) return c.json({ ok: true, seq: prev.seq, duplicate: true, to: host.name }); }
      // A stranger in a group must not be able to fill someone's inbox: 10 an hour for the whole group.
      const hk = `q:guest:${p.groupId}:${new Date().toISOString().slice(0, 13)}`;
      const used = (await this.get<number>(hk)) ?? 0;
      if (used >= 10) return c.json({ error: "too many guest questions from this group this hour" }, 429);
      await this.put(hk, used + 1);
      const who = (p.displayName ?? "").slice(0, 40) || "群裡的某人"; // i18n-ok: text for the agent
      // v0.9.7: the provenance goes in the TEXT as well as the structured field. A client older than
      // 0.9.4 does not know `guest`, and an item with no signature sorts into its "claiming to come
      // from your principal" block — which labels a stranger's question in the one wrong direction.
      // The prefix means every client, at every version, sees who this actually came from.
      const seq = await this.appendInbox(host.pub, {
        at: new Date().toISOString(), via: `${this.chanFor(p.groupId).name}-group-guest`, group: p.groupId, lang: isLang(m.lang) ? m.lang : LEGACY_LANG,
        guest: { name: who, group: p.groupId, ...(p.groupName ? { groupName: p.groupName } : {}) },
        text: `【群成員提問·不是你的老闆·無授權效力】${who}${p.groupName ? `(${p.groupName})` : ""}：${p.text.slice(0, 2000)}`, // i18n-ok: text for the agent; the provenance marker
      });
      if (p.eventId) await this.put(`evt:${p.eventId}`, { seq, at: Date.now() });
      return c.json({ ok: true, seq, to: host.name, presence: await this.presence(host.pub) });
    });

    // v0.9.3: "/quiet" in a LINE group — stop acknowledging every /a there. The instruction still
    // reaches the agent; only the bot's receipt goes away, so a family group is not narrated by a
    // robot every time someone speaks to their own agent.
    app.post("/bridge/quiet", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { groupId?: string; on?: boolean };
      if (!p.groupId) return c.json({ error: "groupId required" }, 400);
      if (p.on === false) await this.del(`quiet:${p.groupId}`);
      else await this.put(`quiet:${p.groupId}`, true);
      return c.json({ ok: true, quiet: p.on !== false });
    });

    // /join <code | invite link> typed to the bot by a bound principal → their agent's inbox, flagged `invite`.
    app.post("/bridge/join", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; text?: string; groupId?: string };
      if (!p.userId || !p.text) return c.json({ error: "userId and text required" }, 400);
      const b = await this.bindingByUser(p.userId);
      if (!b) return c.json({ error: "not bound" }, 404);
      const t = p.text.trim();
      let invite = /https?:\/\/[^\s"'<>]+\/j\/[0-9a-f]{12}[^\s"'<>]*/.exec(t)?.[0];
      let name = ""; let from = "";
      // v0.7.5: "group:<id>" — the principal tapped 接上 in a group that is already wired: reuse the
      // invite the room's opener posted there, so nobody has to find or retype a code.
      if (!invite && /^group:/.test(t)) {
        // review R10: only from inside that very group (the bot passes the group the tap came from).
        const gid = t.slice(6);
        if (!p.groupId || p.groupId !== gid) return c.json({ error: "join-by-group only works from inside that group" }, 403);
        const m = await this.get<Mirror>(`mirror:${gid}`);
        if (!m) return c.json({ error: "that group is not wired" }, 404);
        let best: StoredInvite | undefined;
        for (const [, rec] of await this.ctx.storage.list<StoredInvite>({ prefix: "inv:" })) {
          if (rec.room !== m.room || Date.now() - rec.at > INVITE_TTL_MS) continue;
          if (best && rec.at <= best.at) continue;
          // codex 6.0: only trust a code minted by a room MEMBER. /p/invite does not prove secret-possession, so any
          // signer could otherwise plant an inv: for this room-id and have join-by-tap serve their poisoned invite
          // (wrong secret, or an attacker-controlled relay). The legit wiring's minter is a member (checked at /p/room-created).
          if (!rec.fromPub || !(await this.inRoom(rec.fromPub, m.room))) continue;
          best = rec;
        }
        if (!best) return c.json({ error: "unknown or expired invite code" }, 404);
        invite = best.invite; name = best.name; from = best.fromName;
      }
      if (!invite) {
        const code = t.toUpperCase().replace(/\s+/g, "").replace(/^\/?JOIN/, "");
        const norm = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code) ? (code.includes("-") ? code : `${code.slice(0, 4)}-${code.slice(4)}`) : "";
        if (await this.codeBlocked("join", p.userId)) return c.json({ error: BridgeDO.TOO_MANY_CODES }, 429);
        const rec = norm ? await this.get<StoredInvite>(`inv:${norm}`) : undefined;
        if (!rec || Date.now() - rec.at > INVITE_TTL_MS) { await this.codeMiss("join", p.userId); return c.json({ error: "unknown or expired invite code" }, 404); }
        invite = rec.invite; name = rec.name; from = rec.fromName;
      }
      if (!/^[0-9a-f]{16,}$/.test((invite.split("#")[1] ?? "").split(".")[0])) return c.json({ error: "that link is missing its secret (the part after #) — forward the whole link" }, 400);
      const room = /\/j\/([0-9a-f]{12})/.exec(invite)![1];
      if (p.groupId) await this.noteGroup(b.pub, p.groupId);
      const seq = await this.appendInbox(b.pub, {
        at: new Date().toISOString(), via: `${this.chanFor(p.userId).name}${p.groupId ? "-group" : ""}`, invite, lang: await this.userLang(p.userId),
        text: `JOIN can2cup room ${room}${name ? ` "${name}"` : ""}${from ? ` (invited by ${from})` : ""} — your principal accepted this invite on ${this.chanFor(p.userId).label}.`,
      });
      const presJ = await this.presence(b.pub);
      await this.markToldOffline(b.pub, presJ);
      return c.json({ ok: true, seq, room, name, from, presence: presJ });
    });

    // v0.5.1: "/room [名稱]" typed in a LINE group — ask the typer's agent to open a room for that
    // group. The bridge cannot create the room itself (a local agent's keys and mandate live on its
    // own machine), so this only queues the request; the agent answers on /p/room-created.
    app.post("/bridge/room-request", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; groupId?: string; groupName?: string; name?: string; displayName?: string; eventId?: string };
      if (!p.userId || !p.groupId) return c.json({ error: "userId and groupId required" }, 400);
      const b = await this.bindingByUser(p.userId);
      if (!b) return c.json({ error: "not bound" }, 404);
      if (p.eventId) { const prev = await this.get<{ seq: number; at: number }>(`evt:${p.eventId}`); if (prev) return c.json({ ok: true, seq: prev.seq, duplicate: true, presence: await this.presence(b.pub) }); } // review R25
      // review R6: a /room request already pending for this group within the hour is the same request — do not queue a twin.
      const pendReq = await this.get<{ at: number }>(`roomreq:${b.pub}:${p.groupId}`);
      if (pendReq && Date.now() - pendReq.at < ROOMREQ_TTL_MS) return c.json({ ok: true, seq: 0, duplicate: true, presence: await this.presence(b.pub) });
      // v0.9.9 T4: checked BEFORE queueing, so the agent never opens a room it will not be allowed to wire.
      const held = await this.wiredByOther(p.groupId, p.userId);
      if (held) return c.json({ error: "this group is already connected by someone else; ask them to /unmirror first", by: held.by }, 403);
      const g = await this.noteGroup(b.pub, p.groupId, p.groupName);
      await this.put(`lastGroup:${b.pub}`, p.groupId);
      const name = (p.name ?? "").slice(0, 80);
      const by = (p.displayName ?? "").slice(0, 40);
      const seq = await this.appendInbox(b.pub, {
        at: new Date().toISOString(), via: `${this.chanFor(p.groupId).name}-group`, group: p.groupId, groupAlias: g.alias, lang: await this.userLang(p.userId), ...(g.name ? { groupName: g.name } : {}),
        roomRequest: { ...(name ? { name } : {}), group: p.groupId },
        text: `OPEN A CAN2CUP ROOM${name ? ` "${name}"` : ""} for ${this.chanFor(p.groupId).vocab.groupEn} ${g.name ? `「${g.name}」` : g.alias} — your principal typed /room there. A current client handles this automatically and posts the invite back into the group; if you are reading this as plain text, create the room yourself, run can2cup invite <room> --line, and hand the code to the group.`,
      });
      await this.put(`roomreq:${b.pub}:${p.groupId}`, { name, by, at: Date.now() });
      if (p.eventId) await this.put(`evt:${p.eventId}`, { seq, at: Date.now() });
      const pres = await this.presence(b.pub);
      await this.markToldOffline(b.pub, pres);
      return c.json({ ok: true, seq, presence: pres });
    });

    app.get("/bridge/show/:userId/:room", async (c) => {
      const b = await this.bindingByUser(c.req.param("userId"));
      if (!b) return c.json({ error: "not bound" }, 404);
      const room = c.req.param("room");
      const known = await this.get<RoomKnown>(`room:${room}`);
      if (!known || !known.participants[b.pub]) return c.json({ error: "you are not in that room" }, 404);
      const n = Math.min(50, Number(c.req.query("n") ?? 15) || 15);
      const recent = ((await this.get<Envelope[]>(`recent:${room}`)) ?? []).slice(-n);
      const L = await this.userLang(b.userId);
      const names = { ...known.participants, [b.pub]: tr(L, "{name}（你的）", { name: known.participants[b.pub] }) };
      return c.json({ room, name: known.name, state: known.state, lastSeq: known.lastSeq, text: recent.map((e) => this.fmtEnvelope(e, names, L)).join("\n———\n") });
    });

    app.post("/bridge/mirror", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; groupId?: string; room?: string; all?: boolean };
      if (!p.userId || !p.groupId) return c.json({ error: "userId and groupId required" }, 400);
      const b = await this.bindingByUser(p.userId);
      if (!b) return c.json({ error: "not bound" }, 404);
      const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${b.pub}`)) ?? {};
      // default: the newest open room this user is in
      const room = p.room ?? Object.entries(rooms).filter(([, r]) => r.state === "open").sort((x, y) => y[1].lastSeq - x[1].lastSeq)[0]?.[0];
      if (!room || !rooms[room] || !(await this.inRoom(b.pub, room))) return c.json({ error: "no such room for you" }, 404);
      const held = await this.wiredByOther(p.groupId, p.userId); // v0.9.9 T4
      if (held) return c.json({ error: "this group is already connected by someone else; ask them to /unmirror first", by: held.by }, 403);
      const m: Mirror = { room, all: !!p.all, by: p.userId, at: new Date().toISOString() };
      await this.setMirror(p.groupId, m);
      return c.json({ ok: true, room, name: rooms[room].name, all: m.all });
    });

    app.delete("/bridge/mirror/:groupId", async (c) => {
      const gid = c.req.param("groupId");
      const m = await this.get<Mirror>(`mirror:${gid}`);
      if (m) {
        await this.del(`mirror:${gid}`);
        const list = ((await this.get<string[]>(`mirrors:${m.room}`)) ?? []).filter((g) => g !== gid);
        await this.put(`mirrors:${m.room}`, list);
        if (!list.length) await this.keepAlive(m.room, false); // no group points at it any more
      }
      return c.json({ ok: true, was: m?.room });
    });

    // v0.9.5: the way out from the phone. The bot does the confirming; by the time it calls this,
    // the human has typed the word twice.
    app.post("/bridge/erase", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; scope?: string };
      if (!p.userId) return c.json({ error: "userId required" }, 400);
      const b = await this.bindingByUser(p.userId);
      if (!b) return c.json({ error: "not bound" }, 404);
      const scope = p.scope === "all" ? "all" : "binding";
      const deleted = await this.erase(b.pub, scope);
      return c.json({ ok: true, scope, pub: b.pub, name: b.name, deleted });
    });

    app.get("/bridge/quota", async (c) => {
      // v0.15.1: with ?user=<id>, that person's channel — its own count, its allowance (null = the platform has none)
      // and the abuse gates that apply to everyone; without, the legacy all-channels view.
      const global = await this.pushCount();
      const user = c.req.query("user");
      if (!user) return c.json(global);
      const ch = this.chanFor(user);
      const cn = await this.channelCount(ch);
      return c.json({ ...global, channel: ch.name, n: cn.n, budget: ch.monthlyBudget ?? null, userBudget: Math.max(1, Number(this.env.PUSH_USER_BUDGET ?? 60) || 60), roomHourly: ROOM_HOURLY_PUSHES });
    });
    // v0.9.13: the debug routes exist for the smoke suite. They answer only to the bridge key, but one of them
    // (`sweep {all:true}`) can expire every idle binding on the relay in a single call — that is not something a
    // production relay should expose to a leaked bot key. Off unless DEBUG_ROUTES=1 (set in .dev.vars, never in wrangler.toml).
    app.use("/bridge/debug/*", async (c, next) => { if (this.env.DEBUG_ROUTES !== "1") return c.json({ error: "not found" }, 404); await next(); });
    app.get("/bridge/debug/pushes", async (c) => c.json({ pushes: (await this.get<Pushed[]>("pushes")) ?? [] }));
    // v0.11.0 (smoke, second opinion #1 and #3): a hostile relay rewriting a signed item's stored text, and a relay
    // "forgetting" a signed pause. Both must be harmless to a correct client; these let the suite prove it.
    app.post("/bridge/debug/inbox-tamper", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; seq?: number; text?: string; at?: string };
      const b = p.userId ? await this.bindingByUser(p.userId) : undefined;
      if (!b || (typeof p.text !== "string" && typeof p.at !== "string")) return c.json({ error: "userId and text (or at) required" }, 400);
      const items = (await this.get<InboxItem[]>(`inbox:${b.pub}`)) ?? [];
      const it = typeof p.seq === "number" ? items.find((i) => i.seq === p.seq) : items[items.length - 1];
      if (!it) return c.json({ error: "no such item" }, 404);
      if (typeof p.text === "string") it.text = p.text;
      if (typeof p.at === "string") it.at = p.at; // v0.11.1 (third opinion #2): the relay's outer timestamp is the relay's to lie about
      await this.put(`inbox:${b.pub}`, items);
      return c.json({ ok: true, seq: it.seq });
    });
    // v0.11.1 (smoke, third opinion #6): a hosted agent + bearer token without the OAuth dance, so the suite can drive /mcp.
    app.post("/bridge/debug/hosted", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string };
      if (!p.userId) return c.json({ error: "userId required" }, 400);
      const d = this.mcpDeps();
      const b = (await this.bindingByUser(p.userId)) ?? (await createHostedAgent(d, p.userId));
      const access = randomHex(32);
      await d.put(`oauth:tok:${access}`, { pub: b.pub, clientId: "smoke", at: Date.now() });
      return c.json({ ok: true, pub: b.pub, token: access });
    });
    // v0.11.2 (smoke, fourth opinion #9): there is no product path that widens a hosted mandate; this lets the suite
    // prove that even a widened one unlocks no commitment on the hosted surface.
    app.post("/bridge/debug/inbox-fail", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; n?: number; status?: number };
      const b = p.userId ? await this.bindingByUser(p.userId) : undefined;
      if (!b) return c.json({ error: "userId required" }, 400);
      const status = Number(p.status) >= 400 && Number(p.status) <= 599 ? Number(p.status) : 503;
      await this.put(`debug:inboxfail:${b.pub}`, { n: Math.max(0, Number(p.n ?? 1) || 0), status });
      return c.json({ ok: true });
    });
    // 2026-09-14 (write budget): every put / delete / setAlarm this DO made since the last reset. `pub` narrows `forPub`
    // and `keys` to that agent's keys and adds how many /p/inbox requests it sent (429s included). setAlarm is split
    // into "(request)" and "(alarm)" by where it was called from.
    app.get("/bridge/debug/writes", async (c) => {
      const pub = c.req.query("pub") ?? "";
      const keys: Record<string, number> = {};
      let forPub = 0;
      for (const [k, n] of this.debugWrites.keys) if (!pub || k.includes(pub)) { keys[k] = n; if (pub && !k.startsWith("setAlarm")) forPub += n; }
      const w = this.debugWrites;
      const out = {
        put: w.put, delete: w.delete, setAlarm: w.setAlarm, total: w.put + w.delete + w.setAlarm,
        setAlarmRequest: w.keys.get("setAlarm(request)") ?? 0, setAlarmAlarm: w.keys.get("setAlarm(alarm)") ?? 0,
        forPub, keys, inboxCalls: pub ? this.debugInboxCalls.get(pub) ?? 0 : [...this.debugInboxCalls.values()].reduce((a, b) => a + b, 0),
      };
      if (c.req.query("reset") === "1") { this.debugWrites = { put: 0, delete: 0, setAlarm: 0, keys: new Map() }; this.debugInboxCalls.clear(); }
      return c.json(out);
    });
    // The /p/inbox token bucket: { burst, refillMs } relay-wide (stored), or for one `pub` (memory); no burst clears.
    // Clearing a key's override also refills its bucket, so a test starts from a full burst.
    app.post("/bridge/debug/inbox-bucket", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { pub?: string; burst?: number; refillMs?: number };
      const spec = Number(p.burst) > 0 && Number(p.refillMs) > 0 ? { burst: Number(p.burst), refillMs: Number(p.refillMs) } : null;
      if (p.pub) { if (spec) this.debugBucketFor.set(p.pub, spec); else this.debugBucketFor.delete(p.pub); this.buckets.delete(p.pub); }
      else { this.debugBucket = spec; if (spec) await this.put("debug:bucket", spec); else await this.del("debug:bucket"); this.buckets.clear(); }
      return c.json({ ok: true, ...(p.pub ? { pub: p.pub } : {}), spec: p.pub ? this.bucketSpec(p.pub) : this.debugBucket ?? INBOX_BUCKET });
    });
    // Per-agent presence timers (seconds), so the suite can watch stale detection without the 3-minute production clock
    // and without shortening it for every other agent in the run. null / 0 clears.
    app.post("/bridge/debug/presence-timers", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { pub?: string; staleSec?: number | null; seenPersistSec?: number | null };
      if (!p.pub) return c.json({ error: "pub required" }, 400);
      const staleMs = Number(p.staleSec) > 0 ? Number(p.staleSec) * 1000 : undefined;
      const persistMs = Number(p.seenPersistSec) > 0 ? Number(p.seenPersistSec) * 1000 : undefined;
      if (!staleMs && !persistMs) this.debugTimers.delete(p.pub); else this.debugTimers.set(p.pub, { staleMs, persistMs });
      return c.json({ ok: true, staleMs: this.staleMs(p.pub), seenPersistMs: this.seenPersistMs(p.pub) });
    });
    app.post("/bridge/debug/hmandate", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { pub?: string; mandate?: Record<string, unknown> | null };
      if (!p.pub) return c.json({ error: "pub required" }, 400);
      if (p.mandate === null) await this.del(`hmandate:${p.pub}`); else await this.put(`hmandate:${p.pub}`, p.mandate ?? {});
      return c.json({ ok: true });
    });
    app.post("/bridge/debug/forget-spause", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const b = p.userId ? await this.bindingByUser(p.userId) : undefined;
      if (!b) return c.json({ error: "userId required" }, 400);
      await this.del(`spause:${b.pub}`);
      return c.json({ ok: true });
    });
    // v0.9.12 (smoke): run one idle sweep now, narrowed to one agent or one group so nothing else in the run is touched.
    app.post("/bridge/debug/sweep", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { pub?: string; gid?: string; all?: boolean };
      if (!p.pub && !p.gid && p.all !== true) return c.json({ error: "pub or gid required (all: true sweeps everything)" }, 400);
      return c.json(await this.sweepIdle({ pub: p.pub || undefined, gid: p.gid || undefined }));
    });
    // v0.9.12: /keep from LINE — show, set 7..365, or forever.
    app.post("/bridge/keep", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { userId?: string; days?: unknown; forever?: unknown };
      if (!p.userId) return c.json({ error: "userId required" }, 400);
      const b = await this.bindingByUser(p.userId);
      if (!b) return c.json({ error: "not bound" }, 404);
      const r = await this.setIdle(b.pub, p, "line");
      if ("error" in r) return c.json(r, 400);
      const st = await this.idleOf(b.pub, b);
      return c.json({ ok: true, name: b.name, ...st });
    });
    // v0.8.1 support view: the delivery ledger of one principal's inbox + when this DO's alarm is due.
    app.get("/bridge/debug/inbox/:userId", async (c) => { const b = await this.bindingByUser(c.req.param("userId")); if (!b) return c.json({ error: "not bound" }, 404); return c.json({ pub: b.pub, alarmAt: await this.ctx.storage.getAlarm(), leaseMs: this.leaseMs(), items: ((await this.get<InboxItem[]>(`inbox:${b.pub}`)) ?? []).map((i) => ({ seq: i.seq, at: i.at, lang: i.lang, bound: i.bound, deliveredAt: i.deliveredAt, ackedAt: i.ackedAt, remindedAt: i.remindedAt, via: i.via, text: i.text.slice(0, 40) })) }); });
    app.get("/bridge/report/:id", async (c) => { const r = await this.get<unknown>(`report:${c.req.param("id")}`); return r ? c.json(r) : c.json({ error: "no such report" }, 404); });
    app.get("/bridge/reports", async (c) => { const out: unknown[] = []; for (const [, v] of await this.ctx.storage.list<{ id: string; at: string; agent: string; note: string; version: string }>({ prefix: "report:" })) out.push({ id: v.id, at: v.at, agent: v.agent, version: v.version, note: v.note.slice(0, 120) }); return c.json({ reports: out.slice(-100) }); });

    // ---- principal-signed (v0.3) -------------------------------------------
    // The body IS the authentication: a SignedPrincipalMsg addressed to one agent, signed by the
    // key that agent registered. No bridge key, no LINE, no operator in the path.
    const principalMsg = async (c: { req: { json: () => Promise<unknown> } }): Promise<SignedPrincipalMsg | Response> => {
      const m = (await c.req.json().catch(() => null)) as SignedPrincipalMsg | null;
      if (!m || typeof m !== "object" || !/^[0-9a-f]{64}$/.test(m.agent ?? "")) return Response.json({ error: "signed principal message required" }, { status: 400 });
      const expected = await this.get<string>(`principal:${m.agent}`);
      if (!expected) return Response.json({ error: "that agent has not registered a principal key" }, { status: 404 });
      const v = verifyPrincipal(m, expected, m.agent);
      if (!v.ok) return Response.json({ error: `principal signature: ${v.error}` }, { status: 401 });
      return m;
    };

    app.post("/principal/say", async (c) => {
      const m = await principalMsg(c);
      if (m instanceof Response) return m;
      if (m.kind !== "say") return c.json({ error: "kind must be say" }, 400);
      const seq = await this.appendInbox(m.agent, { at: m.at, text: String(m.text ?? "").slice(0, 4000), signed: m, via: "principal-key" });
      return c.json({ ok: true, seq });
    });

    app.post("/principal/pause", async (c) => {
      const m = await principalMsg(c);
      if (m instanceof Response) return m;
      if (m.kind !== "pause") return c.json({ error: "kind must be pause" }, 400);
      const cur = await this.get<SignedPrincipalMsg>(`spause:${m.agent}`);
      if (cur && Date.parse(cur.at) >= Date.parse(m.at)) return c.json({ ok: false, error: "a newer signed pause statement already exists", current: cur.paused }, 409);
      await this.put(`spause:${m.agent}`, m);
      return c.json({ ok: true, paused: m.paused });
    });

    // ---- internal: RoomDO tells us about every stored envelope --------------
    app.post("/internal/event", async (c) => {
      const ev = (await c.req.json()) as RoomEvent;
      const names: Record<string, string> = {};
      for (const [pk, p] of Object.entries(ev.participants)) names[pk] = p.name || short(pk);
      const known: RoomKnown = { name: ev.name, state: ev.state, lastSeq: ev.envelope.seq, participants: names };
      await this.put(`room:${ev.room}`, known);
      const recent = (await this.get<Envelope[]>(`recent:${ev.room}`)) ?? [];
      recent.push(ev.envelope);
      await this.put(`recent:${ev.room}`, recent.slice(-50));
      for (const pk of Object.keys(names)) {
        const rooms = (await this.get<Record<string, RoomKnown>>(`rooms:${pk}`)) ?? {};
        rooms[ev.room] = known;
        await this.put(`rooms:${pk}`, rooms);
      }
      const e = ev.envelope;
      // 1:1 decision-point pushes to every bound participant except the sender
      if (DECISION_TYPES.has(e.type)) {
        for (const pk of Object.keys(names)) {
          if (pk === e.from) continue;
          const b = await this.bindingByPub(pk);
          if (!b) continue;
          const L = await this.placeLang(b.userId);
          const quick: Quick[] | undefined = e.type === "escalate" || e.type === "grant" || e.type === "proposal" || e.type === "question"
            ? [{ label: tr(L, "同意"), data: `parley:ok:${ev.room}:${e.seq}` }, { label: tr(L, "拒絕"), data: `parley:no:${ev.room}:${e.seq}` }, { label: tr(L, "回話"), data: "parley:fill", fill: "/a " }, { label: tr(L, "看全文"), data: `parley:show:${ev.room}` }]
            : undefined;
          const pres = await this.presence(pk);
          await this.markToldOffline(pk, pres); // the warning below is the principal hearing it is away
          const note = this.offlineNote(pres, L);
          const bub = this.fmtBubble(e, names, L);
          // v0.9.10 B2: if this principal's agent is gated (mandate widened, gate on), the 同意 button below is
          // advice, not a commitment — say so on the bubble itself, where the button is.
          const tier = quick ? await this.get<{ widened: boolean; unsigned_may_commit: boolean }>(`tier:${pk}`) : undefined;
          const gated = tier?.widened && !tier.unsigned_may_commit ? tr(L, "\n🔏 你的規則放寬過：同意鍵只是告訴 agent 你的意思，真正送出前要在電腦上 can2cup approve 簽核。") : "";
          await this.push(b.userId, `room:${e.type}`, `【${ev.name || ev.room}】\n${bub.text}${note ? `\n⚠️ ${note.replace(/^[（(]|[）)]$/g, "")}` : ""}${gated}`, quick, ev.room, undefined, bub.sender);
        }
      }
      // group mirrors
      const groups = (await this.get<string[]>(`mirrors:${ev.room}`)) ?? [];
      for (const gid of groups) {
        const m = await this.get<Mirror>(`mirror:${gid}`);
        if (!m || m.room !== ev.room) continue; // review R3: the group was re-pointed elsewhere
        if (e.type === "system" && !m.all) continue;
        if (!m.all && !DECISION_TYPES.has(e.type)) continue;
        const bub = this.fmtBubble(e, names, isLang(m.lang) ? m.lang : LEGACY_LANG);
        await this.push(gid, `mirror:${e.type}`, bub.text, undefined, ev.room, undefined, bub.sender);
      }
      return c.json({ ok: true });
    });
  }
}
