/**
 * Discord adapter (v0.12.1). HTTP-only: Discord POSTs every interaction — slash command, button, modal — to
 * /discord/interactions, signed with the app's Ed25519 key. Nothing listens on the gateway, so the app hears no
 * ordinary message and needs no privileged intent; every input is an explicit command or a tap.
 *
 * Timing is the whole design: Discord wants an answer within 3 s, and a Durable Object may sit in another region.
 * So the Worker (index.ts) verifies and answers on the spot — PONG, a modal, or "deferred" (type 5, the "thinking…"
 * bubble) — and hands the verified bytes to BridgeDO, which runs the console and fills the deferred reply in through
 * the interaction webhook (valid 15 min). Pushes at the bot's own initiative go through the bot token: a channel
 * message, or a DM channel opened once per person and remembered in the DO.
 *
 * Ids on the bridge side carry the channel: `discord:u:<snowflake>` is a person, `discord:c:<snowflake>` a channel
 * (the "group"). LINE ids stay bare, so nothing stored before this adapter moves. A Discord place is a "group" when
 * the interaction came from a guild channel or a group DM; `cannotPost` marks a guild that installed the app for a
 * user only (no bot member) — the app can answer the interaction, but cannot post there on its own.
 */
import { verifyHex } from "../protocol/index.js";
import type { Bubble, Card, Channel, Incoming, Out, Quick, Vocab } from "./channel.js";
import { tr } from "./i18n.js";
import { normLang } from "../protocol/lang.js";

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://github.com/ccqqder/can2cup, 0.12.1)"; // Discord's required form: (url, version) — the project, not one relay
const COLOR = 0xb5541c;
export const DISCORD_USER = "discord:u:";
export const DISCORD_CHANNEL = "discord:c:";
export const isDiscordId = (id: string | undefined): boolean => !!id && id.startsWith("discord:");
// VIEW_CHANNEL 1024 + SEND_MESSAGES 2048 + EMBED_LINKS 16384 + ATTACH_FILES 32768 + READ_MESSAGE_HISTORY 65536
const BOT_PERMISSIONS = "117760";
/** Where someone installs the app. Spell the scopes out rather than leaving Discord to read them off the app's own
 *  config: the bare client_id link renders "Add to My Apps"/"Add to Server" from stored install params, and a client
 *  that fails to parse them shows a crash page instead of the consent screen. `guild` picks the server install. */
export const installUrl = (appId: string, guild = false): string =>
  guild
    ? `https://discord.com/oauth2/authorize?client_id=${appId}&integration_type=0&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`
    : `https://discord.com/oauth2/authorize?client_id=${appId}&integration_type=1&scope=applications.commands`;

export interface DiscordEnv {
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string; // hex, from the Developer Portal — verifies every interaction
  DISCORD_BOT_TOKEN?: string;  // secret — pushes, name lookups, opening DMs
}

// Interaction types and response types (Discord API v10).
const T_PING = 1, T_COMMAND = 2, T_COMPONENT = 3, T_AUTOCOMPLETE = 4, T_MODAL = 5;
const R_PONG = 1, R_DEFER = 5, R_AUTOCOMPLETE = 8, R_MODAL = 9;
const BTN_PRIMARY = 1, BTN_SECONDARY = 2, BTN_SUCCESS = 3, BTN_DANGER = 4;
const ZWSP = "​";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Is this request really from Discord? Ed25519 over `timestamp + body`, headers X-Signature-Ed25519 / -Timestamp. */
export async function discordVerify(publicKeyHex: string | undefined, header: (n: string) => string | undefined, raw: ArrayBuffer): Promise<boolean> {
  const sig = header("x-signature-ed25519") ?? "";
  const ts = header("x-signature-timestamp") ?? "";
  if (!publicKeyHex || !/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(sig) || !/^\d{1,20}$/.test(ts)) return false;
  try { return verifyHex(sig, ts + new TextDecoder().decode(raw), publicKeyHex); } catch { return false; }
}

/** What the Worker answers before the DO has looked (Discord's 3 s clock is ticking): PONG for the endpoint check,
 *  an empty autocomplete, a modal for a "type here" button (a modal must be the first response), otherwise the
 *  deferred acknowledgement — and `forward: true` means the DO should now do the work and fill it in. */
/** v0.15.0: the Worker-level hop, as the registry (channels.ts) sees it — verify, then answer what can be answered
 *  before the DO has looked, and say whether the DO should see the bytes at all. */
export async function discordWorkerHop(env: DiscordEnv, header: (n: string) => string | undefined, raw: ArrayBuffer): Promise<{ status: number; response: unknown; forward: boolean }> {
  if (!env.DISCORD_PUBLIC_KEY) return { status: 404, response: { error: "no Discord app on this relay (DISCORD_PUBLIC_KEY unset)" }, forward: false };
  if (!(await discordVerify(env.DISCORD_PUBLIC_KEY, header, raw))) return { status: 401, response: { error: "bad signature" }, forward: false };
  return discordImmediate(new TextDecoder().decode(raw));
}
export function discordImmediate(bodyText: string): { status: number; response: unknown; forward: boolean } {
  let b: J;
  try { b = JSON.parse(bodyText); } catch { return { status: 400, response: { error: "bad json" }, forward: false }; }
  if (!b || typeof b !== "object") return { status: 400, response: { error: "bad body" }, forward: false };
  if (b.type === T_PING) return { status: 200, response: { type: R_PONG }, forward: false };
  if (b.type === T_AUTOCOMPLETE) return { status: 200, response: { type: R_AUTOCOMPLETE, data: { choices: [] } }, forward: false };
  if (b.type === T_COMPONENT) {
    const id = String(b.data?.custom_id ?? "");
    if (id.startsWith("fl:")) {
      const prefix = id.slice(3).trim();
      const L = normLang(b.locale) ?? "en"; // v0.17.0: the interaction's own locale; the DO's stored language is not known here
      return { status: 200, forward: false, response: { type: R_MODAL, data: {
        custom_id: `modal:${prefix}`.slice(0, 100), title: tr(L, "對 agent 說一句"),
        components: [{ type: 1, components: [{ type: 4, custom_id: "text", style: 2, label: (prefix || tr(L, "內容")).slice(0, 45), placeholder: tr(L, "打完按送出，我會交給你的 agent"), required: true, max_length: 1900 }] }],
      } } };
    }
  }
  if (b.type === T_COMMAND || b.type === T_COMPONENT || b.type === T_MODAL) return { status: 200, response: { type: R_DEFER }, forward: true };
  return { status: 400, response: { error: "unknown interaction type" }, forward: false };
}

export class DiscordChannel implements Channel {
  readonly name = "discord";
  readonly label = "Discord";
  readonly idPrefix = "discord:";
  readonly webhookPath = "/discord/interactions";
  readonly verifyFailStatus = 401;
  readonly vocab: Vocab = { app: "can2cup", chat: "Discord", group: "伺服器頻道", pull: "把 can2cup 裝進一個伺服器,在頻道裡打 /status 就能接上", pullShort: "把 can2cup 裝進伺服器,在頻道裡打 /status", groupEn: "Discord channel" }; // i18n-ok: the Chinese words — translated through the catalogs (channel.ts vocabIn)
  readonly canHearGroup = false;   // HTTP-only: no gateway, no message events
  readonly hasFillIn = true;       // a "type here" button opens a modal (see discordImmediate)
  readonly initialReplyMs = 3000;
  private names = new Map<string, { v: string | undefined; at: number }>();

  constructor(private env: DiscordEnv, private store?: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; del?(k: string): Promise<void> }) {}

  get enabled(): boolean { return !!this.env.DISCORD_BOT_TOKEN && !!this.env.DISCORD_APPLICATION_ID; }
  get configured(): boolean { return !!this.env.DISCORD_PUBLIC_KEY; }
  installUrl(guild = false): string | undefined { return this.env.DISCORD_APPLICATION_ID ? installUrl(this.env.DISCORD_APPLICATION_ID, guild) : undefined; }
  owns(id: string | undefined): boolean { return isDiscordId(id); }
  /** A server that has the app only as a user install — the bot cannot post there later, so wiring, /a and the rest
   *  would silently fail at the first push. Say what to do instead; /help still helps. (Moved here from the bridge in
   *  v0.15.0: the words are Discord's, so the adapter owns them.) */
  installHint(L: string): string {
    const url = this.installUrl(true);
    return tr(L, "這個伺服器還沒把 can2cup 裝進來（目前只裝在你個人帳號上），我在這裡回得了你，但之後貼不了訊息，所以群組功能先不開。\n請伺服器管理員用安裝連結把 can2cup 加進伺服器（選「Add to Server」），再回來打 /status。{url}\n私訊我的話，所有 1 對 1 功能都能用。", { url: url ? `\n${url}` : "" });
  }

  // ---- inbound ------------------------------------------------------------------------------
  verify(header: (n: string) => string | undefined, raw: ArrayBuffer): Promise<boolean> { return discordVerify(this.env.DISCORD_PUBLIC_KEY, header, raw); }

  /** One interaction → one event. A slash command becomes the same "/name args" text the LINE console reads; a
   *  button becomes a postback (`pb:`) or typed text (`tx:`); a modal submit becomes its prefix + the typed text. */
  parse(raw: string): Incoming[] {
    let b: J;
    try { b = JSON.parse(raw); } catch { return []; }
    if (!b || typeof b !== "object") return [];
    const t = b.type;
    if (t !== T_COMMAND && t !== T_COMPONENT && t !== T_MODAL) return [];
    const user: J = b.member?.user ?? b.user ?? {};
    if (!user.id) return [];
    const uid = DISCORD_USER + String(user.id);
    const shown = b.member?.nick ?? user.global_name ?? user.username;
    if (typeof shown === "string" && shown) this.remember(uid, shown);
    // context: 0 = a guild channel, 1 = the bot's DM, 2 = a group DM / a channel the bot is not a member of
    const inGroup = !!b.guild_id || b.context === 2;
    const cid = String(b.channel_id ?? b.channel?.id ?? "");
    const place: Incoming["place"] = inGroup && cid ? { channel: "discord", kind: "group", id: DISCORD_CHANNEL + cid } : { channel: "discord", kind: "dm", id: uid };
    if (inGroup && typeof b.channel?.name === "string" && b.channel.name) this.remember(DISCORD_CHANNEL + cid, `#${b.channel.name}`);
    const owners: J = b.authorizing_integration_owners ?? {};
    const cannotPost = place.kind === "group" && !("0" in owners); // "0" = GUILD_INSTALL: the bot is a member and may post
    const base = {
      channel: "discord", eventId: String(b.id ?? ""), replyToken: typeof b.token === "string" ? b.token : undefined, place, userId: uid, text: "",
      mentioned: place.kind === "group", ...(typeof b.locale === "string" ? { locale: b.locale } : {}), ...(cannotPost ? { cannotPost: true } : {}),
    };
    if (t === T_COMMAND) {
      const name = String(b.data?.name ?? "").toLowerCase();
      const arg = ((b.data?.options ?? []) as J[]).map((o) => String(o.value ?? "")).join(" ").trim();
      return [{ ...base, kind: "text", text: `/${name}${arg ? ` ${arg}` : ""}` }];
    }
    if (t === T_COMPONENT) {
      const id = String(b.data?.custom_id ?? "");
      if (id.startsWith("pb:")) return [{ ...base, kind: "postback", postback: id.slice(3) }];
      if (id.startsWith("tx:")) return [{ ...base, kind: "text", text: id.slice(3).trim() }];
      return [{ ...base, kind: "other" }];
    }
    const id = String(b.data?.custom_id ?? "");
    const prefix = id.startsWith("modal:") ? id.slice(6).trim() : "";
    let value = "";
    for (const row of (b.data?.components ?? []) as J[]) for (const c of (row.components ?? []) as J[]) if (typeof c.value === "string") value = c.value;
    return [{ ...base, kind: "text", text: `${prefix} ${value}`.trim() }];
  }

  // ---- outbound -----------------------------------------------------------------------------
  private async api(path: string, body?: unknown, method = "POST"): Promise<Response> {
    return fetch(`${API}${path}`, {
      method, headers: { "content-type": "application/json", "user-agent": UA, ...(this.env.DISCORD_BOT_TOKEN ? { authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
  }

  /** Fill in the deferred reply: the first message edits "thinking…", the rest are follow-ups. */
  async reply(replyToken: string, msgs: Out[]): Promise<void> {
    if (!this.enabled) throw new Error("discord: no bot token / application id");
    const app = this.env.DISCORD_APPLICATION_ID;
    const payloads = msgs.slice(0, 5).flatMap((m) => this.render(m));
    let first = true;
    for (const p of payloads) {
      const r = first ? await this.api(`/webhooks/${app}/${replyToken}/messages/@original`, p, "PATCH") : await this.api(`/webhooks/${app}/${replyToken}`, p, "POST");
      if (!r.ok) throw new Error(`discord reply ${r.status}: ${(await r.text()).slice(0, 200)}`);
      first = false;
    }
  }

  async push(to: string, msg: { text?: string; quick?: Quick[]; image?: string; sender?: string; card?: Card }): Promise<{ ok: boolean; status: number; detail?: string }> {
    if (!this.enabled) return { ok: false, status: 0, detail: "discord disabled" };
    const payloads = msg.card ? this.render({ card: msg.card, quick: msg.quick }, msg.sender) : this.render({ text: msg.text ?? "", quick: msg.quick }, msg.sender);
    if (msg.image) {
      if (!payloads.length) payloads.push({ content: "" });
      payloads[0].embeds = [...((payloads[0].embeds as J[]) ?? []), { image: { url: msg.image } }].slice(0, 10);
    }
    if (!payloads.length || (payloads.length === 1 && !String(payloads[0].content ?? "").trim() && !payloads[0].embeds)) return { ok: false, status: 400, detail: "nothing to send" };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cid = await this.channelFor(to, attempt > 0);
        if (!cid) return { ok: false, status: 400, detail: `no channel for ${to}` }; // per-target, not an outage
        let retry = false;
        for (const p of payloads) {
          const r = await this.api(`/channels/${cid}/messages`, p);
          if (r.ok) continue;
          if (r.status === 429) return { ok: false, status: 429, detail: "rate limited" };
          // a remembered DM channel that no longer works (403/404): forget it and open it once more
          if (attempt === 0 && to.startsWith(DISCORD_USER) && (r.status === 403 || r.status === 404)) { await this.forgetDm(to); retry = true; break; }
          return { ok: false, status: r.status, detail: (await r.text()).slice(0, 200) };
        }
        if (!retry) return { ok: true, status: 200 };
      }
      return { ok: false, status: 404, detail: "dm channel could not be opened" }; // per-target (DMs closed / unknown user), not an outage
    } catch (e) { return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) }; }
  }
  /** A person's DM channel is opened once and remembered; a channel id is itself. */
  private async channelFor(to: string, fresh = false): Promise<string | undefined> {
    if (to.startsWith(DISCORD_CHANNEL)) return to.slice(DISCORD_CHANNEL.length);
    if (!to.startsWith(DISCORD_USER)) return undefined;
    const uid = to.slice(DISCORD_USER.length);
    const k = `discord:dm:${uid}`;
    if (!fresh) { const cached = await this.store?.get<string>(k); if (cached) return cached; }
    const r = await this.api("/users/@me/channels", { recipient_id: uid });
    if (!r.ok) return undefined;
    const id = String(((await r.json()) as J).id ?? "");
    if (id) await this.store?.put(k, id);
    return id || undefined;
  }
  private async forgetDm(to: string): Promise<void> { await this.store?.del?.(`discord:dm:${to.slice(DISCORD_USER.length)}`); }

  // ---- rendering ----------------------------------------------------------------------------
  /** Out → 1+ message payloads. Text over 2000 chars is split on lines; chips ride on the last piece. */
  private render(m: Out, sender?: string): J[] {
    const chips = this.buttons(m.quick ?? []);
    if (m.card) {
      const rows = [...cardButtons(m.card), ...chips].slice(0, 5);
      return [{ content: sender ? `**${sender.slice(0, 80)}**` : "", embeds: m.card.bubbles.slice(0, 10).map(embed), ...(rows.length ? { components: rows } : {}) }];
    }
    const chunks = splitText(m.text ?? "");
    return chunks.map((c, i) => ({ content: (i === 0 && sender ? `**${sender.slice(0, 80)}**\n` : "") + c, ...(i === chunks.length - 1 && chips.length ? { components: chips } : {}) }));
  }
  private buttons(quick: Quick[]): J[] {
    const seen = new Set<string>(); const btns: J[] = [];
    for (const q of quick) {
      const id = (q.fill != null ? `fl:${q.fill}` : q.text != null ? `tx:${q.text}` : `pb:${q.data ?? ""}`).slice(0, 100);
      if (seen.has(id) || btns.length >= 25) continue;
      seen.add(id);
      const style = q.fill != null ? BTN_PRIMARY : q.data?.startsWith("parley:ok") ? BTN_SUCCESS : q.data?.startsWith("parley:no") ? BTN_DANGER : q.data ? BTN_PRIMARY : BTN_SECONDARY;
      btns.push({ type: 2, style, label: q.label.slice(0, 80) || "…", custom_id: id });
    }
    return rowsOf(btns);
  }

  // ---- lookups ------------------------------------------------------------------------------
  private remember(key: string, v: string | undefined): void { if (this.names.size > 2000) this.names.clear(); this.names.set(key, { v, at: Date.now() }); }
  private cached(key: string): { hit: boolean; v?: string } { const h = this.names.get(key); return h && Date.now() - h.at < 6 * 3600_000 ? { hit: true, v: h.v } : { hit: false }; }
  async userName(userId: string): Promise<string | undefined> {
    const c = this.cached(userId); if (c.hit) return c.v;
    let v: string | undefined;
    if (this.enabled && userId.startsWith(DISCORD_USER)) {
      try { const r = await this.api(`/users/${userId.slice(DISCORD_USER.length)}`, undefined, "GET"); if (r.ok) { const j = (await r.json()) as J; v = j.global_name || j.username || undefined; } }
      catch { /* names are decoration */ }
    }
    this.remember(userId, v);
    return v;
  }
  async groupName(groupId: string): Promise<string | undefined> {
    const c = this.cached(groupId); if (c.hit) return c.v;
    let v: string | undefined;
    if (this.enabled && groupId.startsWith(DISCORD_CHANNEL)) {
      try {
        const r = await this.api(`/channels/${groupId.slice(DISCORD_CHANNEL.length)}`, undefined, "GET");
        if (r.ok) {
          const ch = (await r.json()) as J;
          v = ch.name ? `#${ch.name}` : undefined;
          if (ch.guild_id) { const g = await this.api(`/guilds/${ch.guild_id}`, undefined, "GET"); if (g.ok) { const gj = (await g.json()) as J; if (gj.name) v = `${gj.name} ${v ?? ""}`.trim(); } }
        }
      } catch { /* decoration */ }
    }
    this.remember(groupId, v);
    return v;
  }
  deepLink(): string | undefined { return undefined; } // Discord has no "open a chat with this text prefilled" link
}

// ---- helpers -----------------------------------------------------------------------------------
function splitText(text: string): string[] {
  const s = text.length ? text : " ";
  if (s.length <= 1900) return [s];
  const out: string[] = []; let cur = "";
  for (const line of s.split("\n")) {
    const piece = line.length > 1900 ? line.slice(0, 1900) : line;
    if (cur && cur.length + 1 + piece.length > 1900) { out.push(cur); cur = piece; } else cur = cur ? `${cur}\n${piece}` : piece;
    if (out.length >= 4) break; // five messages at most; the rest is cut, as LINE would
  }
  if (cur && out.length < 5) out.push(cur);
  return out;
}
function rowsOf(btns: J[]): J[] { const rows: J[] = []; for (let i = 0; i < btns.length && rows.length < 5; i += 5) rows.push({ type: 1, components: btns.slice(i, i + 5) }); return rows; }
function embed(b: Bubble): J {
  const desc = [b.sub, ...(b.notes ?? [])].filter(Boolean).join("\n");
  return {
    title: b.title.slice(0, 256) || "…", description: desc.slice(0, 4096), color: COLOR,
    ...(b.rows?.length ? { fields: b.rows.slice(0, 25).map((r) => ({ name: `${r.dot} ${r.who}`.slice(0, 256), value: (r.right || ZWSP).slice(0, 1024), inline: false })) } : {}),
  };
}
function cardButtons(card: Card): J[] {
  const seen = new Set<string>(); const btns: J[] = [];
  for (const b of card.bubbles) for (const x of b.buttons ?? []) {
    const id = `pb:${x.data}`.slice(0, 100);
    if (seen.has(id)) continue; seen.add(id);
    btns.push({ type: 2, style: x.primary ? BTN_PRIMARY : BTN_SECONDARY, label: x.label.slice(0, 80), custom_id: id });
  }
  return rowsOf(btns);
}
