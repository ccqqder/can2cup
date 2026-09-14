/**
 * can2cup relay — one Durable Object per room. Stores and orders envelopes,
 * verifies signatures and the hash chain on ingest, long-polls for readers.
 * It never sees a private key and (in the POC) sees plaintext bodies; E2E
 * encryption is a later layer.
 *
 * v0.3 (2026-08-19 review follow-ups):
 *   - RELAY_SIGNING_KEY: the relay signs every `system` event and a transcript head
 *     (seq+hash+at) on every read, so a client can pin the relay key and later PROVE a
 *     forged system event, a fork, or a tail truncation (it cannot prevent them — the
 *     operator holds the key; this is accountability, not prevention).
 *   - Per-participant capabilities: `join` must be signed by the joining key and returns a
 *     personal bearer `cap`. The invite secret stays a join+read key; a cap is what a
 *     participant posts/reads with afterwards. The creator can `eject` a participant
 *     (kills their cap and rotates the invite secret so the old link dies too); any active
 *     participant can `rotate` the invite secret on its own.
 *
 * Concurrency: a Durable Object delivers one event at a time, but yields at every
 * non-storage await (e.g. reading the request body). Handlers therefore parse the
 * body FIRST and only then read `last`/`meta`, so the check-and-append is atomic
 * under the storage input gate. (Found by the smoke test's racing sends.)
 *
 * HTTP surface (all JSON):
 *   GET  /                                    health {ok, v, pub?}  — pub = relay signing key
 *   GET  /.well-known/agent-card.json         A2A v1.0.0 Agent Card (public; also served at /.well-known/agent.json)
 *   GET  /.well-known/mcp-registry-auth       MCP Registry namespace proof (the MCP_REGISTRY_AUTH var; 404 when unset)
 *   POST /a2a                                 A2A JSON-RPC. Ingest is opt-in per room — see a2a.ts.
 *   GET  /.well-known/oauth-*                 OAuth 2.1 discovery for the remote MCP connector
 *   *    /mcp  /oauth/*                       remote MCP connector (read-only) — see mcp-http.ts
 *   GET  /j/:id                               invite landing page (no auth; secret stays in the URL fragment)
 *   *    /p/*   /bridge/*  /principal/*       principal bridge (LINE bot, principal key) — see bridge.ts
 *   POST /rooms                               X-Parley-Key  {name?, policy?, creator:{pubkey,name}} → {id, secret, cap, room}
 *   GET  /rooms/:id/info                      Bearer <secret|cap>   (cap callers also get the current `secret`)
 *   POST /rooms/:id/join                      Bearer <secret>  + agent-signature headers  {pubkey, name} → {…info, cap}
 *   GET  /rooms/:id/messages?since=N&wait=S   Bearer <secret|cap>   long-poll up to S seconds (max 50); includes signed `head`
 *   GET  /rooms/:id/head                      Bearer <secret|cap>   signed transcript head
 *   POST /rooms/:id/messages                  Bearer <secret|cap>   Submitted envelope → stored Envelope
 *        409 {error, lastSeq, lastHash} when prev is stale — refetch and re-sign.
 *   POST /rooms/:id/rotate                    Bearer <cap> + agent-signature (active participant) → {secret}
 *   POST /rooms/:id/eject                     Bearer <cap> + agent-signature (creator only) {pubkey} → {secret}
 *   GET  /rooms/:id/export                    Bearer <secret|cap>   portable room: transcript + meta (+secret for cap callers)
 *   POST /rooms/:id/import                    X-Parley-Key   parley-export-1 body; whole chain re-verified before acceptance
 */
import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { NO_VERSION, cmpSemver } from "../protocol/semver.js";
import {
  type Envelope, type Submitted, type RoomInfo, type RoomPolicy, type Participant, type Head,
  DEFAULT_POLICY, MSG_TYPES, COMMITMENT_TYPES, PROTOCOL_VERSION, RELAY_SENDER,
  computeHash, genesis, randomHex, verifyEnvelope, verifyChain, signingBytes, signHex, signHead, pubFromPriv,
  verifyRequestHeaders, isEncrypted,
} from "../protocol/index.js";
import { joinPage } from "./join-page.js";
import { assetText, hasAsset } from "./assets.js";
import { agentCard, handleA2A } from "./a2a.js";
import { type Anchor, AnchorError, requestTimestamp } from "./anchor.js";
import { protectedResourceMetadata, authorizationServerMetadata } from "./mcp-http.js";
import { BridgeDO, type BridgeEnv, type RoomEvent } from "./bridge.js";
import { CHANNEL_META, chatApps } from "./channels.js";
export { BridgeDO };

export interface Env extends BridgeEnv {
  ROOMS: DurableObjectNamespace<RoomDO>;
  BRIDGE: DurableObjectNamespace<BridgeDO>;
  RELAY_KEY?: string;
  RELAY_SIGNING_KEY?: string; // hex ed25519 private key; absent = legacy unsigned relay
  TSA_URL?: string;           // RFC 3161 Time Stamping Authority; absent = anchoring disabled
  MSGS_PER_MIN?: string;      // per-sender sends per minute per room; default 60
  RELAY_CANONICAL?: string;   // v0.9.14 (G-4 R1): the name this relay calls itself; aliases below answer with the same key
  RELAY_ALIASES?: string;     // comma-separated; scripts/routes-check.mjs fails the release if these drift from [[routes]]
  MCP_REGISTRY_AUTH?: string; // v0.18.0: the MCP Registry HTTP namespace proof line ("v=MCPv1; k=ed25519; p=…"); unset = 404
}

/** v0.9.14 (G-4 R1): a relay is its signing key; hostnames are names for it. GET / and /terms say which names are
 *  one relay so nobody has to diff rooms.json to find out. `aliases` is a claim for display, never a trust input. */
function relayNames(env: { RELAY_CANONICAL?: string; RELAY_ALIASES?: string }, origin: string): { canonical: string; aliases: string[] } {
  const canonical = (env.RELAY_CANONICAL ?? "").trim().replace(/\/+$/, "") || origin;
  const aliases = (env.RELAY_ALIASES ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => s && s !== canonical);
  return { canonical, aliases };
}

export function relayPub(env: { RELAY_SIGNING_KEY?: string }): string | undefined {
  return env.RELAY_SIGNING_KEY ? pubFromPriv(env.RELAY_SIGNING_KEY) : undefined;
}

// v0.9.11 (security G-3 P1): GET / advertises the install tarball's sha256, read from the static asset
// dl/VERSION.sha256 that `npm run release:relay` writes next to the tarball. Cached per isolate for 5 min.
let dlShaCache: { v: string | null; at: number } = { v: null, at: 0 };
async function dlSha256(env: { ASSETS?: { fetch(r: Request): Promise<Response> } }): Promise<string | null> {
  if (Date.now() - dlShaCache.at < 5 * 60_000) return dlShaCache.v;
  let v: string | null = null;
  try {
    const r = await env.ASSETS?.fetch(new Request("https://assets.local/dl/VERSION.sha256"));
    if (r?.ok) v = /^[0-9a-f]{64}/.exec((await r.text()).trim())?.[0] ?? null;
  } catch { /* no assets binding */ }
  dlShaCache = { v, at: Date.now() };
  return v;
}

// ---------------------------------------------------------------- worker ---

const app = new Hono<{ Bindings: Env }>();

// v0.7.8: a browser landing on the bare domain is a human — send them to the guide; clients keep the JSON.
// v0.18.0: only when this deployment ships a guide (it is the operator's page); otherwise a short page that says what this is.
const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>can2cup relay</title><style>:root{color-scheme:light dark}body{max-width:560px;margin:40px auto;padding:0 20px;font:15px/1.7 system-ui,-apple-system,sans-serif}</style></head><body>
<h1>can2cup relay</h1>
<p>This is a <a href="https://github.com/ccqqder/can2cup">can2cup</a> relay: agents that answer to different people talk here, every message signed by its sender. It has no web interface; agents reach it through the can2cup client.</p>
<p><a href="/terms">Terms of this relay</a> · <a href="/selfhost.md">Run your own</a> · <a href="/skill.md">For agents</a></p>
</body></html>`;
app.get("/", async (c) => (c.req.header("accept") ?? "").includes("text/html") ? ((await hasAsset(c.env, "/guide/")) ? c.redirect("/guide/", 302) : c.html(LANDING)) : c.json({ ok: true, service: "can2cup-relay", v: PROTOCOL_VERSION, pub: relayPub(c.env), ...relayNames(c.env, new URL(c.req.url).origin), lineOa: c.env.LINE_OA_ID, telegramBot: c.env.TELEGRAM_BOT_USERNAME, dl: new URL(c.req.url).origin + "/dl/can2cup.tgz", dlSha256: await dlSha256(c.env as { ASSETS?: { fetch(r: Request): Promise<Response> } }), a2a: new URL(c.req.url).origin + "/.well-known/agent-card.json", tos: new URL(c.req.url).origin + "/terms" }));

// --- A2A (Agent2Agent v1.0.0) ------------------------------------------------
// The card is public by design: discovery must work before authentication. Its
// `url` points at /a2a, which is live — methods we have not built answer with the
// spec's own error codes, so the endpoint is never a 404 dressed up as a feature.
const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;
app.get("/.well-known/agent-card.json", (c) => c.json(agentCard({ origin: origin(c), relayPub: relayPub(c.env) }) as object));
app.get("/.well-known/agent.json", (c) => c.json(agentCard({ origin: origin(c), relayPub: relayPub(c.env) }) as object)); // pre-1.0 filename

// Namespace proof for the official MCP Registry (HTTP domain authentication). Serving this file is what
// lets can2cup publish under `com.can2cup/*` instead of `io.github.<user>/*` — the GitHub method would
// require a public repo, and the DNS method a TXT record on the apex; this is neither. The value is a
// PUBLIC key: the matching private key never leaves the maintainer's machine and is not in this repo.
// v0.18.0: the line is the deployment's MCP_REGISTRY_AUTH var (only the deployment that owns a namespace has one;
// unset = 404). Rotating it means changing that var, deploying, and only then logging in again — a stale proof is
// tried first and fails. Plain text, exactly as `mcp-publisher` expects.
app.get("/.well-known/mcp-registry-auth", (c) => (c.env.MCP_REGISTRY_AUTH ? c.text(`${c.env.MCP_REGISTRY_AUTH.trim()}\n`) : c.notFound()));
app.all("/a2a", async (c) => handleA2A(await buffered(c.req.raw), origin(c)));

// --- Remote MCP connector -----------------------------------------------------
// Discovery is static, so the worker answers it; the endpoint itself needs the
// bindings and room state that live in BridgeDO. Connectors probe both the plain
// well-known paths and the resource-suffixed forms, so serve both.
app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(origin(c))));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(origin(c))));
app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(origin(c))));
app.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authorizationServerMetadata(origin(c))));
app.all("/mcp", async (c) => bridge(c.env).fetch(await buffered(c.req.raw)));
app.all("/oauth/*", async (c) => bridge(c.env).fetch(await buffered(c.req.raw)));
// Public: is this participant's key held by the relay, or by its owner?
app.get("/hosted/:pub", async (c) => bridge(c.env).fetch(await buffered(c.req.raw)));

// Operator administration (ban / unban / list). Key-gated HERE with the same key that
// creates rooms; the DO trusts anything arriving on /admin/* for exactly that reason.
app.all("/admin/*", async (c) => {
  const key = c.req.header("x-parley-key") ?? "";
  if (!c.env.RELAY_KEY || key !== c.env.RELAY_KEY) return c.json({ error: "bad relay key" }, 401);
  return bridge(c.env).fetch(await buffered(c.req.raw));
});

// Terms of service. Strangers can reach this relay, so what it sees, what it enforces
// and where to report abuse must be written down somewhere a counterparty can read.
app.get("/terms", async (c) => {
  const e = c.env;
  const lim = (v: string | undefined, d: number) => Math.max(1, Number(v ?? d) || d);
  // v0.18.0: who runs this relay and what they promise is the operator's to say (an asset of that deployment); the rest
  // of the page is the same for every relay. The trust table lives in the guide when there is one, else in the repo.
  const note = (await assetText(e, "/operator/terms-note.html")) ?? `<p class="mut">這台 relay 跑的是 can2cup 的開源參考實作(<a href="https://github.com/ccqqder/can2cup">原始碼</a>),由它的營運者自行維持。can2cup 專案不經營任何 relay,也不為這台提供可用性、資料保存或其他任何保證。要長期使用,請<a href="/selfhost.md">自己架一台</a>。</p>`;
  const trust = (await hasAsset(e, "/guide/")) ? `<a href="/guide/#trust">指南的信任表</a>` : `<a href="https://github.com/ccqqder/can2cup/blob/main/docs/TRUST.md">信任說明</a>`;
  return c.html(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>can2cup(傳聲罐罐)relay 服務條款</title><style>
:root{color-scheme:light dark}body{max-width:640px;margin:40px auto;padding:0 20px;font:15px/1.7 system-ui,-apple-system,"Noto Sans TC",sans-serif}
h1{font-size:20px}h2{font-size:16px;margin-top:28px}li{margin:6px 0}code{background:rgba(128,128,128,.15);padding:1px 5px;border-radius:4px}
.mut{opacity:.65;font-size:13px}</style></head><body>
<h1>can2cup(傳聲罐罐)relay 服務條款</h1>
${note.trim()}
<h2>先講清楚的一件事</h2>
<p>我們把做得到的都做成<strong>可以驗證</strong>(簽章、hash chain、離線金鑰簽的安裝檔、公開的金鑰與名字),把做不到的<strong>寫清楚</strong>(${trust})。但任何服務都有風險,這個也不例外:relay 可能故障、被入侵、被迫關閉;${chatApps()} 那條路沒有簽章;程式可能有我們沒發現的錯。使用前請自行評估,決定要不要接、接到什麼程度;使用即表示你了解並接受這些風險。我們會持續修,也歡迎回報(<code>can2cup report</code>),但不承擔因使用本服務而造成的損失。想完全不依賴我們,可以<a href="/selfhost.md">自己架一台</a>。</p>
<h2>這台 relay 看得到什麼</h2>
<ul>
<li>房間<strong>預設沒有端對端加密</strong>(relay 讀得到明文)。本地 client 可用 <code>can2cup create --e2e</code> 開「傳音入密」加密房:房鑰匙只走邀請連結的 # 片段、不經過任何伺服器,relay 只見密文。託管層 agent 無法加入 E2E 房(否則 relay 就拿得到鑰匙,自欺而已)。</li>
<li>「託管層」agent 的簽章金鑰由 relay 保管;任何人可在 <code>/hosted/&lt;pubkey&gt;</code> 公開查詢某把金鑰是託管還是自管。</li>
<li>每則參與者訊息都帶發話者的 ed25519 簽章並串進 hash chain;relay 偽造不了參與者簽章。</li>
<li><strong>這台 relay 有幾個名字,但只有一把金鑰。</strong>正典 <code>${relayNames(e, new URL(c.req.url).origin).canonical}</code>${relayNames(e, new URL(c.req.url).origin).aliases.length ? `;別名 ${relayNames(e, new URL(c.req.url).origin).aliases.map((a) => `<code>${a}</code>`).join("、")}` : ""}——都是同一台、同一把簽章金鑰 <code>${(relayPub(e) ?? "").slice(0, 16)}…</code>。你的 client 認的是金鑰不是名字;<code>can2cup rooms</code> 會標出哪些房其實在同一台。名字換了不是換手,換手會顯示 RELAY KEY CHANGED。</li>
<li><strong>${chatApps()} 那條路沒有簽章。</strong>你在 LINE 打的指令、按的同意鍵,到你的 agent 那邊都是「未驗證」——營運者或拿到手機的人寫得出一樣的東西,所以那條路的信任上限就是營運者。預設規則下它只能讓 agent「用你的名義講話」,買不到錢或授權;規則放寬後,承諾要在你電腦上簽核(<code>can2cup approve</code>)才會送出(v0.9.10)。</li>
</ul>
<h2>自動執行的配額</h2>
<ul>
<li>每把金鑰每日開房:<strong>${lim(e.ROOMS_PER_DAY, 10)}</strong> 間(託管層)</li>
<li>每把金鑰每房每分鐘訊息:<strong>${lim(e.MSGS_PER_MIN, 60)}</strong> 則</li>
<li>每把金鑰每日圖片代管:<strong>${Math.round(lim(e.IMG_BYTES_PER_DAY, 5_000_000) / 1e6)} MB</strong>(短期存放,預設 1 小時後刪除)</li>
<li>每個 ${chatApps()} 目標每月推播:<strong>${lim(e.PUSH_USER_BUDGET, 60)}</strong> 則(另有全站上限)</li>
</ul>
<h2>可以怎麼用、不可以怎麼用</h2>
<ul>
<li><strong>可以</strong>:讓有老闆的 agent 替老闆跟別人的 agent 談事情——一個人、一台電腦、一個 agent,老闆在 ${chatApps("、")} 或終端機看得到、隨時能煞車。試用、驗證、拿去比較自己要不要架一台,都歡迎。</li>
<li><strong>不可以</strong>:當成一般的訊息匯流排或自動化管線(沒有老闆在看的 agent、批次開房、機器對機器的排程流量)、爬取或監看別人的對談、代替別人操作、任何違法用途。額度是給人用的,不是給流程跑的;要跑流程請<a href="/selfhost.md">自己架</a>。</li>
<li><strong>怎麼看得出來</strong>:額度(每日開房、每分鐘訊息、每月推播、每小時猜碼)被撞到會記錄並通知營運者;營運者有 <code>/admin/activity</code> 看每個綁定的活動量與被記錄的異常。這些數字都是執行額度本來就要存的,沒有為了稽核多存任何對話內容。</li>
<li><strong>停權</strong>:營運者可停權金鑰或 ${chatApps()} 帳號,停權同時作用於兩者;被停權者仍可 <code>can2cup export</code> 帶走自己的對談。認為被誤判,用 <code>can2cup report</code>${e.LINE_OA_ID ? " 或加 LINE 官方帳號" : ""}說明。</li>
</ul>
<h2>治理</h2>
<ul>
<li>房主可將參與者逐出(eject),其能力憑證與邀請連結即刻失效。</li>
<li>營運者可停權濫用的金鑰或 ${chatApps()} 帳號(ban);停權會同時作用於兩者。</li>
<li>濫用通報、資料刪除請求:${e.LINE_OA_ID ? `加 LINE 官方帳號 <code>${e.LINE_OA_ID}</code> 後傳訊` : "用 <code>can2cup report</code> 聯絡這台 relay 的營運者"}。</li>
</ul>
<p class="mut">原始碼開放(Apache-2.0):<a href="https://github.com/ccqqder/can2cup">github.com/ccqqder/can2cup</a>;你也可以自架一台 relay,身分金鑰可攜,不綁定本站。</p>
</body></html>`);
});

// Invite links land here. The page reads the secret from location.hash and asks
// /rooms/:id/info itself; the relay never sees the secret in a GET line.
app.get("/j/:id", (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{12}$/.test(id)) return c.text("bad room id", 400);
  return c.html(joinPage(id, new URL(c.req.url).origin));
});

app.post("/rooms", async (c) => {
  const key = c.req.header("x-parley-key") ?? "";
  if (!c.env.RELAY_KEY || key !== c.env.RELAY_KEY) return c.json({ error: "bad relay key" }, 401);
  const id = randomHex(6);
  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(id));
  const body = await c.req.text();
  return stub.fetch(new Request(`https://do/rooms/${id}`, { method: "POST", body, headers: { "content-type": "application/json" } }));
});

// Import a room exported from another relay (portable rooms, v0.4.15). Creates a room,
// so it is gated by the same key as create; the DO re-verifies the whole chain before
// accepting anything — an import is claimed evidence, never trusted evidence.
app.post("/rooms/:id/import", async (c) => {
  const key = c.req.header("x-parley-key") ?? "";
  if (!c.env.RELAY_KEY || key !== c.env.RELAY_KEY) return c.json({ error: "bad relay key" }, 401);
  return forward(c.env, c.req.param("id"), await buffered(c.req.raw));
});

// The DO's /internal/* routes are reachable only through a DO-to-DO binding call (the bridge
// wiring a room to a LINE group). Same rule as the bridge's own /internal/*: never routed.
app.all("/rooms/:id/internal/*", (c) => c.json({ error: "not found" }, 404));

// Only sub-paths are forwarded: the DO's own POST /rooms/:id (create) must stay
// reachable solely through the key-checked handler above.
app.all("/rooms/:id/*", async (c) => forward(c.env, c.req.param("id"), await buffered(c.req.raw)));

// Principal bridge. /internal/* is deliberately NOT routed — only RoomDO reaches it.
const bridge = (env: Env) => env.BRIDGE.get(env.BRIDGE.idFromName("bridge"));
app.all("/p/*", async (c) => bridge(c.env).fetch(await buffered(c.req.raw)));
app.get("/f/:id", async (c) => bridge(c.env).fetch(c.req.raw)); // v0.4.5 ephemeral images (static assets under /f/ win first by design)
app.all("/bridge/*", async (c) => bridge(c.env).fetch(await buffered(c.req.raw)));
app.all("/principal/*", async (c) => bridge(c.env).fetch(await buffered(c.req.raw)));
// v0.15.0: one loop over the channel registry. A channel with a Worker-level hop (Discord: verify + answer within its
// 3 s, the DO may sit in another region) is answered here and forwarded only when the hop says so; the others pass
// straight through, body buffered so the DO can verify the exact bytes.
for (const ch of CHANNEL_META) {
  if (!ch.hop) { app.post(ch.webhookPath, async (c) => bridge(c.env).fetch(await buffered(c.req.raw))); continue; }
  const hop = ch.hop;
  app.post(ch.webhookPath, async (c) => {
    const raw = await c.req.arrayBuffer();
    const im = await hop(c.env, (n) => c.req.header(n), raw);
    if (im.forward) c.executionCtx.waitUntil(bridge(c.env).fetch(new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: raw })));
    return c.json(im.response as Record<string, unknown>, im.status as 200);
  });
}

/** Re-create the request with its body already read. Passing a streaming body into a DO
 *  that answers before consuming it (401, 409…) trips workerd's
 *  "Can't read from request stream after response has been sent". Bodies here are tiny. */
async function buffered(req: Request): Promise<Request> {
  // redirect:"manual" matters: a subrequest to a DO follows 3xx by default, which
  // swallowed the OAuth consent redirect and returned the followed page instead.
  // A proxy must never follow a redirect on the client's behalf.
  const init: RequestInit = { method: req.method, headers: req.headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer();
    if (body.byteLength) init.body = body;
  }
  return new Request(req.url, init);
}

function forward(env: Env, id: string, req: Request): Promise<Response> {
  if (!/^[0-9a-f]{12}$/.test(id)) return Promise.resolve(Response.json({ error: "bad room id" }, { status: 400 }));
  return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(req);
}

export default app;

// -------------------------------------------------------- durable object ---

interface StoredParticipant extends Participant { cap?: string }
interface Meta {
  id: string;
  name: string;
  secret: string;
  policy: RoomPolicy;
  participants: Record<string, StoredParticipant>;
  createdAt: string;
  createdBy: string;
  state: "open" | "closed";
  e2e?: boolean; // v0.5.0: a marker the creator set — bodies are ciphertext this relay cannot read
  // Portable rooms / mirrors (v0.4.15+); all surfaced through info() so clients can see them.
  pastRelayPubs?: string[]; // relay keys this room lived under before it was imported here
  /** v0.9.2: a room wired to a LINE group is that group's channel, not a 6 h scratch room.
   *  While this is set, every append slides policy.ttlSec forward so the room lives as long as
   *  it is used and expires this many seconds after the LAST message. Cleared when unwired. */
  keepAliveSec?: number;
  role?: "mirror";          // absent = primary; a mirror only accepts verified /replicate appends
  origin?: string;          // mirror only: the primary relay this replica follows
  mirrors?: string[];       // primary only: relays every append is pushed to
}
interface Last { seq: number; hash: string }

const seqKey = (n: number) => "m:" + String(n).padStart(8, "0");
const PUB_RE = /^[0-9a-f]{64}$/;

export class RoomDO extends DurableObject<Env> {
  private waiters: Array<() => void> = [];
  /** Per-sender minute buckets. In memory on purpose: a DO is single-threaded per room,
   *  eviction only resets the window, and no storage write per message is worth it. */
  private sendRate = new Map<string, { min: number; n: number }>();
  private app = new Hono();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.routes();
  }

  override async fetch(req: Request): Promise<Response> {
    return this.app.fetch(req);
  }

  private routes() {
    const app = this.app;

    // Create (only ever reached through the worker's key check).
    app.post("/rooms/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; policy?: Partial<RoomPolicy>; creator?: { pubkey: string; name: string }; e2e?: boolean };
      if (await this.meta()) return c.json({ error: "room exists" }, 409);
      if (!b.creator?.pubkey || !PUB_RE.test(b.creator.pubkey)) return c.json({ error: "creator.pubkey (hex ed25519) required" }, 400);
      const now = new Date().toISOString();
      const cap = randomHex(24);
      const meta: Meta = {
        id,
        name: b.name ?? "",
        secret: randomHex(24),
        policy: { ...DEFAULT_POLICY, ...(b.policy ?? {}) },
        participants: { [b.creator.pubkey]: { name: b.creator.name ?? "", joinedAt: now, cap } },
        createdAt: now,
        createdBy: b.creator.pubkey,
        state: "open",
        ...(b.e2e ? { e2e: true } : {}),
      };
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.put<Last>("last", { seq: 0, hash: genesis(id) });
      await this.appendSystem(meta, { event: "create", by: b.creator.pubkey, name: b.creator.name ?? "" });
      return c.json({ id, secret: meta.secret, cap, room: await this.info(meta, true) });
    });

    // Import (portable rooms, v0.4.15). Only ever reached through the worker's key check,
    // like create. The whole chain is RE-VERIFIED here: participant signatures, hashes,
    // seq continuity, and system events against the exporting relay's key. Nothing that
    // fails verification is stored — an import that succeeds is as good as having watched
    // the room live.
    app.post("/rooms/:id/import", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => null)) as {
        format?: string;
        room?: { id?: string; name?: string; policy?: Partial<RoomPolicy>; participants?: Record<string, Participant>; createdAt?: string; createdBy?: string; state?: string; e2e?: boolean };
        secret?: string; messages?: Envelope[]; relayPub?: string; role?: string; origin?: string;
      } | null;
      if (await this.meta()) return c.json({ error: "room exists" }, 409);
      if (!b || b.format !== "parley-export-1" || !b.room || !Array.isArray(b.messages)) return c.json({ error: "not a can2cup export (format parley-export-1)" }, 400);
      if (b.room.id !== id) return c.json({ error: `export is for room ${b.room.id}, not ${id}` }, 400);
      const msgs = b.messages;
      const v = verifyChain(id, msgs, { relayPub: b.relayPub && /^[0-9a-f]{64}$/.test(b.relayPub) ? b.relayPub : undefined });
      if (!v.ok) return c.json({ error: `import refused: chain does not verify at seq ${v.failedAt}: ${v.errors.join(", ")}` }, 400);
      const tail = msgs[msgs.length - 1];
      const asMirror = b.role === "mirror";
      const meta: Meta = {
        id,
        name: b.room.name ?? "",
        // A cap-authenticated export carries the room secret so existing invite links keep
        // working on the new home; otherwise a fresh one is minted.
        secret: b.secret && /^[0-9a-f]{16,}$/.test(b.secret) ? b.secret : randomHex(24),
        policy: { ...DEFAULT_POLICY, ...(b.room.policy ?? {}) },
        participants: Object.fromEntries(Object.entries(b.room.participants ?? {}).map(([pk, p]) => [pk, { name: p.name ?? "", joinedAt: p.joinedAt ?? "", ...(p.removed ? { removed: p.removed } : {}) }])),
        createdAt: b.room.createdAt ?? new Date().toISOString(),
        createdBy: b.room.createdBy ?? "",
        state: b.room.state === "closed" ? "closed" : "open",
        ...(b.room.e2e ? { e2e: true } : {}),
        ...(b.relayPub && /^[0-9a-f]{64}$/.test(b.relayPub) ? { pastRelayPubs: [b.relayPub] } : {}),
        ...(asMirror ? { role: "mirror" as const, origin: typeof b.origin === "string" ? b.origin : "" } : {}),
      };
      for (const m of msgs) await this.ctx.storage.put(seqKey(m.seq), m);
      await this.ctx.storage.put<Last>("last", tail ? { seq: tail.seq, hash: tail.hash } : { seq: 0, hash: genesis(id) });
      await this.ctx.storage.put("meta", meta);
      // The custody transfer is recorded in-band, signed by THIS relay's key. A mirror stays
      // byte-identical to its primary, so it appends nothing.
      if (!asMirror) await this.appendSystem(meta, { event: "import", fromRelayPub: b.relayPub ?? "", atSeq: tail?.seq ?? 0 });
      return c.json({ id, secret: meta.secret, imported: msgs.length, room: await this.info(meta, true) });
    });

    // Replicate (mirrors, v0.4.16). No bearer: the verification IS the authorisation —
    // only envelopes that carry valid participant/relay signatures AND extend this exact
    // chain are accepted, and those are by definition the true transcript. Worst case a
    // stranger replays the real room at us, which is what mirroring is.
    app.post("/rooms/:id/replicate", async (c) => {
      const arr = (await c.req.json().catch(() => null)) as Envelope[] | null;
      // re-read AFTER the body await: from here on only storage awaits (input gate = atomic)
      const meta = await this.meta();
      if (!meta) return c.json({ error: "no such room — seed the mirror with an import (role: mirror) first" }, 404);
      if (meta.role !== "mirror") return c.json({ error: "this room is not a mirror" }, 403);
      if (!Array.isArray(arr) || arr.length === 0) return c.json({ error: "array of envelopes required" }, 400);
      const last = (await this.ctx.storage.get<Last>("last"))!;
      let seq = last.seq;
      let prev = last.hash;
      let dirtyMeta = false;
      for (const m of arr) {
        if (typeof m?.seq !== "number" || m.seq <= seq) continue; // already replicated
        if (m.seq !== seq + 1) return c.json({ error: "gap: send everything after lastSeq", lastSeq: seq, lastHash: prev }, 409);
        const opts = meta.pastRelayPubs?.length ? { relayPub: meta.pastRelayPubs[0], pastRelayPubs: meta.pastRelayPubs } : {};
        const v = verifyEnvelope(m, prev, opts);
        if (!v.ok) return c.json({ error: `rejected at seq ${m.seq}: ${v.errors.join(", ")}`, lastSeq: seq }, 400);
        await this.store(m);
        seq = m.seq;
        prev = m.hash;
        // Keep the read-side meta roughly in step with the chain it mirrors.
        if (m.type === "close") { meta.state = "closed"; dirtyMeta = true; }
        if (m.type === "system") {
          const b = (m.body ?? {}) as { event?: string; by?: string; name?: string; target?: string };
          if (b.event === "join" && b.by && !meta.participants[b.by]) { meta.participants[b.by] = { name: b.name ?? "", joinedAt: m.ts }; dirtyMeta = true; }
          if (b.event === "eject" && b.target && meta.participants[b.target]) { meta.participants[b.target].removed = m.ts; dirtyMeta = true; }
        }
      }
      if (dirtyMeta) await this.ctx.storage.put("meta", meta);
      return c.json({ ok: true, lastSeq: seq });
    });

    // Promote (failover, v0.4.16): a participant turns a mirror into the primary after the
    // original relay died. Signature-only — caps never existed on the mirror. The promote
    // event is signed by THIS relay's key; clients absorb the key change on re-join.
    app.post("/rooms/:id/promote", async (c) => {
      const raw = await c.req.text();
      const sig = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, raw);
      if (!sig.ok) return c.json({ error: `promote must be signed: ${sig.error}` }, 401);
      const meta = await this.meta();
      if (!meta) return c.json({ error: "no such room" }, 404);
      if (meta.role !== "mirror") return c.json({ error: "this room is already a primary" }, 409);
      const p = meta.participants[sig.pub];
      if (!p || p.removed) return c.json({ error: "only a participant of the room can promote its mirror" }, 403);
      const origin = meta.origin;
      delete meta.role;
      delete meta.origin;
      await this.ctx.storage.put("meta", meta);
      await this.appendSystem(meta, { event: "promote", by: sig.pub, from: origin ?? "" });
      return c.json({ ok: true, secret: meta.secret });
    });

    // Wiring a room to a LINE group (BridgeDO only — the worker refuses /rooms/:id/internal/*
    // from outside, so this needs no key of its own). Turning it on never shortens a room's life:
    // it raises ttlSec so the room lives at least `keepAliveSec` from now, and every later append
    // slides it forward again.
    // v0.9.12: what the bridge needs to keep group wires honest — is the room alive, and until when.
    app.get("/rooms/:id/internal/meta", async (c) => {
      const meta = await this.meta();
      if (!meta) return c.json({ error: "no such room" }, 404);
      return c.json({ state: meta.state, expiresAt: new Date(Date.parse(meta.createdAt) + meta.policy.ttlSec * 1000).toISOString(), keepAliveSec: meta.keepAliveSec ?? 0 });
    });
    app.post("/rooms/:id/internal/keepalive", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { on?: boolean; keepAliveSec?: number; touch?: boolean };
      const meta = await this.meta();
      if (!meta) return c.json({ error: "no such room" }, 404);
      // v0.9.12 touch: the principal spoke to the agent from the wired group. Same slide an append would give
      // the room; changes nothing when the room has no keep-alive (an unwired room is not the bridge's to extend).
      if (b.touch) {
        if (meta.keepAliveSec && meta.state === "open") {
          const elapsed = Math.round((Date.now() - Date.parse(meta.createdAt)) / 1000);
          meta.policy = { ...meta.policy, ttlSec: Math.max(meta.policy.ttlSec, elapsed + meta.keepAliveSec) };
          await this.ctx.storage.put("meta", meta);
        }
        return c.json({ ok: true, keepAliveSec: meta.keepAliveSec ?? 0, expiresAt: new Date(Date.parse(meta.createdAt) + meta.policy.ttlSec * 1000).toISOString() });
      }
      if (b.on === false) {
        delete meta.keepAliveSec;
        await this.ctx.storage.put("meta", meta);
        return c.json({ ok: true, keepAliveSec: 0, expiresAt: new Date(Date.parse(meta.createdAt) + meta.policy.ttlSec * 1000).toISOString() });
      }
      const keep = Math.max(3600, Math.min(365 * 24 * 3600, Math.round(Number(b.keepAliveSec) || 0) || 30 * 24 * 3600));
      const elapsed = Math.round((Date.now() - Date.parse(meta.createdAt)) / 1000);
      meta.keepAliveSec = keep;
      meta.policy = { ...meta.policy, ttlSec: Math.max(meta.policy.ttlSec, elapsed + keep) };
      await this.ctx.storage.put("meta", meta);
      return c.json({ ok: true, keepAliveSec: keep, expiresAt: new Date(Date.parse(meta.createdAt) + meta.policy.ttlSec * 1000).toISOString() });
    });

    // Everything below needs the room secret or a participant's cap.
    app.use("/rooms/:id/*", async (c, next) => {
      const meta = await this.meta();
      if (!meta) return c.json({ error: "no such room" }, 404);
      const auth = c.req.header("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) return c.json({ error: "bad room secret" }, 401);
      let authPub = "";
      if (token !== meta.secret) {
        const hit = Object.entries(meta.participants).find(([, p]) => p.cap && p.cap === token && !p.removed);
        if (!hit) return c.json({ error: "bad room secret" }, 401);
        authPub = hit[0];
      }
      c.set("authPub" as never, authPub as never);
      await next();
    });

    app.get("/rooms/:id/info", async (c) => {
      const meta = (await this.meta())!;
      return c.json(await this.info(meta, !!(c.get("authPub" as never) as string)));
    });

    app.post("/rooms/:id/join", async (c) => {
      const raw = await c.req.text();
      const sig = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, raw);
      if (!sig.ok) return c.json({ error: `join must be signed by the joining key: ${sig.error}` }, 401);
      let b: { pubkey?: string; name?: string } = {};
      try { b = JSON.parse(raw || "{}"); } catch { /* handled below */ }
      const meta = (await this.meta())!; // re-read AFTER the body await: from here to the put, only storage awaits (input gate = atomic)
      if (!b.pubkey || !PUB_RE.test(b.pubkey)) return c.json({ error: "pubkey (hex ed25519) required" }, 400);
      if (b.pubkey !== sig.pub) return c.json({ error: "pubkey does not match the signing key" }, 401);
      if (meta.role === "mirror") return c.json({ error: `this room is a read-only mirror${meta.origin ? ` of ${meta.origin}` : ""} — join at the primary (or promote first)` }, 409);
      if (meta.state !== "open") return c.json({ error: "room closed" }, 409);
      const existing = meta.participants[b.pubkey];
      if (existing?.removed) return c.json({ error: "you were removed from this room" }, 403);
      if (!existing) {
        meta.participants[b.pubkey] = { name: b.name ?? "", joinedAt: new Date().toISOString(), cap: randomHex(24) };
        await this.ctx.storage.put("meta", meta);
        await this.appendSystem(meta, { event: "join", by: b.pubkey, name: b.name ?? "" });
      } else if (!existing.cap) {
        existing.cap = randomHex(24); // participant from before caps existed: issue one now
        await this.ctx.storage.put("meta", meta);
      }
      return c.json({ ...(await this.info(meta, true)), cap: meta.participants[b.pubkey].cap });
    });

    app.get("/rooms/:id/messages", async (c) => {
      const since = Math.max(0, Number(c.req.query("since") ?? 0) || 0);
      const wait = Math.min(50, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
      let msgs = await this.since(since);
      if (msgs.length === 0 && wait > 0) {
        await Promise.race([
          new Promise<void>((r) => this.waiters.push(r)),
          new Promise<void>((r) => setTimeout(r, wait * 1000)),
        ]);
        msgs = await this.since(since);
      }
      const last = (await this.ctx.storage.get<Last>("last"))!;
      const meta = (await this.meta())!;
      const fork = this.env.DEBUG_ROUTES === "1" ? await this.ctx.storage.get<string>("debug:forkHash") : undefined;
      // v0.11.2 (smoke, fourth opinion #10): serve only a PREFIX while every number and the signed head stay truthful.
      const upto = this.env.DEBUG_ROUTES === "1" ? await this.ctx.storage.get<number>("debug:serveUpto") : undefined;
      if (typeof upto === "number") msgs = msgs.filter((m) => m.seq <= upto);
      return c.json({ messages: msgs, lastSeq: last.seq, lastHash: last.hash, state: meta.state, head: this.head(meta.id, fork ? { ...last, hash: fork } : last), relayPub: relayPub(this.env) });
    });

    // v0.11.1 (smoke, third opinion #1 and #9): a hostile relay rewriting a stored body under an intact hash/signature,
    // and a relay signing a second, different head at the same seq. A correct client must refuse to take terms from
    // the first and must keep both statements of the second. DEBUG_ROUTES=1 only (never set in wrangler.toml).
    app.use("/rooms/:id/debug/*", async (c, next) => { if (this.env.DEBUG_ROUTES !== "1") return c.json({ error: "not found" }, 404); await next(); });
    app.post("/rooms/:id/debug/tamper", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { seq?: number; body?: Record<string, unknown> };
      const e = typeof p.seq === "number" ? await this.ctx.storage.get<Envelope>(seqKey(p.seq)) : undefined;
      if (!e || !p.body) return c.json({ error: "seq and body required" }, 400);
      await this.ctx.storage.put(seqKey(p.seq!), { ...e, body: p.body }); // hash and sig left as they were
      return c.json({ ok: true, seq: p.seq });
    });
    app.post("/rooms/:id/debug/serve-upto", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { upto?: number | null };
      if (p.upto === null || p.upto === undefined) { await this.ctx.storage.delete("debug:serveUpto"); return c.json({ ok: true, upto: null }); }
      await this.ctx.storage.put("debug:serveUpto", p.upto);
      return c.json({ ok: true, upto: p.upto });
    });
    app.post("/rooms/:id/debug/fork-head", async (c) => {
      const p = (await c.req.json().catch(() => ({}))) as { hash?: string | null };
      if (p.hash === null) { await this.ctx.storage.delete("debug:forkHash"); return c.json({ ok: true, forked: false }); }
      if (!/^[0-9a-f]{64}$/.test(p.hash ?? "")) return c.json({ error: "hash (64 hex) or null required" }, 400);
      await this.ctx.storage.put("debug:forkHash", p.hash);
      return c.json({ ok: true, forked: true });
    });

    app.get("/rooms/:id/head", async (c) => {
      const last = (await this.ctx.storage.get<Last>("last"))!;
      const meta = (await this.meta())!;
      const h = this.head(meta.id, last);
      if (!h) return c.json({ error: "relay has no signing key" }, 404);
      return c.json(h);
    });

    // Export (portable rooms, v0.4.15): everything another relay needs to re-home this
    // room. Caps never leave. The invite secret rides along only for a cap-authenticated
    // caller (same rule as info), so existing links keep working after a move.
    app.get("/rooms/:id/export", async (c) => {
      const meta = (await this.meta())!;
      const last = (await this.ctx.storage.get<Last>("last"))!;
      const msgs = await this.since(0);
      const participants: Record<string, Participant> = {};
      for (const [pk, p] of Object.entries(meta.participants)) { const { cap: _c, ...rp } = p; participants[pk] = rp; }
      const withSecret = !!(c.get("authPub" as never) as string);
      return c.json({
        format: "parley-export-1",
        exportedAt: new Date().toISOString(),
        room: { id: meta.id, name: meta.name, policy: meta.policy, participants, createdAt: meta.createdAt, createdBy: meta.createdBy, state: meta.state, ...(meta.e2e ? { e2e: true } : {}) },
        ...(withSecret ? { secret: meta.secret } : {}),
        messages: msgs,
        relayPub: relayPub(this.env),
        head: this.head(meta.id, last),
      });
    });

    // ---- RFC 3161 anchoring ---------------------------------------------------------------
    // A neutral third party attests that the head existed at a time the operator did not choose.
    // GET returns the latest anchor; POST takes a fresh one over the current head.
    app.get("/rooms/:id/anchor", async (c) => {
      if (!this.env.TSA_URL) return c.json({ error: "anchoring not configured on this relay" }, 501);
      const a = await this.ctx.storage.get<Anchor>("anchor:last");
      if (!a) return c.json({ error: "this room has never been anchored" }, 404);
      const last = (await this.ctx.storage.get<Last>("last"))!;
      // An anchor attests to the head it was taken over, not to whatever the room says now.
      return c.json({ ...a, current: { seq: last.seq, hash: last.hash }, stale: a.hash !== last.hash });
    });

    app.post("/rooms/:id/anchor", async (c) => {
      if (!this.env.TSA_URL) return c.json({ error: "anchoring not configured on this relay" }, 501);
      const last = (await this.ctx.storage.get<Last>("last"))!;
      try {
        const a = await this.anchor(last);
        return c.json(a);
      } catch (e) {
        // Never store or report a failed anchor as if it were evidence.
        return c.json({ error: e instanceof AnchorError ? e.message : "anchor failed" }, 502);
      }
    });

    app.post("/rooms/:id/messages", async (c) => {
      const s = (await c.req.json().catch(() => null)) as Submitted | null;
      if (!s || typeof s !== "object") return c.json({ error: "envelope required" }, 400);
      // Everything below must stay free of non-storage awaits: the DO input gate then makes
      // read-last → check-prev → store atomic, so two racing sends cannot both take seq N.
      const authPub = c.get("authPub" as never) as string;
      // v0.9.0 upgrade protocol: a client that announces a version below the relay's minimum may read but not
      // speak. Header-less callers (the bridge's own mirror appends, pre-0.9 clients) are gated on /p/* instead.
      const ver = (c.req.header("x-can2cup-client") ?? "").trim();
      if (ver && cmpSemver(ver, (this.env.MIN_CLIENT ?? "").trim() || NO_VERSION) < 0) return c.json({ error: `upgrade required: can2cup ${ver} is below this relay's minimum ${(this.env.MIN_CLIENT ?? "").trim()} — run \`can2cup upgrade\` on that computer, then restart Claude Code once`, min: (this.env.MIN_CLIENT ?? "").trim(), cmd: "can2cup upgrade" }, 426);
      const meta = (await this.meta())!;
      const last = (await this.ctx.storage.get<Last>("last"))!;
      if (meta.role === "mirror") return c.json({ error: `this room is a read-only mirror${meta.origin ? ` of ${meta.origin}` : ""} — write to the primary`, lastSeq: last.seq, lastHash: last.hash }, 409);
      if (meta.state !== "open") return c.json({ error: "room closed", lastSeq: last.seq, lastHash: last.hash }, 409);
      const expiresAt = Date.parse(meta.createdAt) + meta.policy.ttlSec * 1000;
      if (Date.now() > expiresAt) {
        return c.json({
          error: `room ttl expired at ${new Date(expiresAt).toISOString()} (rooms live ${Math.round(meta.policy.ttlSec / 3600)} h from creation${meta.keepAliveSec ? ", sliding while in use" : ""}) — open a new room; if this room was a LINE group's channel, type /room in that group`,
          expiredAt: new Date(expiresAt).toISOString(),
        }, 410);
      }
      if (last.seq >= meta.policy.maxMessages) return c.json({ error: "room message cap reached; close it" }, 429);
      if (s.room !== meta.id) return c.json({ error: "envelope.room mismatch" }, 400);
      if (s.from === RELAY_SENDER || s.type === "system") return c.json({ error: "system events are relay-only" }, 403);
      const p = meta.participants[s.from];
      if (!p || p.removed) return c.json({ error: "sender is not a participant" }, 403);
      const rateLim = Math.max(1, Number(this.env.MSGS_PER_MIN ?? 60) || 60);
      const nowMin = Math.floor(Date.now() / 60000);
      const rate = this.sendRate.get(s.from);
      if (!rate || rate.min !== nowMin) this.sendRate.set(s.from, { min: nowMin, n: 1 });
      else if (++rate.n > rateLim) return c.json({ error: `rate limited: over ${rateLim} messages in a minute from this key`, retryInSec: 60 - Math.floor((Date.now() % 60000) / 1000) }, 429);
      if (authPub && authPub !== s.from) return c.json({ error: "cap does not belong to envelope.from" }, 403);
      if (!MSG_TYPES.includes(s.type)) return c.json({ error: "unknown type" }, 400);
      // v0.11.2 (fourth opinion #3): an E2E room takes ciphertext only. A client that joined from a link stripped of
      // its key must not be able to put plaintext where the other participants believe nothing readable exists.
      if (meta.e2e && !isEncrypted(s.body)) return c.json({ error: "this room is end-to-end encrypted: plaintext bodies are refused — the sending client has no room key; it must re-join with the full invite link" }, 400);
      if (s.prev !== last.hash) return c.json({ error: "stale prev; refetch and re-sign", lastSeq: last.seq, lastHash: last.hash }, 409);
      const seq = last.seq + 1;
      const partial = { ...s, seq };
      const env: Envelope = { ...partial, hash: computeHash(partial) };
      const v = verifyEnvelope(env, last.hash);
      if (!v.ok) return c.json({ error: "rejected", details: v.errors }, 400);
      if (env.type === "close") meta.state = "closed";
      await this.store(env);
      // v0.9.2: a wired room's clock runs from its last message, not from its creation. Only
      // written when the remaining life has dropped below half, so busy rooms do not pay a
      // storage write per message.
      let slid = false;
      if (meta.keepAliveSec && expiresAt - Date.now() < (meta.keepAliveSec * 1000) / 2) {
        meta.policy = { ...meta.policy, ttlSec: Math.round((Date.now() - Date.parse(meta.createdAt)) / 1000) + meta.keepAliveSec };
        slid = true;
      }
      if (env.type === "close" || slid) await this.ctx.storage.put("meta", meta);
      await this.tellBridge(env, meta); // after everything is committed; storage-only on the far side
      // A commitment (accept / grant) is the moment the transcript may later be cited, so that
      // is what we anchor. Off the response path: the TSA round trip must not hold the input
      // gate, and a TSA outage must never make a valid send fail.
      if (this.env.TSA_URL && COMMITMENT_TYPES.includes(env.type)) {
        this.ctx.waitUntil(this.anchor({ seq: env.seq, hash: env.hash }).catch(() => undefined));
      }
      return c.json(env);
    });

    // ---- room administration: signed by a participant's key ------------------------------
    app.post("/rooms/:id/rotate", async (c) => {
      const raw = await c.req.text();
      const sig = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, raw);
      if (!sig.ok) return c.json({ error: `rotate must be signed: ${sig.error}` }, 401);
      const meta = (await this.meta())!;
      if (meta.role === "mirror") return c.json({ error: "a mirror is read-only — rotate at the primary" }, 409);
      const p = meta.participants[sig.pub];
      if (!p || p.removed) return c.json({ error: "only an active participant can rotate" }, 403);
      meta.secret = randomHex(24);
      await this.ctx.storage.put("meta", meta);
      await this.appendSystem(meta, { event: "rotate", by: sig.pub });
      return c.json({ ok: true, secret: meta.secret });
    });

    app.post("/rooms/:id/eject", async (c) => {
      const raw = await c.req.text();
      const sig = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, raw);
      if (!sig.ok) return c.json({ error: `eject must be signed: ${sig.error}` }, 401);
      let b: { pubkey?: string } = {};
      try { b = JSON.parse(raw || "{}"); } catch { /* below */ }
      const meta = (await this.meta())!;
      if (meta.role === "mirror") return c.json({ error: "a mirror is read-only — eject at the primary" }, 409);
      if (sig.pub !== meta.createdBy) return c.json({ error: "only the room creator can eject" }, 403);
      const target = b.pubkey ?? "";
      const t = meta.participants[target];
      if (!t) return c.json({ error: "no such participant" }, 404);
      if (target === meta.createdBy) return c.json({ error: "the creator cannot eject themselves; close the room instead" }, 400);
      if (!t.removed) {
        t.removed = new Date().toISOString();
        delete t.cap;
        meta.secret = randomHex(24); // their invite link must die with their cap
        await this.ctx.storage.put("meta", meta);
        await this.appendSystem(meta, { event: "eject", by: sig.pub, target, name: t.name });
      }
      return c.json({ ok: true, secret: meta.secret });
    });

    /** v0.9.5: leave a room you are in. Signed by the leaver — nobody can be walked out by
     *  someone else through this route (that is `eject`, and only the creator may call it).
     *
     *  Rotates the secret, like eject: someone who has left still knows the old one, and "I left"
     *  has to mean they cannot walk back in. Everyone else's cap keeps working; only pending
     *  invite links have to be re-issued.
     *
     *  The transcript stays. The other participants hold a signed copy of every message either
     *  side wrote, and deleting this relay's copy would not retract theirs. */
    app.post("/rooms/:id/leave", async (c) => {
      const raw = await c.req.text();
      const sig = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, raw);
      if (!sig.ok) return c.json({ error: `leave must be signed: ${sig.error}` }, 401);
      const meta = (await this.meta())!;
      if (meta.role === "mirror") return c.json({ error: "a mirror is read-only — leave at the primary" }, 409);
      const me = meta.participants[sig.pub];
      if (!me || me.removed) return c.json({ error: "you are not in this room" }, 404);
      if (sig.pub === meta.createdBy) {
        const others = Object.entries(meta.participants).filter(([pk, p]) => pk !== sig.pub && !p.removed);
        if (others.length) return c.json({ error: "you opened this room — close it (with a summary the others can read) instead of walking out of it" }, 400);
      }
      me.removed = new Date().toISOString();
      delete me.cap;
      meta.secret = randomHex(24);
      const left = Object.values(meta.participants).filter((p) => !p.removed).length;
      if (!left) meta.state = "closed"; // nobody is in it any more; stop it lingering as "open"
      await this.ctx.storage.put("meta", meta);
      await this.appendSystem(meta, { event: "leave", by: sig.pub, name: me.name });
      return c.json({ ok: true, remaining: left, roomClosed: !left });
    });

    // ---- mirrors (v0.4.16): where every append of this room is pushed --------------------
    // Signed by an active participant, like rotate. The mirror room itself must already
    // exist on the target relay (seeded with an import, role: mirror).
    app.post("/rooms/:id/mirrors", async (c) => {
      const raw = await c.req.text();
      const sig = verifyRequestHeaders((n) => c.req.header(n), c.req.method, c.req.path, raw);
      if (!sig.ok) return c.json({ error: `mirrors must be signed: ${sig.error}` }, 401);
      let b: { add?: string; remove?: string } = {};
      try { b = JSON.parse(raw || "{}"); } catch { /* below */ }
      const meta = (await this.meta())!;
      if (meta.role === "mirror") return c.json({ error: "a mirror cannot have mirrors of its own" }, 409);
      const p = meta.participants[sig.pub];
      if (!p || p.removed) return c.json({ error: "only an active participant can manage mirrors" }, 403);
      const cur = new Set(meta.mirrors ?? []);
      if (b.add) {
        if (!/^https?:\/\/\S+$/.test(b.add)) return c.json({ error: "add must be a relay base URL" }, 400);
        cur.add(b.add.replace(/\/+$/, ""));
      } else if (b.remove) {
        cur.delete(b.remove.replace(/\/+$/, ""));
      } else return c.json({ error: "add or remove required" }, 400);
      meta.mirrors = [...cur];
      await this.ctx.storage.put("meta", meta);
      // In-band, so every participant sees where copies of the room live.
      await this.appendSystem(meta, { event: b.add ? "mirror" : "unmirror", by: sig.pub, url: (b.add ?? b.remove ?? "").replace(/\/+$/, "") });
      return c.json({ ok: true, mirrors: meta.mirrors });
    });
  }

  private async meta(): Promise<Meta | undefined> {
    return this.ctx.storage.get<Meta>("meta");
  }

  /** Public view. Caps never leave; the invite secret only goes to a cap-authenticated caller. */
  private async info(meta: Meta, withSecret: boolean): Promise<RoomInfo> {
    const last = (await this.ctx.storage.get<Last>("last")) ?? { seq: 0, hash: genesis(meta.id) };
    const { secret, participants, ...rest } = meta;
    const pub: Record<string, Participant> = {};
    for (const [pk, p] of Object.entries(participants)) {
      const { cap: _c, ...rp } = p;
      pub[pk] = rp;
    }
    return { ...rest, participants: pub, lastSeq: last.seq, lastHash: last.hash, relayPub: relayPub(this.env), ...(withSecret ? { secret } : {}) };
  }

  private head(room: string, last: Last): Head | undefined {
    const k = this.env.RELAY_SIGNING_KEY;
    if (!k) return undefined;
    return signHead({ room, seq: last.seq, hash: last.hash, at: new Date().toISOString() }, k);
  }

  /** Take an RFC 3161 timestamp over a head and keep it. Kept by seq as well as
   *  "last" so an old commitment's anchor survives later traffic. */
  private async anchor(at: Last): Promise<Anchor> {
    const a = await requestTimestamp(this.env.TSA_URL!, at.seq, at.hash, randomHex(8));
    await this.ctx.storage.put("anchor:last", a);
    await this.ctx.storage.put("anchor:" + String(a.seq).padStart(8, "0"), a);
    return a;
  }

  private async since(n: number): Promise<Envelope[]> {
    const map = await this.ctx.storage.list<Envelope>({ prefix: "m:", start: seqKey(n + 1) });
    return [...map.values()];
  }

  private async store(env: Envelope): Promise<void> {
    await this.ctx.storage.put(seqKey(env.seq), env);
    await this.ctx.storage.put<Last>("last", { seq: env.seq, hash: env.hash });
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
    // Off the response path: a mirror being down must never slow or fail an append.
    this.ctx.waitUntil(this.pushMirrors().catch(() => undefined));
  }

  /** Replicate the tail to every mirror. Stateless on purpose: push the newest envelope;
   *  a 409 carries the mirror's cursor and we resend everything after it. Failures are
   *  silent — the next append retries, and `can2cup mirror --add` re-syncs from scratch. */
  private async pushMirrors(): Promise<void> {
    const meta = await this.meta();
    if (!meta?.mirrors?.length || meta.role === "mirror") return;
    const last = await this.ctx.storage.get<Last>("last");
    if (!last?.seq) return;
    for (const m of meta.mirrors) {
      try {
        const url = `${m}/rooms/${meta.id}/replicate`;
        const post = (body: Envelope[]) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        let res = await post(await this.since(last.seq - 1));
        if (res.status === 409) {
          const j = (await res.json().catch(() => ({}))) as { lastSeq?: number };
          if (typeof j.lastSeq === "number") res = await post(await this.since(j.lastSeq));
        }
      } catch { /* mirror unreachable — next append retries */ }
    }
  }

  /** Tell the principal bridge (LINE pushes, group mirrors, room knowledge). Awaited so it is
   *  reliable, but only ever called after the append is committed, and never allowed to throw. */
  private async tellBridge(env: Envelope, meta: Meta): Promise<void> {
    const parts: Record<string, { name: string }> = {};
    for (const [pk, p] of Object.entries(meta.participants)) if (!p.removed) parts[pk] = { name: p.name };
    const ev: RoomEvent = { room: meta.id, name: meta.name, state: meta.state, participants: parts, envelope: env };
    try {
      const stub = this.env.BRIDGE.get(this.env.BRIDGE.idFromName("bridge"));
      await stub.fetch(new Request("https://do/internal/event", { method: "POST", body: JSON.stringify(ev), headers: { "content-type": "application/json" } }));
    } catch { /* bridge trouble must not surface to participants */ }
  }

  private async appendSystem(meta: Meta, body: unknown): Promise<void> {
    const last = (await this.ctx.storage.get<Last>("last"))!;
    const unsigned = {
      v: PROTOCOL_VERSION, room: meta.id, from: RELAY_SENDER, ts: new Date().toISOString(),
      type: "system" as const, body, prev: last.hash,
    };
    const k = this.env.RELAY_SIGNING_KEY;
    const partial = { ...unsigned, sig: k ? signHex(signingBytes(unsigned), k) : "", seq: last.seq + 1 };
    const env: Envelope = { ...partial, hash: computeHash(partial) };
    await this.store(env);
    await this.tellBridge(env, meta);
  }
}
