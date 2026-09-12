/**
 * v0.15.0: the channel registry — the ONE place that knows which chat apps this relay speaks.
 *
 * Before this, BridgeDO held `line` and `discord` as two fields and resolved an id with a ternary
 * (`isDiscordId(id) ? discord : line`), and eleven more sites downstream repeated that ternary to pick a word, a
 * `via` tag or a deep link. A third channel would have meant a third branch in each. Now: a channel says which
 * ids it owns (`idPrefix` / `owns`), which route its webhook arrives on, and what it calls things (`vocab`); the
 * bridge and the Worker iterate this list and never name a channel.
 *
 * Order matters in one way only: prefixed channels resolve before the bare-id fallback (LINE), so `makeChannels`
 * sorts by prefix length. `CHANNEL_META` is the static half (no env needed) for the Worker's routes and the
 * human-facing texts (/terms, /privacy).
 */
import type { Channel } from "./channel.js";
import { LineChannel, type LineEnv } from "./line.js";
import { DiscordChannel, discordWorkerHop, type DiscordEnv } from "./discord.js";
import { TelegramChannel, telegramWorkerHop, type TelegramEnv } from "./telegram.js";

export type ChannelEnv = LineEnv & DiscordEnv & TelegramEnv;
export interface ChannelStore { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; del?(k: string): Promise<void> }

/** What the Worker answers on the channel's clock, before the DO has looked. `forward` = hand the bytes to the DO.
 *  A channel without one is passed straight through (LINE: the DO verifies and answers with the reply token). */
export type WorkerHop = (env: ChannelEnv, header: (n: string) => string | undefined, raw: ArrayBuffer) => Promise<{ status: number; response: unknown; forward: boolean }>;

export interface ChannelMeta { name: string; label: string; idPrefix: string; webhookPath: string; hop?: WorkerHop }

/** Display order (how people list them): LINE first, then the rest, in the order they were added. */
export const CHANNEL_META: readonly ChannelMeta[] = [
  { name: "line", label: "LINE", idPrefix: "", webhookPath: "/line/webhook" },
  { name: "discord", label: "Discord", idPrefix: "discord:", webhookPath: "/discord/interactions", hop: discordWorkerHop },
  { name: "telegram", label: "Telegram", idPrefix: "tg:", webhookPath: "/telegram/webhook", hop: telegramWorkerHop },
];

/** "LINE／Discord" — for the human-facing texts that used to spell the list out by hand. */
export const chatApps = (sep = "／"): string => CHANNEL_META.map((m) => m.label).join(sep);

/** The live adapters, in resolution order (longest id prefix first; the bare-id channel last). */
export function makeChannels(env: ChannelEnv, store: ChannelStore): Channel[] {
  const all: Channel[] = [new LineChannel(env, store), new DiscordChannel(env, store), new TelegramChannel(env, store)];
  return all.sort((a, b) => b.idPrefix.length - a.idPrefix.length);
}

/** Resolve a bridge id to its channel. Never undefined: the bare-id channel takes whatever no prefix claims, which
 *  is exactly the pre-registry behaviour for LINE ids. */
export function channelFor(channels: readonly Channel[], id: string | undefined): Channel {
  return channels.find((ch) => ch.idPrefix && ch.owns(id)) ?? channels.find((ch) => ch.idPrefix === "") ?? channels[0];
}
export function channelNamed(channels: readonly Channel[], name: string): Channel {
  return channels.find((ch) => ch.name === name) ?? channels.find((ch) => ch.idPrefix === "") ?? channels[0];
}
