/** Tiny presentation helpers shared by the client and the relay — extracted
 *  because each had grown its own copy (four `short`s, five hand-rolled LINE
 *  deep links) and copies drift. */

/** 8-hex prefix for keys and ids in human-facing text ("relay" stays whole). */
export const short = (id: string): string => (id === "relay" ? "relay" : id.slice(0, 8));

/** LINE deep link that opens the OA's chat with `message` prefilled — the user
 *  only taps send (adds the OA as a friend first if needed). */
export const lineDeepLink = (oa: string, message: string): string =>
  `https://line.me/R/oaMessage/${encodeURIComponent(oa)}/?${encodeURIComponent(message)}`;

/** v0.15.0: the chat app behind a channel name the relay reports ("line", "discord", "telegram" …). The client used to
 *  sniff `discord:` off a user id to pick a word; the relay now says which channel, and this is the only table. */
export function chatAppLabel(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (!n) return "chat app";
  const known: Record<string, string> = { line: "LINE", discord: "Discord", telegram: "Telegram", tg: "Telegram" };
  return known[n] ?? n.charAt(0).toUpperCase() + n.slice(1);
}
/** "LINE group" / "Discord channel" — the place an inbox item came from, read off its `via` tag ("line-group-guest",
 *  "discord-group", …): the first segment is the channel name the relay assigned. */
export function chatPlace(via: string | undefined): string {
  const ch = (via ?? "line").split("-")[0];
  return ch === "discord" ? "Discord channel" : `${chatAppLabel(ch)} group`;
}
