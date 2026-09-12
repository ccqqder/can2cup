/**
 * Principal notification. The viewer is the principal's "phone app": while it runs it
 * watches every open room (its own cursor, independent of the UI) and the local audit
 * log, and pushes one line per event to a webhook.
 *
 *   CAN2CUP_NOTIFY_URL    where to POST. Recognised shapes:
 *                          https://ntfy.sh/<topic>                       → plain-text POST with a Title header
 *                          https://api.telegram.org/bot<t>/sendMessage?chat_id=<id>  → JSON {chat_id,text}
 *                          anything else                                  → JSON {title,text,room,type,from}
 *   CAN2CUP_NOTIFY_TYPES  comma list of inbound types to push (default: question,proposal,counter,accept,
 *                        grant,revoke,escalate,attachment,close). Blocked attempts and your own agent's
 *                        `escalate` are always pushed — those are the moments the principal must act.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME, loadRooms, type LocalRoom } from "../mcp/state.js";
import { relay } from "../mcp/relay-client.js";
import type { Envelope } from "../protocol/index.js";
import { settlePrice } from "../protocol/index.js";

const URL_ = process.env.CAN2CUP_NOTIFY_URL ?? process.env.CAN2CAN_NOTIFY_URL ?? process.env.PARLEY_NOTIFY_URL ?? "";
const TYPES = new Set((process.env.CAN2CUP_NOTIFY_TYPES ?? process.env.CAN2CAN_NOTIFY_TYPES ?? process.env.PARLEY_NOTIFY_TYPES ?? "question,proposal,counter,accept,grant,revoke,escalate,attachment,close,mechanism").split(",").map((s) => s.trim()).filter(Boolean));

export const notifyEnabled = !!URL_;

export async function push(title: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!URL_) return;
  try {
    if (/ntfy\.sh|\/ntfy/.test(URL_)) {
      await fetch(URL_, { method: "POST", headers: { Title: title.replace(/[^\x20-\x7e]/g, "?"), Tags: "speech_balloon" }, body: `${title}\n${text}` });
    } else if (URL_.includes("api.telegram.org")) {
      const u = new URL(URL_);
      const chat_id = u.searchParams.get("chat_id");
      u.search = "";
      await fetch(u.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id, text: `${title}\n${text}` }) });
    } else {
      await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, text, ...extra }) });
    }
  } catch (e) {
    console.error("notify failed:", e instanceof Error ? e.message : e);
  }
}

function summarize(m: Envelope): string {
  const b = (m.body ?? {}) as Record<string, unknown>;
  if (m.type === "mechanism") return summarizeMech(b);
  const bits = [typeof b.text === "string" ? b.text.slice(0, 200) : JSON.stringify(b).slice(0, 200)];
  if (b.amount != null) bits.push(`amount ${b.amount}`);
  if (m.type === "grant") bits.push(`scope ${b.scope} until ${b.expires}`);
  if (m.type === "attachment") bits.push(String(b.url ?? ""));
  return bits.join(" · ");
}

/** Sealed-bid phases in the principal's words — never the raw bid, which is only public once revealed. */
function summarizeMech(b: Record<string, unknown>): string {
  const phase = String(b.phase ?? "");
  if (phase === "open") return `對方開了密封競價(${b.side === "sell" ? "賣方" : "買方"}開局,k=${b.k ?? 0.5})——你要出一個隱藏的價`;
  if (phase === "commit") return `對方已密封出價(數字隱藏,雙方都出完才會同時揭曉)`;
  if (phase === "reveal") return `對方揭曉了出價:${b.bid}`;
  return JSON.stringify(b).slice(0, 200);
}

/** Independent settlement watch, so this principal is told "成交 X" the moment the pair completes — no matter
 *  which side revealed last. Keyed by room+open; folds open (for k) then the two reveals. Mirrors the viewer's
 *  client-side noteMech, kept dependency-light rather than pulling the full history for resolveMechanism. */
type MechState = { k: number; bids: Partial<Record<"buy" | "sell", number>>; done: boolean };
const mechs = new Map<string, MechState>();
function noteMechSettle(room: string, m: Envelope): { deal: boolean; price: number | null } | null {
  const b = (m.body ?? {}) as Record<string, unknown>;
  const phase = String(b.phase ?? "");
  if (phase === "open") {
    mechs.set(`${room}:${m.seq}`, { k: typeof b.k === "number" ? b.k : 0.5, bids: {}, done: false });
    return null;
  }
  if (phase !== "reveal") return null;
  const key = `${room}:${b.ref ?? ""}`;
  const st = mechs.get(key) ?? { k: 0.5, bids: {}, done: false };
  mechs.set(key, st);
  const side = b.side === "sell" ? "sell" : "buy";
  if (typeof b.bid === "number") st.bids[side] = b.bid;
  if (st.done || st.bids.buy === undefined || st.bids.sell === undefined) return null;
  st.done = true;
  return settlePrice(st.bids.buy, st.bids.sell, st.k);
}

/** Start the watcher. Cursors begin at each room's current lastSeq so a restart does not replay history. */
export function startWatcher(mePub: string, myName: string): void {
  if (!URL_) return;
  const cursors = new Map<string, number>();
  for (const r of Object.values(loadRooms())) cursors.set(r.id, r.lastSeq);
  let auditPos = 0;
  try { auditPos = fs.statSync(path.join(HOME, "audit.jsonl")).size; } catch { /* none yet */ }
  console.log(`notify → ${URL_.replace(/bot[^/]+/, "bot***")}  types=${[...TYPES].join(",")}`);

  const tickRooms = async () => {
    const rooms = Object.values(loadRooms()).filter((r) => r.state === "open");
    await Promise.all(rooms.map(async (room: LocalRoom) => {
      const since = cursors.get(room.id) ?? room.lastSeq;
      try {
        const res = await relay.poll(room.relay, room.id, room.cap ?? room.secret, since, 0);
        let last = since;
        for (const m of res.messages) {
          last = m.seq;
          // Settlement must be tracked across BOTH sides' reveals, our own included — so feed the tracker
          // before the own-sender / type filters below, and push "成交" once the pair completes.
          if (m.type === "mechanism") {
            const s = noteMechSettle(room.id, m);
            if (s) await push(`can2cup · ${room.name || room.id} · 密封競價`, s.deal ? `成交:${s.price}` : `無成交(買方低於賣方)`, { room: room.id, seq: m.seq, type: "mechanism-settled" });
          }
          if (m.from === mePub || m.from === "relay" || !TYPES.has(m.type)) continue;
          await push(`can2cup · ${room.name || room.id} · ${m.type}`, summarize(m), { room: room.id, seq: m.seq, type: m.type, from: m.from });
        }
        cursors.set(room.id, last);
      } catch { /* relay hiccup; try next tick */ }
    }));
  };
  const tickAudit = async () => {
    const p = path.join(HOME, "audit.jsonl");
    if (!fs.existsSync(p)) return;
    const size = fs.statSync(p).size;
    if (size <= auditPos) return;
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(size - auditPos);
    fs.readSync(fd, buf, 0, buf.length, auditPos);
    fs.closeSync(fd);
    auditPos = size;
    for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line) as { kind: string; room?: string; type?: string; reason?: string; body?: { text?: string } };
        if (e.kind === "blocked") await push(`can2cup · ${myName}'s agent BLOCKED (${e.type})`, `${e.reason ?? ""}\n${e.body?.text ?? ""}`.slice(0, 300), { room: e.room, kind: "blocked" });
        else if (e.kind === "send" && e.type === "escalate") await push(`can2cup · ${myName}'s agent needs you`, (e.body?.text ?? "").slice(0, 300), { room: e.room, kind: "escalate" });
      } catch { /* skip */ }
    }
  };
  const loop = async () => {
    await tickRooms();
    await tickAudit();
    setTimeout(loop, 8000);
  };
  void loop();
}
