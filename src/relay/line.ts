/**
 * LINE adapter (v0.12.0). The LINE Messaging API webhook used to be owned by the `lilinene` Flask bot on Render;
 * it now terminates here, in the Worker, and the bridge is called in-process. What this file knows about LINE:
 * the webhook signature (HMAC-SHA256 over the raw body, base64, `x-line-signature`), the event shapes, the
 * reply / push / profile / group-summary / rich-menu / mark-as-read endpoints, and how a Card becomes Flex.
 * Nothing about bindings, inboxes or quotas — that is the bridge's, whatever the channel.
 */
import { lineDeepLink } from "../protocol/index.js";
import type { Bubble, Card, Channel, Incoming, Out, Quick, Vocab } from "./channel.js";

const API = "https://api.line.me/v2/bot";
const GREY = "#8a8478";

export interface LineEnv {
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_OA_ID?: string;
  PUSH_BUDGET?: string;       // v0.15.1: this channel's monthly push allowance (LINE free plan: 200; default 180)
  LINE_MENU_CONSOLE?: string; // rich menu name prefix for bound users; default lilinene-menu-console
  LINE_MENU_ONBOARD?: string; // … for everyone else; default lilinene-menu-onboard
}

/** Rich-menu ids and per-user menu state are cached by the caller (the DO) — the adapter is stateless apart from
 *  short in-memory name caches, which a DO eviction simply empties. */
export class LineChannel implements Channel {
  readonly name = "line";
  readonly label = "LINE";
  readonly idPrefix = "";           // bare ids (U… / C… / R…): nothing stored before the channel layer moves
  readonly webhookPath = "/line/webhook";
  readonly verifyFailStatus = 400;
  readonly vocab: Vocab = { app: "傳聲罐罐", chat: "LINE", group: "群", pull: "把傳聲罐罐拉進一個群,在群裡打 /status 就能接上", pullShort: "把我拉進一個群,在群裡打 /status", groupEn: "LINE group" }; // i18n-ok: the Chinese words — translated through the catalogs (channel.ts vocabIn)
  readonly canHearGroup = true;
  readonly hasFillIn = true;
  readonly initialReplyMs = 60_000;
  private names = new Map<string, { v: string | undefined; at: number }>();
  private menuIds: { at: number; ids: Record<string, string> } | null = null;
  private markReadOk = true;

  constructor(private env: LineEnv, private store?: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> }) {}

  get enabled(): boolean { return !!this.env.LINE_CHANNEL_ACCESS_TOKEN; }
  get configured(): boolean { return !!this.env.LINE_CHANNEL_SECRET; }
  get monthlyBudget(): number { return Math.max(1, Number(this.env.PUSH_BUDGET ?? 180) || 180); }
  owns(id: string | undefined): boolean { return !!id && !id.includes(":"); }

  // ---- inbound ------------------------------------------------------------------------------
  async verify(header: (n: string) => string | undefined, raw: ArrayBuffer): Promise<boolean> {
    const secret = this.env.LINE_CHANNEL_SECRET;
    const sig = header("x-line-signature") ?? "";
    if (!secret || !sig) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
    let b64 = ""; for (const b of mac) b64 += String.fromCharCode(b);
    const expect = btoa(b64);
    if (expect.length !== sig.length) return false;
    let diff = 0; for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  }

  parse(raw: string): Incoming[] {
    let body: { events?: unknown[] } = {};
    try { body = JSON.parse(raw); } catch { return []; }
    const out: Incoming[] = [];
    for (const e of (Array.isArray(body.events) ? body.events : []) as Array<Record<string, unknown>>) {
      const src = (e.source ?? {}) as { type?: string; userId?: string; groupId?: string; roomId?: string };
      const gid = src.type === "group" ? src.groupId : src.type === "room" ? src.roomId : undefined;
      const place = gid ? { channel: "line", kind: "group" as const, id: gid } : { channel: "line", kind: "dm" as const, id: src.userId ?? "" };
      const base = { channel: "line", eventId: typeof e.webhookEventId === "string" ? e.webhookEventId : undefined, replyToken: typeof e.replyToken === "string" ? e.replyToken : undefined, place, userId: src.userId, text: "", mentioned: false };
      const t = e.type;
      if (t === "message") {
        const m = (e.message ?? {}) as { type?: string; text?: string; mention?: { mentionees?: Array<{ index: number; length: number; isSelf?: boolean }> } };
        if (m.type === "text") {
          let text = m.text ?? "";
          const spans = (m.mention?.mentionees ?? []).filter((x) => x.isSelf).map((x) => [x.index, x.length] as [number, number]);
          for (const [i, l] of spans.sort((a, b) => b[0] - a[0])) text = text.slice(0, i) + text.slice(i + l);
          out.push({ ...base, kind: "text", text: text.trim(), mentioned: spans.length > 0 });
        } else out.push({ ...base, kind: "media", media: m.type ?? "other" });
      } else if (t === "postback") {
        const p = (e.postback ?? {}) as { data?: string };
        out.push({ ...base, kind: "postback", postback: p.data ?? "" });
      } else if (t === "follow") out.push({ ...base, kind: "follow" });
      else if (t === "unfollow") out.push({ ...base, kind: "unfollow" });
      else if (t === "join") out.push({ ...base, kind: "join" });
      else if (t === "leave") out.push({ ...base, kind: "leave" });
      else out.push({ ...base, kind: "other" });
    }
    return out;
  }

  // ---- outbound -----------------------------------------------------------------------------
  private async api(path: string, body?: unknown, method = "POST"): Promise<Response> {
    return fetch(`${API}${path}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN ?? ""}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
  }

  private quickReply(items: Quick[] | undefined): { items: unknown[] } | undefined {
    if (!items?.length) return undefined;
    return { items: items.slice(0, 13).map((q) => ({ type: "action", action: q.fill
      ? { type: "postback", label: q.label.slice(0, 20), data: q.data ?? "parley:fill", inputOption: "openKeyboard", fillInText: q.fill.slice(0, 300) }
      : q.text != null
        ? { type: "message", label: q.label.slice(0, 20), text: q.text.slice(0, 300) }
        : { type: "postback", label: q.label.slice(0, 20), data: (q.data ?? "").slice(0, 300), displayText: q.label.slice(0, 20) } })) };
  }

  /** Out[] → LINE message objects (max 5). Chips ride on the last one. A card that fails to build falls back to its alt. */
  private messages(msgs: Out[], sender?: string): unknown[] {
    const list = msgs.slice(0, 5);
    return list.map((m, i) => {
      const quickReply = i === list.length - 1 ? this.quickReply(m.quick) : undefined;
      const who = sender ? { sender: { name: sender.slice(0, 20) } } : {};
      if (m.card) {
        try { return { type: "flex", altText: m.card.alt.slice(0, 400) || " ", contents: flex(m.card), ...(quickReply ? { quickReply } : {}), ...who }; }
        catch { return { type: "text", text: m.card.alt.slice(0, 4900), ...(quickReply ? { quickReply } : {}), ...who }; }
      }
      return { type: "text", text: (m.text ?? "").slice(0, 4900) || " ", ...(quickReply ? { quickReply } : {}), ...who };
    });
  }

  async reply(replyToken: string, msgs: Out[]): Promise<void> {
    const r = await this.api("/message/reply", { replyToken, messages: this.messages(msgs) });
    if (!r.ok) throw new Error(`line reply ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  async push(to: string, msg: { text?: string; quick?: Quick[]; image?: string; sender?: string; card?: Card }): Promise<{ ok: boolean; status: number; detail?: string }> {
    const messages: unknown[] = [];
    if (msg.image) messages.push({ type: "image", originalContentUrl: msg.image, previewImageUrl: msg.image, ...(msg.sender ? { sender: { name: msg.sender.slice(0, 20) } } : {}) });
    if (msg.card) messages.push(...this.messages([{ card: msg.card, quick: msg.quick }], msg.sender));
    else if (msg.text) messages.push(...this.messages([{ text: msg.text, quick: msg.quick }], msg.sender));
    if (!messages.length) return { ok: false, status: 400, detail: "nothing to send" };
    try {
      const r = await this.api("/message/push", { to, messages });
      return { ok: r.ok, status: r.status, ...(r.ok ? {} : { detail: (await r.text()).slice(0, 200) }) };
    } catch (e) { return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) }; }
  }

  // ---- lookups ------------------------------------------------------------------------------
  private async cachedName(key: string, path: string, field: string): Promise<string | undefined> {
    const hit = this.names.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.v;
    let v: string | undefined;
    if (this.enabled) {
      try { const r = await this.api(path, undefined, "GET"); if (r.ok) v = ((await r.json()) as Record<string, unknown>)[field] as string | undefined; }
      catch { /* names are decoration */ }
    }
    if (this.names.size > 2000) this.names.clear();
    this.names.set(key, { v, at: Date.now() });
    return v;
  }
  userName(userId: string, groupId?: string): Promise<string | undefined> {
    return groupId
      ? this.cachedName(`u:${groupId}:${userId}`, `/group/${groupId}/member/${userId}`, "displayName")
      : this.cachedName(`u:${userId}`, `/profile/${userId}`, "displayName");
  }
  groupName(groupId: string): Promise<string | undefined> { return this.cachedName(`g:${groupId}`, `/group/${groupId}/summary`, "groupName"); }
  deepLink(message: string): string | undefined { return this.env.LINE_OA_ID ? lineDeepLink(this.env.LINE_OA_ID, message) : undefined; }

  // ---- rich menu (per-user console / onboard) ------------------------------------------------
  private async menuId(which: "console" | "onboard"): Promise<string | undefined> {
    const prefix = which === "console" ? (this.env.LINE_MENU_CONSOLE ?? "lilinene-menu-console") : (this.env.LINE_MENU_ONBOARD ?? "lilinene-menu-onboard");
    if (!this.menuIds || Date.now() - this.menuIds.at > 3600_000) {
      const ids: Record<string, string> = {};
      try {
        const r = await this.api("/richmenu/list", undefined, "GET");
        if (r.ok) for (const m of (((await r.json()) as { richmenus?: Array<{ richMenuId: string; name: string }> }).richmenus ?? [])) {
          for (const p of [this.env.LINE_MENU_CONSOLE ?? "lilinene-menu-console", this.env.LINE_MENU_ONBOARD ?? "lilinene-menu-onboard"]) if (m.name.startsWith(p) && !ids[p]) ids[p] = m.richMenuId;
        }
      } catch { /* menus are decoration */ }
      this.menuIds = { at: Date.now(), ids };
    }
    return this.menuIds.ids[prefix];
  }
  /** Link the user's menu. A stale cached id (menus were redeployed) makes LINE answer 404 → refresh once and retry. */
  async setMenu(userId: string, which: "console" | "onboard"): Promise<void> {
    if (!this.enabled) return;
    const cur = await this.store?.get<string>(`line:menu:${userId}`);
    if (cur === which) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await this.menuId(which);
      if (!id) return;
      try {
        const r = await this.api(`/user/${userId}/richmenu/${id}`, {});
        if (r.ok) { await this.store?.put(`line:menu:${userId}`, which); return; }
        if (r.status === 404 && attempt === 0) { this.menuIds = null; continue; }
        return;
      } catch { return; }
    }
  }

  async markRead(userId: string): Promise<void> {
    if (!this.enabled || !this.markReadOk) return;
    try {
      const r = await this.api("/message/markAsRead", { chat: { userId } });
      if ([400, 403, 404].includes(r.status)) this.markReadOk = false; // this account cannot; stop asking
    } catch { /* decoration */ }
  }
}

// ---- Card → Flex ------------------------------------------------------------------------------
function ftext(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "text", text: String(text).slice(0, 200) || " ", wrap: true, ...extra };
}
function bubble(b: Bubble): Record<string, unknown> {
  const body: unknown[] = [ftext(b.title, { weight: "bold", size: "lg" }), ftext(b.sub, { size: "xs", color: GREY })];
  if (b.rows?.length || b.notes?.length) body.push({ type: "separator", margin: "md" });
  for (const r of b.rows ?? []) body.push({ type: "box", layout: "horizontal", margin: "sm", contents: [ftext(`${r.dot} ${r.who}`, { size: "sm", flex: 3 }), ftext(r.right, { size: "sm", color: GREY, flex: 4, align: "end" })] });
  for (const n of b.notes ?? []) body.push(ftext(n, { size: b.rows?.length ? "xs" : "sm", color: b.rows?.length ? GREY : undefined, margin: "md" }));
  const out: Record<string, unknown> = { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", contents: body } };
  if (b.buttons?.length) out.footer = { type: "box", layout: "vertical", spacing: "sm", contents: b.buttons.map((x) => ({ type: "button", style: x.primary ? "primary" : "secondary", height: "sm", action: { type: "postback", label: x.label.slice(0, 20), data: x.data, displayText: x.label.slice(0, 20) } })) };
  return out;
}
export function flex(card: Card): Record<string, unknown> {
  const bs = card.bubbles.slice(0, 12).map(bubble);
  if (!bs.length) throw new Error("empty card");
  return bs.length === 1 ? bs[0] : { type: "carousel", contents: bs };
}
