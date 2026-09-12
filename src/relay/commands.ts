/**
 * v0.15.0: the console's command set, ONCE. bot.ts reads the names (what counts as a command); the per-channel
 * registration scripts (scripts/discord-app.mjs today, Telegram next) read the descriptions and argument shapes and
 * turn them into that platform's command objects. Before this, the list lived twice — bot.ts and discord-app.mjs —
 * and drifted by hand.
 *
 * `hidden` = accepted by the console but not registered as a platform command (aliases, the LINE-only /rooms).
 * This file has no imports so it compiles into dist/ on its own (tsconfig.json includes it) for the scripts.
 */
export type CommandArg = { kind: "text"; name?: string; en: string; zh: string; required?: boolean } | { kind: "onoff"; en: string; zh: string };
export interface CommandSpec {
  /** without the slash */
  name: string;
  en: string;
  zh: string;
  arg?: CommandArg;
  /** only meaningful inside a group / channel */
  group?: boolean;
  hidden?: boolean;
}

const text = (en: string, zh: string, required = false, name?: string): CommandArg => ({ kind: "text", en, zh, required, ...(name ? { name } : {}) });
const onoff = (en: string, zh: string): CommandArg => ({ kind: "onoff", en, zh });

export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "setup", en: "Connect the AI on your own computer to can2cup (DM only)", zh: "把你電腦上的 AI 接上 can2cup(只能在私訊)", arg: text("\"again\" to replace the bound computer", "打 again 換一台電腦") },
  { name: "link", en: "Bind with the code your agent shows (or get one)", zh: "用 agent 給的碼綁定(或拿一組碼)", arg: text("ABCD-1234", "ABCD-1234") },
  { name: "status", en: "Is my agent online, and which channels is it connected to", zh: "我的 agent 在線嗎、接上哪些頻道" },
  { name: "a", en: "Say one thing to your agent", zh: "對你的 agent 說一句", arg: text("What to tell it", "要交代的話", true) },
  { name: "agent", en: "Every DM line goes straight to the agent: on / off", zh: "每句私訊直通 agent:on / off", arg: onoff("on or off", "on 或 off") },
  { name: "pause", en: "Brake: the agent sends nothing until /resume", zh: "煞車:agent 什麼都送不出去,直到 /resume" },
  { name: "resume", en: "Release the brake", zh: "放開煞車" },
  { name: "lang", en: "The language I and your agent speak to you in (en, zh-TW, ja …)", zh: "我和你的 agent 跟你說話用的語言(en、zh-TW、ja…)", arg: text("en · zh-TW · ja · …", "en、zh-TW、ja…") },
  { name: "show", en: "Recent messages of a conversation", zh: "看最近的對話", arg: text("[room id] [count]", "[對話 id] [則數]") },
  { name: "join", en: "Accept an invite: the 8-char code or the link", zh: "接受邀請:8 碼或邀請連結", arg: text("Code or link", "碼或連結", true, "code") },
  { name: "room", en: "(channel) Connect this channel to my agent", zh: "(頻道)把這個頻道接上我的 agent", arg: text("Room name", "對話名稱", false, "name"), group: true },
  { name: "mirror", en: "(channel) Post the conversation back here: decisions only, or \"all\"", zh: "(頻道)把對話貼回這裡:只貼決策,或 all 全文", arg: text("[room id] [all]", "[對話 id] [all]"), group: true },
  { name: "unmirror", en: "(channel) Stop posting the conversation here", zh: "(頻道)不再貼回這裡", group: true },
  { name: "quiet", en: "(channel) No receipt after each /a", zh: "(頻道)/a 之後不回執", group: true },
  { name: "unquiet", en: "(channel) Receipts back on", zh: "(頻道)恢復回執", group: true },
  { name: "context", en: "(channel) Send recent channel chat along with /a: on / off", zh: "(頻道)/a 時夾帶最近的頻道對話:on / off", arg: onoff("on or off", "on 或 off"), group: true },
  { name: "ask", en: "(channel) Ask the agent connected here, without binding one", zh: "(頻道)沒綁定也能問接上這個頻道的 agent", arg: text("Your question", "你想問的", true), group: true },
  { name: "quota", en: "This month's push usage", zh: "本月推播用量" },
  { name: "keep", en: "How long the binding survives an absent agent: \"forever\" or days", zh: "agent 久沒出現時綁定留多久:永久 或 天數", arg: text("forever | 7–365", "永久 | 7–365") },
  { name: "unbind", en: "Unbind this account from the agent (confirm with: yes)", zh: "解除跟 agent 的綁定(確認:打 確定)", arg: text("yes", "確定", false, "confirm") },
  { name: "forgetme", en: "Delete everything about me on this relay (confirm with: delete)", zh: "刪掉 relay 上關於我的全部資料(確認:打 刪除)", arg: text("delete", "刪除", false, "confirm") },
  { name: "help", en: "Command list", zh: "指令表" },
  { name: "advance", en: "Advanced commands", zh: "進階功能" },
  // accepted, not advertised
  { name: "rooms", en: "Alias of /status", zh: "/status 的別名", hidden: true },
  { name: "can2cup", en: "Alias of /help", zh: "/help 的別名", hidden: true },
  { name: "can2can", en: "Alias of /help", zh: "/help 的別名", hidden: true },
  { name: "parley", en: "Alias of /help", zh: "/help 的別名", hidden: true },
];

/** "/setup", "/link", … — every word the console treats as a command. */
export const COMMAND_NAMES: readonly string[] = COMMAND_SPECS.map((c) => `/${c.name}`);
/** The ones a platform should register (menus, slash commands). */
export const PUBLIC_COMMANDS: readonly CommandSpec[] = COMMAND_SPECS.filter((c) => !c.hidden);
