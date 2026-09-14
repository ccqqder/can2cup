/**
 * Telegram adapter (v0.15.0, docs/telegram-adapter.md Phase 1). Bot API webhook: Telegram POSTs every Update to
 * /telegram/webhook with the secret token we gave setWebhook in the X-Telegram-Bot-Api-Secret-Token header; that
 * header IS the verification (a shared secret, compared in constant time — Telegram signs nothing). Privacy mode
 * stays ON: in a group the bot hears /commands, @mentions and replies to its own messages, nothing else — the same
 * shape as the Discord app, and what the Bot Platform terms ask for (§4.3 data minimisation).
 *
 * Timing: Telegram wants a 200 to the webhook (it retries otherwise) but sets no 3 s clock, so the Worker hop
 * (telegramWorkerHop) only does what must be answered at once — answerCallbackQuery to stop a tapped button's
 * spinner, and the "type here" button (`fl:`), which has no modal here and becomes a ForceReply prompt the person
 * answers with a plain reply. Everything else is handed to BridgeDO, which verifies the secret again (the route must
 * be safe on its own) and runs the console.
 *
 * Ids on the bridge side carry the channel: `tg:u:<id>` is a person, `tg:c:<chat id>` a group / supergroup (chat ids
 * are negative for groups and up to 52 bits — always kept as the decimal string Telegram sent). A private chat with the
 * bot is the "dm" place and its id is the person's.
 */
import type { Bubble, Card, Channel, Incoming, Out, Quick, Vocab } from "./channel.js";
import { tr } from "./i18n.js";
import { normLang } from "../protocol/lang.js";

const API = "https://api.telegram.org";
export const TG_USER = "tg:u:";
export const TG_CHAT = "tg:c:";
export const isTelegramId = (id: string | undefined): boolean => !!id && id.startsWith("tg:");
/** Telegram's own limits: 4096 chars per message text, 64 bytes per callback_data, 1024 chars per photo caption. */
const TEXT_MAX = 4000;
const CB_MAX = 64;
const FILL_PROMPT = "✍️ ";
const FILL_NONE = "…"; // v0.17.0: the prompt's "no prefix" marker — the same in every language // the ForceReply prompt starts with this + the prefix; the answer's reply_to_message tells us which

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;      // secret — replies, pushes, name lookups; its "<id>:" prefix is the bot's user id
  TELEGRAM_WEBHOOK_SECRET?: string; // secret — what setWebhook's secret_token was set to; verifies every webhook
  TELEGRAM_BOT_USERNAME?: string;   // var — "can2cup_bot", for t.me deep links and @mention stripping
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Is this request really from Telegram (well: from whoever knows the secret we gave setWebhook)? Constant-time. */
export function telegramVerify(secret: string | undefined, header: (n: string) => string | undefined): boolean {
  const got = header("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || secret.length < 16 || got.length !== secret.length) return false;
  let diff = 0; for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function tgApi(token: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${API}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
}

/** v0.15.0: the Worker-level hop (channels.ts). Verify; stop a tapped button's spinner; turn a "type here" button into
 *  a ForceReply prompt (Telegram has no modal); forward everything the console must see. Always 200 to Telegram once
 *  the secret checks out — anything else makes it redeliver. */
export async function telegramWorkerHop(env: TelegramEnv, header: (n: string) => string | undefined, raw: ArrayBuffer): Promise<{ status: number; response: unknown; forward: boolean }> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return { status: 404, response: { error: "no Telegram bot on this relay (TELEGRAM_WEBHOOK_SECRET unset)" }, forward: false };
  if (!telegramVerify(env.TELEGRAM_WEBHOOK_SECRET, header)) return { status: 401, response: { error: "bad secret" }, forward: false };
  let u: J;
  try { u = JSON.parse(new TextDecoder().decode(raw)); } catch { return { status: 200, response: { ok: true, ignored: "bad json" }, forward: false }; }
  const cq: J | undefined = u?.callback_query;
  if (cq && env.TELEGRAM_BOT_TOKEN) {
    // stop the spinner first; a late answer is a spinner the person stares at for a minute
    try { await tgApi(env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id }); } catch { /* cosmetic */ }
    const data = String(cq.data ?? "");
    if (data.startsWith("fl:")) {
      const prefix = data.slice(3).trim();
      const chatId = cq.message?.chat?.id;
      const L = normLang(cq.from?.language_code) ?? "en"; // v0.17.0: the person's Telegram language
      if (chatId != null) {
        try {
          await tgApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
            chat_id: chatId, text: `${FILL_PROMPT}${prefix || FILL_NONE}\n${tr(L, "（直接回覆這則訊息，打完送出，我會交給你的 agent）")}`,
            reply_markup: { force_reply: true, selective: true, input_field_placeholder: (prefix || tr(L, "內容")).slice(0, 64) },
          });
        } catch { /* the person can still type the command by hand */ }
      }
      return { status: 200, response: { ok: true }, forward: false };
    }
  }
  return { status: 200, response: { ok: true }, forward: true };
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  readonly label = "Telegram";
  readonly idPrefix = "tg:";
  readonly webhookPath = "/telegram/webhook";
  readonly verifyFailStatus = 401;
  readonly vocab: Vocab = { app: "can2cup", chat: "Telegram", group: "群組", pull: "把 can2cup 拉進一個群組,在群組裡打 /status 就能接上", pullShort: "把我拉進一個群組,在群組裡打 /status", groupEn: "Telegram group" }; // i18n-ok: the Chinese words — translated through the catalogs (channel.ts vocabIn)
  readonly canHearGroup = false;   // privacy mode on: commands, @mentions and replies to the bot only
  readonly hasFillIn = true;       // a "type here" button becomes a ForceReply prompt (see telegramWorkerHop)
  readonly initialReplyMs = 60_000; // no reply token to expire: a reply is a sendMessage to the chat
  private names = new Map<string, { v: string | undefined; at: number }>();

  constructor(private env: TelegramEnv, private store?: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; del?(k: string): Promise<void> }) {}

  get enabled(): boolean { return !!this.env.TELEGRAM_BOT_TOKEN; }
  get configured(): boolean { return !!this.env.TELEGRAM_WEBHOOK_SECRET; }
  owns(id: string | undefined): boolean { return isTelegramId(id); }
  /** The bot's own user id is the token's first half ("123456789:…"); no API call needed to recognise itself. */
  private get botId(): string { return (this.env.TELEGRAM_BOT_TOKEN ?? "").split(":")[0]; }
  private get botUser(): string { return (this.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, ""); }
  /** Is this Telegram user the bot itself? By id (from the token) or by username (the var) — the latter is what a relay
   *  without a token (a local dev / the check script) has. */
  private isMe(u: J | undefined): boolean {
    if (!u) return false;
    return (!!this.botId && String(u.id) === this.botId) || (!!this.botUser && typeof u.username === "string" && u.username.toLowerCase() === this.botUser.toLowerCase());
  }

  // ---- inbound ------------------------------------------------------------------------------
  async verify(header: (n: string) => string | undefined): Promise<boolean> { return telegramVerify(this.env.TELEGRAM_WEBHOOK_SECRET, header); }

  /** One Update → one event (or none). A /command becomes the same "/name args" text the LINE console reads, with the
   *  "@bot" suffix Telegram adds in groups removed; a tapped button becomes a postback (`pb:`) or typed text (`tx:`);
   *  a reply to a ForceReply prompt becomes its prefix + the typed text; my_chat_member is follow/unfollow/join/leave. */
  parse(raw: string): Incoming[] {
    // A verified webhook can still be malformed; the console's route runs parse() outside its try, so this never throws.
    try { return this.parseUpdate(raw); } catch (e) { console.error(`telegram parse: ${e instanceof Error ? e.message : String(e)}`); return []; }
  }
  private parseUpdate(raw: string): Incoming[] {
    let u: J;
    try { u = JSON.parse(raw); } catch { return []; }
    if (!u || typeof u !== "object") return [];
    const eventId = u.update_id != null ? `tg:${u.update_id}` : undefined;
    const isObj = (x: unknown): x is J => !!x && typeof x === "object" && !Array.isArray(x);
    const placeOf = (chat: J | undefined, from: J | undefined): Incoming["place"] | null => {
      if (!isObj(chat)) return null;
      const cid = idStr(chat.id); if (!cid) return null;
      const t = String(chat.type ?? "");
      if (t === "private") { const fid = isObj(from) ? idStr(from.id) : undefined; return { channel: "telegram", kind: "dm", id: TG_USER + (fid ?? cid) }; }
      if (t === "group" || t === "supergroup") return { channel: "telegram", kind: "group", id: TG_CHAT + cid };
      return null; // channels (broadcast) are not places the console speaks in
    };
    const nameOf = (from: J | undefined): string | undefined => {
      if (!from) return undefined;
      const n = [from.first_name, from.last_name].filter((x) => typeof x === "string" && x).join(" ");
      return n || (typeof from.username === "string" ? `@${from.username}` : undefined);
    };

    const m: J | undefined = isObj(u.message) ? u.message : undefined;
    if (m) {
      const from: J | undefined = isObj(m.from) ? m.from : undefined;
      if (!from || from.is_bot || !idStr(from.id)) return [];
      const place = placeOf(m.chat, from); if (!place) return [];
      const uid = TG_USER + idStr(from.id);
      { const n = nameOf(from); if (n) this.remember(uid, n); }
      if (place.kind === "group" && typeof m.chat?.title === "string") this.remember(place.id, m.chat.title);
      const base = { channel: "telegram", eventId, replyToken: `${m.chat.id}`, place, userId: uid, text: "", mentioned: false, ...(typeof from.language_code === "string" ? { locale: from.language_code } : {}) };
      // the bot added to / removed from a group arrives as a service message too (my_chat_member below is the reliable one)
      if (Array.isArray(m.new_chat_members) && m.new_chat_members.some((x: J) => this.isMe(x))) return [{ ...base, kind: "join" }];
      if (m.left_chat_member && this.isMe(m.left_chat_member)) return [{ ...base, kind: "leave" }];
      if (typeof m.text !== "string") return place.kind === "group" ? [] : [{ ...base, kind: "media", media: m.photo ? "image" : m.sticker ? "sticker" : m.document ? "file" : m.voice || m.audio ? "audio" : "other" }];
      let text: string = m.text;
      let mentioned = false;
      // strip our own @mention and the "@bot" suffix on commands; note a reply to one of our messages as a mention
      const ents: J[] = Array.isArray(m.entities) ? m.entities.filter(isObj) : [];
      const cut: Array<[number, number]> = [];
      for (const e of ents) {
        if (typeof e.offset !== "number" || typeof e.length !== "number") continue;
        if (e.type === "mention" && this.botUser && text.substr(e.offset, e.length).toLowerCase() === `@${this.botUser.toLowerCase()}`) cut.push([e.offset, e.length]);
        else if (e.type === "text_mention" && this.isMe(e.user)) cut.push([e.offset, e.length]);
      }
      if (cut.length) { mentioned = true; for (const [i, l] of cut.sort((a, b) => b[0] - a[0])) text = text.slice(0, i) + text.slice(i + l); }
      if (this.isMe(m.reply_to_message?.from)) {
        mentioned = true;
        // an answer to a ForceReply prompt: the prompt's first line carries the prefix ("✍️ /a ")
        const prompt = String(m.reply_to_message.text ?? "").split("\n")[0];
        if (prompt.startsWith(FILL_PROMPT)) { const prefix = prompt.slice(FILL_PROMPT.length).trim(); text = prefix === FILL_NONE || prefix === "內容" ? text : `${prefix} ${text}`; } // i18n-ok: "內容" = a prompt sent before 0.17.0
      }
      // "/cmd@somebot": Telegram's way of addressing one bot in a group. Ours → strip the suffix; another bot's → not for us
      // (the review caught that stripping any suffix would run "/pause@other_bot" as our /pause).
      const at = /^(\/[a-z0-9_]+)@([A-Za-z0-9_]+)\b/i.exec(text);
      if (at) {
        if (this.botUser && at[2].toLowerCase() !== this.botUser.toLowerCase()) return [];
        text = text.slice(0, at[1].length) + text.slice(at[0].length);
      }
      text = text.trim();
      // /start [param]: the deep link. "link_ABCD-1234" → /link ABCD-1234, "join_…" → /join …; bare /start = a first hello.
      const st = /^\/start(?:\s+([A-Za-z0-9_-]{1,64}))?$/i.exec(text);
      if (st) {
        const p = st[1] ?? "";
        const dl = /^(link|join)_([A-Za-z0-9-]{1,50})$/i.exec(p);
        if (dl) text = `/${dl[1].toLowerCase()} ${dl[2]}`;
        else if (p.toLowerCase() === "getlink") text = "/link"; // t.me/<bot>?start=getlink — the consent page's one-tap "give me a code"
        else return [{ ...base, kind: "follow" }];
      }
      return [{ ...base, kind: "text", text, mentioned }];
    }

    const cq: J | undefined = isObj(u.callback_query) ? u.callback_query : undefined;
    if (cq) {
      const from: J | undefined = isObj(cq.from) ? cq.from : undefined; if (!from || !idStr(from.id)) return [];
      const place = placeOf(isObj(cq.message) ? cq.message.chat : undefined, from); if (!place) return [];
      const uid = TG_USER + idStr(from.id);
      { const n = nameOf(from); if (n) this.remember(uid, n); }
      const base = { channel: "telegram", eventId, replyToken: `${cq.message?.chat?.id}`, place, userId: uid, text: "", mentioned: place.kind === "group", ...(typeof from.language_code === "string" ? { locale: from.language_code } : {}) };
      const data = String(cq.data ?? "");
      if (data.startsWith("pb:")) return [{ ...base, kind: "postback", postback: data.slice(3) }];
      if (data.startsWith("tx:")) return [{ ...base, kind: "text", text: data.slice(3).trim() }];
      return [{ ...base, kind: "other" }]; // fl: was answered by the Worker hop; anything else is not ours
    }

    const cm: J | undefined = isObj(u.my_chat_member) ? u.my_chat_member : undefined;
    if (cm) {
      const from: J | undefined = isObj(cm.from) ? cm.from : undefined;
      const place = placeOf(cm.chat, from); if (!place) return [];
      const status = String((isObj(cm.new_chat_member) ? cm.new_chat_member.status : "") ?? "");
      const uid = from && idStr(from.id) ? TG_USER + idStr(from.id) : undefined;
      const base = { channel: "telegram", eventId, place, userId: uid, text: "", mentioned: false };
      const inNow = status === "member" || status === "administrator" || status === "creator" || status === "restricted";
      if (place.kind === "dm") return [{ ...base, kind: inNow ? "follow" : "unfollow" }]; // "kicked" = the person blocked the bot
      return [{ ...base, kind: inNow ? "join" : "leave" }];
    }
    return [];
  }

  // ---- outbound -----------------------------------------------------------------------------
  private api(method: string, body: unknown): Promise<Response> { return tgApi(this.env.TELEGRAM_BOT_TOKEN ?? "", method, body); }
  private chatIdOf(to: string): string | undefined {
    if (to.startsWith(TG_CHAT)) return to.slice(TG_CHAT.length);
    if (to.startsWith(TG_USER)) return to.slice(TG_USER.length); // a private chat's id is the person's id
    return undefined;
  }

  /** `replyToken` is the chat id (see parse); a reply is simply a send there. */
  async reply(replyToken: string, msgs: Out[]): Promise<void> {
    if (!this.enabled) throw new Error("telegram: no bot token");
    for (const m of msgs.slice(0, 5)) {
      const r = await this.sendOut(replyToken, m);
      if (!r.ok) throw new Error(`telegram reply ${r.status}: ${r.detail ?? ""}`);
    }
  }

  async push(to: string, msg: { text?: string; quick?: Quick[]; image?: string; sender?: string; card?: Card }): Promise<{ ok: boolean; status: number; detail?: string }> {
    if (!this.enabled) return { ok: false, status: 0, detail: "telegram disabled" };
    const chatId = this.chatIdOf(to);
    if (!chatId) return { ok: false, status: 0, detail: `not a telegram id: ${to.slice(0, 12)}` };
    const out: Out = msg.card ? { card: msg.card, quick: msg.quick } : { text: msg.text ?? "", quick: msg.quick };
    if (!msg.card && !(msg.text ?? "").trim() && !msg.image) return { ok: false, status: 400, detail: "nothing to send" };
    return this.sendOut(chatId, out, msg.sender, msg.image);
  }

  /** Out → 1–5 sendMessage / sendPhoto calls. Text is split on lines under the 4096 limit; chips ride on the last piece. */
  private async sendOut(chatId: string, m: Out, sender?: string, image?: string): Promise<{ ok: boolean; status: number; detail?: string }> {
    const head = sender ? `【${sender.slice(0, 40)}】\n` : "";
    const pieces: string[] = (m.card ? renderCard(m.card).map((t, i) => (i === 0 ? head + t : t)).flatMap(splitText) : splitText(head + (m.text ?? ""))).slice(0, 5);
    const { inline, keys } = this.markup(m);
    try {
      if (image) {
        const caption = pieces[0] ?? "";
        const r = await this.api("sendPhoto", { chat_id: chatId, photo: image, ...(caption ? { caption: caption.slice(0, 1024) } : {}), ...(pieces.length <= 1 && inline ? { reply_markup: inline } : {}) });
        const v = await verdict(r); if (!v.ok) return v;
        if (caption.length > 1024) pieces[0] = caption.slice(1024); else pieces.shift(); // the rest of a long caption is not dropped
      }
      for (let i = 0; i < pieces.length; i++) {
        const last = i === pieces.length - 1;
        const r = await this.api("sendMessage", { chat_id: chatId, text: pieces[i], link_preview_options: { is_disabled: true }, ...(last && inline ? { reply_markup: inline } : last && keys ? { reply_markup: keys } : {}) });
        const v = await verdict(r); if (!v.ok) return v;
      }
      // text chips too long for callback_data ride on a reply keyboard; when an inline keyboard already took the last
      // message, they get a small message of their own rather than being dropped
      if (inline && keys) { const r = await this.api("sendMessage", { chat_id: chatId, text: "⬇️ 接著可以 · Next:", reply_markup: keys }); const v = await verdict(r); if (!v.ok) return v; } // i18n-ok: one small bilingual line; the adapter does not know the language
      return { ok: true, status: 200 };
    } catch (e) { return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) }; }
  }

  /** Buttons: card buttons + chips as an inline keyboard (callback_data ≤ 64 bytes). A text chip too long for that becomes
   *  a one-time reply-keyboard key, which sends its `text` as an ordinary message (Telegram sends the key's text, so the
   *  key IS the text — the label is not used there). Both keyboards may be wanted at once; sendOut places them. */
  private markup(m: Out): { inline?: J; keys?: J } {
    const inline: J[] = []; const keys: J[] = []; const seen = new Set<string>();
    const addInline = (label: string, data: string) => { if (seen.has(data) || inline.length >= 12) return; seen.add(data); inline.push({ text: label.slice(0, 40) || "…", callback_data: data }); };
    for (const b of m.card?.bubbles ?? []) for (const x of b.buttons ?? []) { const d = `pb:${x.data}`; if (bytes(d) <= CB_MAX) addInline(x.label, d); }
    for (const q of m.quick ?? []) {
      const d = q.fill != null ? `fl:${q.fill}` : q.text != null ? `tx:${q.text}` : `pb:${q.data ?? ""}`;
      if (bytes(d) <= CB_MAX) addInline(q.label, d);
      else if (q.text != null && keys.length < 8) keys.push({ text: q.text.slice(0, 256) });
    }
    return {
      ...(inline.length ? { inline: { inline_keyboard: rows(inline, 2) } } : {}),
      ...(keys.length ? { keys: { keyboard: rows(keys, 2), resize_keyboard: true, one_time_keyboard: true } } : {}),
    };
  }

  // ---- lookups ------------------------------------------------------------------------------
  private remember(key: string, v: string | undefined): void { if (this.names.size > 2000) this.names.clear(); this.names.set(key, { v, at: Date.now() }); }
  private cached(key: string): { hit: boolean; v?: string } { const h = this.names.get(key); return h && Date.now() - h.at < 6 * 3600_000 ? { hit: true, v: h.v } : { hit: false }; }
  async userName(userId: string): Promise<string | undefined> {
    const c = this.cached(userId); if (c.hit) return c.v;
    let v: string | undefined;
    const id = this.chatIdOf(userId);
    if (this.enabled && id && userId.startsWith(TG_USER)) {
      try { const r = await this.api("getChat", { chat_id: id }); if (r.ok) { const j = ((await r.json()) as J).result ?? {}; v = [j.first_name, j.last_name].filter(Boolean).join(" ") || (j.username ? `@${j.username}` : undefined); } } catch { /* decoration */ }
    }
    this.remember(userId, v);
    return v;
  }
  async groupName(groupId: string): Promise<string | undefined> {
    const c = this.cached(groupId); if (c.hit) return c.v;
    let v: string | undefined;
    const id = this.chatIdOf(groupId);
    if (this.enabled && id && groupId.startsWith(TG_CHAT)) {
      try { const r = await this.api("getChat", { chat_id: id }); if (r.ok) { const j = ((await r.json()) as J).result ?? {}; v = typeof j.title === "string" ? j.title : undefined; } } catch { /* decoration */ }
    }
    this.remember(groupId, v);
    return v;
  }
  /** https://t.me/<bot>?start=<param> — only a short "/link CODE" or "/join CODE" fits the 64-char [A-Za-z0-9_-] payload;
   *  anything else has no prefilled-chat link and the bridge falls back to posting the bare code. */
  deepLink(message: string): string | undefined {
    if (!this.botUser) return undefined;
    const m = /^\/(link|join)\s+([A-Za-z0-9-]{1,50})$/i.exec(message.trim());
    return m ? `https://t.me/${this.botUser}?start=${m[1].toLowerCase()}_${m[2]}` : undefined;
  }
}

// ---- helpers -----------------------------------------------------------------------------------
/** A Telegram id as the decimal string it was sent as (numbers up to 52 bits, or already a string); anything else is not an id. */
const idStr = (x: unknown): string | undefined => typeof x === "number" && Number.isSafeInteger(x) ? String(x) : typeof x === "string" && /^-?\d{1,20}$/.test(x) ? x : undefined;
const bytes = (s: string): number => new TextEncoder().encode(s).length;
function rows<T>(items: T[], per: number): T[][] { const out: T[][] = []; for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per)); return out; }
async function verdict(r: Response): Promise<{ ok: boolean; status: number; detail?: string }> {
  if (r.ok) return { ok: true, status: 200 };
  let detail = "";
  try { const j = (await r.json()) as J; detail = String(j.description ?? ""); if (r.status === 429 && j.parameters?.retry_after != null) detail = `retry_after ${j.parameters.retry_after}s: ${detail}`; } catch { /* no body */ }
  return { ok: false, status: r.status, detail: detail.slice(0, 200) };
}
function splitText(text: string): string[] {
  const s = text.length ? text : " ";
  if (s.length <= TEXT_MAX) return [s];
  const out: string[] = []; let cur = "";
  for (const line of s.split("\n")) {
    // a single line longer than a message is cut into message-sized pieces, none of it dropped
    const pieces: string[] = []; for (let i = 0; i < line.length; i += TEXT_MAX) pieces.push(line.slice(i, i + TEXT_MAX));
    for (const piece of pieces.length ? pieces : [""]) {
      if (cur && cur.length + 1 + piece.length > TEXT_MAX) { out.push(cur); cur = piece; } else cur = cur ? `${cur}\n${piece}` : piece;
      if (out.length >= 5) return out; // five messages at most, as the other channels do
    }
  }
  if (cur && out.length < 5) out.push(cur);
  return out;
}
/** A card, in plain text: one message per bubble (at most 5), the plain twin's structure kept line by line. */
function renderCard(card: Card): string[] {
  const bubbles = card.bubbles.slice(0, 5);
  if (!bubbles.length) return [card.alt];
  return bubbles.map((b: Bubble) => [
    b.title, b.sub,
    ...(b.rows ?? []).map((r) => `${r.dot} ${r.who}${r.right ? `  ${r.right}` : ""}`),
    ...(b.notes ?? []),
  ].filter((x) => x && x.trim()).join("\n"));
}
