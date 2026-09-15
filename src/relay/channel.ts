/**
 * Channel layer (v0.12.0): the thin seam between "the principal's chat app" and the bridge.
 *
 * Two concrete channels — LINE (v0.12.0; moved off the Render bot into the Worker) and Discord (v0.12.1,
 * HTTP-only interactions). The interface is deliberately small: verify + parse an inbound webhook, reply, push, look up
 * names, build a deep link. Everything the bridge decides (bindings, inbox, quotas, bans, reminders,
 * wires) is channel-neutral and stays in BridgeDO; everything a chat app renders (quick replies, Flex
 * cards, components, embeds) lives in the adapter that owns it.
 *
 * Capabilities differ and the seam does not pretend otherwise: `canHearGroup` (LINE bots see every group
 * message; a Discord HTTP-only app sees none), `hasFillIn` (LINE's open-keyboard button has no Discord twin),
 * `initialReplyMs` (LINE's reply token lives 60 s; a Discord interaction must be answered in 3 s).
 */

import { botLang, translateWord } from "./i18n.js";

/** A quick-reply button. `data` = postback (parley:ok / parley:no / parley:show / parley:wire …); `fill` (v0.7.4)
 *  opens the keyboard pre-filled instead; `text` sends that text as if the user typed it (the "next step" chips). */
export type Quick = { label: string; data?: string; fill?: string; text?: string };

/** One row of a status card: 🟢/🔴, who (a person), what (their agent + version). */
export interface CardRow { dot: "🟢" | "🔴"; who: string; right: string }
export interface CardButton { label: string; data: string; primary?: boolean }
/** One bubble of a status card. `title` = the group's name, `sub` = the grey status line, `rows` = members,
 *  `notes` = grey explanatory lines, `buttons` = postbacks. A carousel is a Card with several bubbles. */
export interface Bubble { title: string; sub: string; rows?: CardRow[]; notes?: string[]; buttons?: CardButton[] }
/** A rich card with a plain-text twin — the alt text is what notifications, logs and non-rich channels show. */
export interface Card { alt: string; bubbles: Bubble[] }

/** One outbound message. Exactly one of text / card is the body; `quick` chips ride on it. */
export interface Out { text?: string; card?: Card; quick?: Quick[] }

/** Where a message came from or goes to. `id` is the channel's own identifier (LINE userId / groupId). */
export interface Place { channel: string; kind: "dm" | "group"; id: string }

/** A normalised inbound event. `text` has bot @mentions stripped. `userId` may be missing (LINE gives none for
 *  a group member who has not added the bot). `replyToken` is channel-specific and may be absent (Discord defers). */
export interface Incoming {
  channel: string;
  kind: "text" | "postback" | "follow" | "unfollow" | "join" | "leave" | "media" | "other";
  eventId?: string;
  replyToken?: string;
  place: Place;
  userId?: string;
  text: string;
  mentioned: boolean;
  postback?: string;
  media?: string; // "image" | "audio" | "file" | "sticker" | …
  locale?: string; // the person's client locale when the channel says (Discord: "zh-TW", "en-US" …)
  /** The channel can answer THIS event but cannot post to the place on its own (Discord: a server that installed
   *  the app for one user, without the bot). Group features that push later would fail; the console says so. */
  cannotPost?: boolean;
  /** Telegram guest mode (Bot API 10.0) only: a single @mention/reply in a chat the bot may not be a member of.
   *  Always paired with cannotPost=true. The ONE reply this event may get must go through `Channel.answerGuest`,
   *  never `reply`/`push` — `place` here is best-effort and MUST NOT be treated as a postable room (the same numeric
   *  chat id can, per Telegram's own docs, belong to an unrelated ordinary chat the bot already knows). */
  guestQueryId?: string;
}

export interface Channel {
  readonly name: string;
  /** The app's proper name for people: "LINE", "Discord". */
  readonly label: string;
  /** v0.15.0: the prefix this channel's ids carry on the bridge ("discord:", "tg:"); "" for LINE, whose ids are bare —
   *  it is the fallback, so the registry resolves prefixed channels first. `owns` is the check itself. */
  readonly idPrefix: string;
  /** The Worker route this channel's webhook arrives on ("/line/webhook"). */
  readonly webhookPath: string;
  /** The webhook can be verified at all (the secret / public key is set). Without it the route answers 404. */
  readonly configured: boolean;
  /** What the webhook answers to a bad signature — LINE's Verify button expects 400, Discord's endpoint check 401. */
  readonly verifyFailStatus: number;
  readonly vocab: Vocab;
  /** v0.15.1: a platform-imposed monthly push allowance (LINE's free plan meters pushes; Discord and Telegram do not).
   *  Only a channel that has one is gated on it — the per-target and per-room abuse gates apply to all. */
  readonly monthlyBudget?: number;
  /** Credentials to speak are present (LINE access token / Discord bot token). Without them replies and pushes are
   *  recorded, not sent — the local smoke relies on that. */
  readonly enabled: boolean;
  readonly canHearGroup: boolean;
  readonly hasFillIn: boolean;
  readonly initialReplyMs: number;
  /** Is this webhook really from the channel? `raw` is the exact request body. */
  verify(headers: (n: string) => string | undefined, raw: ArrayBuffer): Promise<boolean>;
  /** Webhook body → events. Never throws; unknown events come back as kind "other". */
  parse(raw: string): Incoming[];
  /** Answer the event that carried `replyToken`. Throws when the channel refuses (expired token …). */
  reply(replyToken: string, msgs: Out[]): Promise<void>;
  /** Send to a place at the bot's own initiative (costs quota on LINE). */
  push(to: string, msg: { text?: string; quick?: Quick[]; image?: string; sender?: string; card?: Card }): Promise<{ ok: boolean; status: number; detail?: string }>;
  /** Display names — best effort, may be undefined. */
  userName(userId: string, groupId?: string): Promise<string | undefined>;
  groupName(groupId: string): Promise<string | undefined>;
  /** A link that opens the bot chat with `message` prefilled (LINE: line.me/R/oaMessage). undefined if the channel has none. */
  deepLink(message: string): string | undefined;
  /** Per-user menu (LINE rich menu). Optional; no-op elsewhere. */
  setMenu?(userId: string, which: "console" | "onboard"): Promise<void>;
  /** Tell the user the message was seen (LINE mark-as-read). Optional, must never throw. */
  markRead?(userId: string): Promise<void>;
  /** Is this bridge id one of mine? */
  owns(id: string | undefined): boolean;
  /** What to tell a group where the bot can answer but cannot post later (`Incoming.cannotPost`). Channel-specific by
   *  nature (Discord: "install the app on the server"); a channel that never sets cannotPost needs none. */
  installHint?(lang: string): string | undefined;
  /** Telegram guest mode only: the single answer to `Incoming.guestQueryId`. Other channels never set guestQueryId,
   *  so their adapters need not implement this. */
  answerGuest?(guestQueryId: string, text: string): Promise<{ ok: boolean; detail?: string }>;
}

/** Plain-text form of an Out, for logs and for channels without cards. */
export function outText(o: Out): string { return o.text ?? o.card?.alt ?? ""; }

/** v0.15.0: the words a chat app uses for itself and its places. The console (bot.ts) receives the channel's Vocab in
 *  its context and builds its sentences from it; the bridge's own push texts read it off the target's channel. Nothing
 *  is rewritten on the way out: an earlier design filled {chat}-style placeholders at the outbound choke points, and
 *  the review pointed out that this also rewrote text a PEER had written (a message body containing "{chat}") — the
 *  same class of defect as the old `/LINE/g → "Discord"` regex, which is exactly what this layer replaces. */
export interface Vocab {
  /** what the bot calls itself on this channel: 傳聲罐罐 (the LINE OA's name) / can2cup (the Discord app's name) */
  app: string;
  /** the chat app's own name, as people say it: LINE / Discord / Telegram */
  chat: string;
  /** a multi-person place: 群 / 伺服器頻道 / 群組 */
  group: string;
  /** how the bot gets into such a place, one sentence ending in "就能接上" */
  pull: string;
  /** the same, shorter, as a bullet: "把我拉進一個群,在群裡打 /status" */
  pullShort: string;
  /** the English words the agent-facing inbox uses for such a place: "LINE group" / "Discord channel" */
  groupEn: string;
}

/** v0.17.0: a channel's words in the language the console answers in — each translated like any sentence (the
 *  adapters' `vocab` holds the Chinese; check:i18n finds those words there). The app's own name and the English group
 *  word the agent reads stay as they are. */
export function vocabIn(ch: Channel, lang: string): Vocab {
  const l = botLang(lang);
  if (l === "zh-TW") return ch.vocab;
  const w = (zh: string) => translateWord(l, zh);
  return { app: w(ch.vocab.app), chat: ch.vocab.chat, group: w(ch.vocab.group), pull: w(ch.vocab.pull), pullShort: w(ch.vocab.pullShort), groupEn: ch.vocab.groupEn };
}
