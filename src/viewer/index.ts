#!/usr/bin/env node
/**
 * can2cup viewer — the principal's window onto the rooms their agent is in.
 * Local only (binds 127.0.0.1). Reads CAN2CUP_HOME, proxies the relay with the
 * stored room secrets, verifies the chain with the shared protocol code, and
 * merges the local audit log (private rationale, blocked attempts) into the
 * transcript. Also exposes the PAUSED brake.
 *
 *   node dist/viewer/index.js [--port 7777]
 *   CAN2CUP_NOTIFY_URL=https://ntfy.sh/<topic>   also push inbound events / blocks / escalations (see notify.ts)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { type Envelope, verifyEnvelope, genesis, encodeInvite, encodeInviteUrl, decryptBody, isEncrypted } from "../protocol/index.js";
import { HOME, loadIdentity, loadRooms, loadMandate, isPaused, type LocalRoom } from "../mcp/state.js";
import { relay } from "../mcp/relay-client.js";
import { PAGE } from "./page.js";
import { notifyEnabled, startWatcher } from "./notify.js";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 7777;
const me = loadIdentity();

// Per-room verified cache: messages + verification results, advanced by delta polls.
interface Cached { msgs: Envelope[]; ok: boolean[]; head: string; names: Record<string, string>; state: string; namesAt: number }
const cache = new Map<string, Cached>();

async function roomDelta(room: LocalRoom, wait: number): Promise<{ delta: Array<Envelope & { ok: boolean; errors: string[] }>; c: Cached }> {
  let c = cache.get(room.id);
  if (!c) { c = { msgs: [], ok: [], head: genesis(room.id), names: {}, state: room.state, namesAt: 0 }; cache.set(room.id, c); }
  const since = c.msgs.length ? c.msgs[c.msgs.length - 1].seq : 0;
  const res = await relay.poll(room.relay, room.id, room.cap ?? room.secret, since, since === 0 ? 0 : wait);
  const delta: Array<Envelope & { ok: boolean; errors: string[] }> = [];
  for (const m of res.messages) {
    const v = verifyEnvelope(m, c.head, { relayPub: room.relayPub, pastRelayPubs: room.relayPubHistory });
    c.head = m.hash;
    // E2E rooms: verify the wire form above, show the plaintext below.
    let shown = m;
    if (room.key && isEncrypted(m.body)) {
      const d = await decryptBody(room.key, room.id, m.body);
      shown = { ...m, body: d === undefined ? { text: "[E2E: body did not decrypt]" } : d };
    }
    c.msgs.push(shown); c.ok.push(v.ok);
    delta.push({ ...shown, ok: v.ok, errors: v.errors });
  }
  c.state = res.state;
  if (Date.now() - c.namesAt > 15000 || delta.some((m) => m.type === "system")) {
    try {
      const info = await relay.info(room.relay, room.id, room.cap ?? room.secret);
      c.names = Object.fromEntries(Object.entries(info.participants).map(([pk, p]) => [pk, p.name || pk.slice(0, 8)]));
    } catch { /* keep old names */ }
    c.namesAt = Date.now();
  }
  return { delta, c };
}

interface AuditEntry { at: string; kind: string; room?: string; seq?: number; type?: string; body?: unknown; rationale?: string | null; reason?: string }
function readAudit(roomId: string): AuditEntry[] {
  const p = path.join(HOME, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as AuditEntry; } catch { return null; } })
    .filter((e): e is AuditEntry => !!e && e.room === roomId);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (url.pathname === "/api/state") {
      const rooms = Object.values(loadRooms()).sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
      return json(res, 200, { me: { name: me.name, pub: me.pub }, home: HOME, paused: isPaused(), notify: notifyEnabled, mandate: loadMandate(), rooms });
    }
    const inv = /^\/api\/rooms\/([0-9a-f]{12})\/invite$/.exec(url.pathname);
    if (inv) {
      const room = loadRooms()[inv[1]];
      if (!room) return json(res, 404, { error: "unknown room" });
      const i = { u: room.relay, r: room.id, s: room.secret, n: room.name || undefined, p: room.relayPub };
      const link = encodeInviteUrl(i);
      const qr = await QRCode.toDataURL(link, { margin: 1, width: 240, color: { dark: "#000000", light: "#ffffff" } });
      return json(res, 200, { link, token: encodeInvite(i), qr });
    }
    const m = /^\/api\/rooms\/([0-9a-f]{12})$/.exec(url.pathname);
    if (m) {
      const room = loadRooms()[m[1]];
      if (!room) return json(res, 404, { error: "unknown room" });
      const wait = Math.min(30, Number(url.searchParams.get("wait") ?? 0) || 0);
      const full = url.searchParams.get("full") === "1";
      const { delta, c } = await roomDelta(room, wait);
      const audit = readAudit(room.id);
      const rationale: Record<number, string> = {};
      for (const e of audit) if (e.kind === "send" && e.seq != null && e.rationale) rationale[e.seq] = e.rationale;
      const blocked = audit.filter((e) => e.kind === "blocked").map((e) => ({ at: e.at, type: e.type, body: e.body, reason: e.reason, rationale: e.rationale ?? null }));
      const msgs = full ? c.msgs.map((x, i) => ({ ...x, ok: c.ok[i], errors: [] as string[] })) : delta;
      return json(res, 200, { room: { id: room.id, name: room.name, relay: room.relay, state: c.state }, me: me.pub, names: c.names, msgs, rationale, blocked, chainOk: c.ok.every(Boolean), lastSeq: c.msgs.length ? c.msgs[c.msgs.length - 1].seq : 0 });
    }
    if (url.pathname === "/api/pause" && req.method === "POST") {
      let body = ""; for await (const ch of req) body += ch;
      const on = !!(JSON.parse(body || "{}") as { on?: boolean }).on;
      const p = path.join(HOME, "PAUSED");
      if (on) fs.writeFileSync(p, new Date().toISOString() + "\n"); else if (fs.existsSync(p)) fs.unlinkSync(p);
      return json(res, 200, { paused: isPaused() });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`can2cup viewer for ${me.name} (${me.pub.slice(0, 8)}) — http://127.0.0.1:${port}/   home=${HOME}`);
  startWatcher(me.pub, me.name);
});
