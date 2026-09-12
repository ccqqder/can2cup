# Telegram adapter — 設計與施工計畫(第三個 channel)

狀態:**Phase 0-2 已做完並過第八次審查(2026-09-10,0.15.0,見 docs/security/2026-09-10-eighth-opinion-telegram.md);Phase 3 的 ToS 項目在 §4**。流程照舊:設計 → 審查(codex medium)→ 實作。ToS 精簡版已查:`~/.claude/tos/telegram.md`(查證 2026-09-10;Bot API 10.3)。

## 0. 先回答「adapter 抽象夠不夠」

**有真的介面,但接縫只乾淨七成。** `src/relay/channel.ts` 的 `Channel` 介面(`verify` / `parse` / `reply` / `push` / `userName` / `groupName` / `deepLink`,加三個能力旗標 `canHearGroup` / `hasFillIn` / `initialReplyMs`)確實被 `line.ts` 與 `discord.ts` 各自完整實作;綁定、inbox、配額、封鎖、提醒、群房 wiring 全在 BridgeDO,不看 channel。**可以原封不動重用的**:綁定儲存(`user:` / `pub:` / `pcode:`)、`deliver()` 的三層配額閘、`alarm()` 排程、`/p/notify` 的 `where:` 解析、`channelHealth`、`bot.ts` 26 個 console 指令的邏輯。

但介面外面有 **25 個程式碼分支點**靠「猜」channel,四個聚落:

| # | 漏洞 | 位置 | 為什麼 Telegram 加不進去 |
|---|---|---|---|
| L1 | **id 前綴嗅探**:`chanFor(id) = isDiscordId(id) ? discord : line`、`chan(name) = name === "discord" ? … : line` | `bridge.ts:168-169`,下游 11 處 `isDiscordId(…) ? … : …` | 二元三元運算,沒有 registry;第三個 channel 會落到 `line` 分支 |
| L2 | **投遞結果是字串協定**:`delivered` 以 channel 名開頭,四處用 regex / 相等集合判斷 | `bridge.ts:868`(重試)、`:923`(配額)、`:930`、`:940`(健康) | 新名字**靜默**掉出重試、配額與健康紀錄 —— 不報錯、只是不算 |
| L3 | **`forDiscord` 字詞替換**:`/LINE/g → "Discord"` 兩個出口(reply `:514`、push `:808`) | `bot.ts:472-486` | 一對一替換表,第三個目的地無法表達;而且 v0.12.1 曾漏掉 push 出口 |
| L4 | **`via` 標籤與 inbox 文案用三元拼**:`"line-group-guest"` / `"Discord channel"` … | `bridge.ts:1711, 1771, 1832-1833, 1860-1862`;client 端 `core.ts:959`、`cli/index.ts:1325` 再嗅一次 `discord:` 前綴 | client 明明已收到 `ChannelHealth.channel`,卻重新猜 |

另外兩份**手動同步**的指令字彙表(`bot.ts:44` `COMMANDS` 與 `scripts/discord-app.mjs:32-55`),Telegram 會變成第三份。

**結論**:不是重寫,是先做一次「把猜改成查表」的整理(Phase 0),Telegram 才能以「新增一個檔案 + 一個 registry 項目」的方式進來,而不是再複製 25 個三元。Phase 0 本身沒有行為改變、可用現有 smoke + check:line + check:discord 全數驗證。

## 1. Phase 0 — 把接縫補到 100%(先做,不碰 Telegram)

> **完成紀錄(0.15.0)**:六項全做。`channels.ts` registry(`CHANNEL_META` + `makeChannels` + `channelFor`,依 id 前綴長度解析、bare id 落到 LINE);`Channel` 介面加 `label` / `idPrefix` / `owns` / `webhookPath` / `configured` / `verifyFailStatus` / `vocab` / `installHint?`;`deliver()` 回傳結構化 `Verdict`(重試、配額、健康三處改讀欄位,`text` 只留給 push log);`forDiscord` 刪除,console 從 `ctx.vocab` 組句(bot.ts 18 處 LINE → `v.chat`;第一版是出口填 `{chat}` 佔位,第八次審查指出那會連 peer 寫的字一起改,已改回建構時組句);`via` 一律 `${channel.name}-…`,`/p/claim` 回傳 `channel`,client 用 `chatAppLabel` / `chatPlace` 讀名字而非嗅 id;`commands.ts` 一份指令表(bot.ts 與 `discord-app.mjs` 共用,後者從 dist 讀);Worker 與 DO 的 webhook 路由都從 registry 迴圈產生,Discord 的 3 秒 hop 成為 `ChannelMeta.hop`。驗證:build、check:relay、check:line、check:discord、smoke 全綠;bridge.ts 不再 import 任何 adapter 類別。

1. **Channel registry**(取代 L1)
   - `Channel` 介面加 `readonly idPrefix: string`(LINE = `""`,Discord = `"discord:"`,Telegram = `"tg:"`)與 `owns(id): boolean`。
   - BridgeDO 持有 `channels: Channel[]`;`chanFor(id)` = 第一個 `owns(id)` 為真者(bare id 最後才對 LINE);`chan(name)` = 查 `Map`。
   - 11 處 `isDiscordId(x) ? A : B` 改成 `this.chanFor(x).name` / 能力旗標。`discord.ts` 的 `isDiscordId` 留給 discord.ts 內部用,bridge 不再 import。
2. **投遞結果結構化**(取代 L2)
   - `deliver()` 內部改回傳 `{ channel: string; ok: boolean; status?: number; detail?: string; gate?: "over-budget"|"banned"|"room-rate-limited"|… }`;`delivered` 字串只在 `pushes` 日誌與 `/bridge/debug` 保留為 `fmtVerdict()` 的輸出(格式不變,舊 smoke 斷言不用改)。
   - 重試判定 = `!ok && (status >= 500 || status === 429 || error)`,配額 = `ok`,`noteHealth` = 「有真的打到 channel」—— 三處不再列舉名字。
3. **字彙表取代字詞替換**(取代 L3)
   - `bot.ts` 新 `Vocab { app, chat, group, groupHint, joinHint }`,每個 channel 一份(LINE:「傳聲罐罐 / 群 / 拉進群」;Discord:「can2cup / 伺服器頻道 / 裝進伺服器」;Telegram:「can2cup / 群組 / 拉進群組」)。
   - 現有文案改用模板(`${v.app}`、`${v.group}`),由 `Channel.vocab` 提供;`forDiscord` 刪除,`:514` 與 `:808` 兩個出口改成 `renderFor(channel, out)`,只做一件事:套字彙 + 分段長度(`Channel.maxTextLen`:LINE 5000、Discord 2000、Telegram 4096)。
   - `bot.ts:157, 222` 三處硬編 "LINE" 一併改模板。
4. **`via` 與 inbox 文案**(取代 L4)
   - `via` 統一為 `${channel.name}${group ? "-group" : ""}${guest ? "-guest" : ""}`;client 端 `core.ts:292/433/439` 的解析改成「split 後第一段是 channel 名」,不再列舉。
   - `core.ts:959`、`cli/index.ts:1325` 改讀 `ChannelHealth.channel` / `BridgeState.channel`。
5. **一份指令字彙**:`COMMANDS` 搬到 `src/relay/commands.ts`(名稱、zh 描述、en 描述、是否群組限定),`bot.ts` 的 HELP 與 `discord-app.mjs`、之後的 `telegram-app.mjs` 都從它產生。
6. **Webhook 路由抽象**:`index.ts` 的 `/line/webhook`、`/discord/interactions` 改成 `for (const ch of channels) app.post(ch.webhookPath, …)`;Discord 的「Worker 先驗簽 + 3 秒立即回應 + `waitUntil` 轉 DO」保留為 `Channel.immediate?()` 可選 hook(Telegram 不需要:Telegram 對 webhook 回應沒有 3 秒硬限制,但**必須回 200**,否則會重送;所以 Telegram 走 LINE 式的「整包丟 DO」)。

驗證:build、`check:relay`、smoke 451、`check:line`、`check:discord` 全綠,**零文案 diff**(把 `bot.ts` 所有回覆字串在改前後各 dump 一次比對)。

## 2. Phase 1 — `src/relay/telegram.ts`(約 250 行,對照 `discord.ts` 285 行)

> **完成紀錄**:`src/relay/telegram.ts` 依下表實作,差異兩處:(1)填字按鈕 `fl:` 改在 Worker 層 hop 用 **ForceReply** 處理(提示訊息首行 `✍️ <prefix>`,回覆時從 `reply_to_message` 讀回 prefix,不需儲存狀態);(2)webhook 路徑固定 `/telegram/webhook`(`CHANNEL_META` 是靜態的),驗證只靠 secret header 的 constant-time 比對。dev 沒有 token 時 bot 靠 `TELEGRAM_BOT_USERNAME` 認出自己(`isMe`)。

| 介面項 | Telegram 實作 |
|---|---|
| `name` | `"telegram"`;`idPrefix` `"tg:"`;user id `tg:u:<int>`,群 `tg:c:<負 int>`(chat id 52-bit,字串存) |
| `enabled` | `TELEGRAM_BOT_TOKEN` 存在 |
| `canHearGroup` | **false**(預設 privacy mode:只收 `/指令`、@mention、對 bot 的回覆;與 Discord 同構,`/context` 一樣不支援,不關 privacy mode) |
| `hasFillIn` | true(`ForceReply` 或 inline keyboard `switch_inline_query_current_chat` 做「填字」) |
| `initialReplyMs` | 60_000(沒有 reply token;`reply()` 直接 `sendMessage` 到 `chat_id`,`replyToken` 帶 `chat_id:message_id` 供 `reply_parameters` 引用) |
| `verify` | 比對 `X-Telegram-Bot-Api-Secret-Token` header 與 `TELEGRAM_WEBHOOK_SECRET`(constant-time);webhook 路徑再加祕密段 `/telegram/webhook/<TELEGRAM_WEBHOOK_PATH>`。不是簽章,所以 **Worker 層先驗、DO 再驗一次**(同 Discord 的「路由必須能單獨成立」原則) |
| `parse` | `Update` → `Incoming`:`message.text` 以 `/` 開頭 → 去掉 `@botname` 尾綴;`entities` 內 `mention`/`text_mention` 指向 bot → `mentioned`;`callback_query.data` → `postback`(並 `answerCallbackQuery` 止住轉圈);`my_chat_member` 的 `new_chat_member.status` ∈ {member, administrator} → `join`,∈ {left, kicked} → `leave`(私聊被封鎖 = `unfollow`,**視為撤回同意,停止推播**);`message.from.language_code` → `locale` |
| `reply` / `push` | 都是 `sendMessage`(`parse_mode` 不用,純文字;card 退化為 `alt` + inline keyboard);429 讀 `parameters.retry_after` 回 `{ok:false,status:429,detail}` 讓現有 backoff 接手;403 `bot was blocked` → 回 403,由 bridge 標記 unbind 候選 |
| `userName` / `groupName` | `getChat` / `getChatMember`,6 小時快取同 LINE |
| `deepLink(message)` | `https://t.me/<bot>?start=<param>`;param 只允許 `[A-Za-z0-9_-]{1,64}` → `/link` 碼與 8 字短碼可直接帶,長句不行 → 回 `undefined`,bridge 已有 fallback(貼 bare code) |
| `setMenu` | `setMyCommands`(全域一次,不是 per-user)→ 實作為 no-op + 由 `telegram-app.mjs` 註冊指令 |
| `Card` | inline keyboard(`InlineKeyboardMarkup`,`callback_data` ≤ 64 bytes → postback payload 超長就改 `pb:<短 id>` 查表,Discord 已有 `pb:` 慣例) |

**群房 wiring**:`/room`、`/mirror`、`parley:wire`、join-by-tap 全部走 BridgeDO 既有路徑,Telegram 只提供 `place.kind === "group"` 與 `my_chat_member` 事件;Discord 其實也有 `/room` / `/mirror`,所以 wiring 後的 30 天 sliding keep-alive 三個 channel 都拿得到;Discord 真正缺的是 `canHearGroup` 與 `deepLink`,Telegram 補得回 `deepLink`(`?start=`),`canHearGroup` 則與 Discord 一樣刻意不開。

## 3. Phase 2 — 接線、工具、文件、測試

> **0.15.1 補完**:出貨後真機測試發現兩個隱性 LINE 假設 —— (1) `PUSH_BUDGET` 是全站一個月計數器,Telegram/Discord 沒有平台月額度卻跟著 LINE 一起停推,改成每 channel 各自計數、只有宣告 `monthlyBudget` 的 channel(LINE)才擋,`/quota` 顯示自己 channel 的數字;(2) **client 端**(`status` / `doctor` / `whoami` / `setup` / `link` / `unbind` / `groups` / `wire` / `tell`、MCP 工具說明)約 60 處寫死 LINE,改讀 relay 回報的 channel 名(`/p/state.channel`、`/p/claim.channel`、`/p/groups[].channel`、`via`),link 流程加上 Telegram deep link。relay 端的 registry 本來就夠,client 不是 adapter 宿主、只是沒被要求用 relay 給的資料組句。

> **完成紀錄**:`channels.ts` 加入第三項;`BridgeEnv` / `wrangler.toml`(`TELEGRAM_BOT_USERNAME` var)/ `.dev.vars`;`scripts/telegram-app.mjs`(show / describe / commands / app)已用來設好 @can2cup_bot 的名稱、描述與 22 個指令;`scripts/telegram-check.mjs`(`npm run check:telegram`)偽造 Update 走完整條;SELF-HOST、README、OAuth 頁面文案改由 registry 列出 chat app。

- `wrangler.toml` 新增區塊:`TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`(secrets)、`TELEGRAM_BOT_USERNAME`(var,deepLink 用);`.dev.vars` dev 值;`BridgeEnv` 加型別。
- `scripts/telegram-app.mjs`:`show`(getMe / getWebhookInfo)、`app`(setWebhook 帶 `secret_token`、`allowed_updates: ["message","callback_query","my_chat_member"]`、`drop_pending_updates`)、`commands`(setMyCommands 從 `commands.ts` 產生,zh-TW 描述)。token 從 `.env.telegram`(gitignored)讀。
- `scripts/telegram-check.mjs`:偽造 `Update` 打 `/telegram/webhook/<path>` 帶 secret header,從 `/bridge/debug/pushes` 讀回覆 —— 照 `discord-check.mjs` 的骨架;錯 secret → 401、缺 header → 401、`/link` 綁定、群 `/status`、`my_chat_member` kicked 後推播停止、429 retry_after 進 backoff。
- `docs/SELF-HOST.md` 加 Telegram 段;`/terms` `/privacy` HTML 的「LINE/Discord」六處改成從 registry 列;`README` 的 channel 一句。
- `relay-assets/changelog.txt`:`!! DATA FLOW`(新增一個資料流向的第三方)。

## 4. Phase 3 — ToS 對應(從 `~/.claude/tos/telegram.md` 抄下來的硬需求)

| 條款 | 要做的事 |
|---|---|
| §5.2(b) 不得未經請求傳訊 | 只推給 `/start` 或 `/link` 過的 user(平台本身也擋);`PUSH_USER_BUDGET` 原樣套用 |
| 速率 1/秒/聊天、20/分/群、§5.2(f) 不得規避 | 尊重 429 `retry_after`(進 backoff,不搶跑);群推播加每群每分鐘計數(現有 `rl:<room>:<hour>` 改成可依 channel 給粒度) |
| §4.2 同意與刪除 | `/start` 首則回覆含資料用途一句 + `/terms`;`/unbind` `/forgetme` `erase` 對 `tg:` id 同樣有效;`my_chat_member` kicked/blocked = 撤回同意 → 停推 + 標記 |
| §4.3 資料最小化、禁 AI 訓練 | `/context` 在 Telegram 不提供(`canHearGroup=false` 自然不會有);privacy 文字加「不用於訓練」一句(Discord 已有) |
| §4.4(a) 靜態加密 | Cloudflare 託管加密;token 只在 wrangler secret,`.env.telegram` gitignored,**開源 repo 不得含任何 token** |
| 標準隱私政策 | BotFather 設 privacy policy 連結指向 `/privacy`(否則自動套 Telegram 標準版) |
| §5.2(c) 冒名 | username 不含 "telegram";名稱 can2cup |

## 5. 不做 / 明確排除

- 不關 privacy mode(不監聽群內全部訊息)—— 與 Discord 一致,也避開 §4.3。
- 不用 Telegram Login Widget / Mini App 做綁定 —— `/link` 碼流程已夠,少一個 OAuth 面。
- 不做 Telegram Stars / 付費廣播。
- 不做 MTProto client(API ToS 那份是給 client 的,與我們無關)。

## 6. 順序與工作量

| Phase | 內容 | 估計 | 出貨 |
|---|---|---|---|
| 0 | 接縫整理(registry、verdict 結構、字彙表、via、commands.ts、webhook 路由) | 1 天 | 0.15.0(無使用者可見變更;`!!` 不需要) |
| 1+2 | `telegram.ts` + 接線 + 兩個 script + check | 1 天 | 0.16.0(`!! DATA FLOW`) |
| 3 | ToS 項目(多半是文案與一個群速率計數) | 半天 | 同 0.16.0 |
| 審查 | Phase 0 完成後 codex medium 一輪(重點:verdict 結構有沒有把哪個 channel 的失敗變成靜默);Phase 2 完成後再一輪(重點:webhook secret 比對、callback_data 查表、blocked 後仍推播) | | |

Phase 0 先出、單獨 smoke,是因為它動到 push 管線的核心判斷(重試/配額/健康);萬一改壞,要能在沒有 Telegram 變數干擾的情況下 bisect。

## 7. 待老闆決定

1. bot username(BotFather 要先建才拿得到 token;建議 `can2cup_bot`,備援 `can2cupbot`)。
2. Phase 0 要不要順便把 **Discord 的 `/context` 缺口**補成「三個 channel 一致不支援、文案明講」,還是維持 LINE 獨有。
3. `TELEGRAM_WEBHOOK_PATH` 祕密段長度(建議 24 hex,與 `RELAY_KEY` 同源產生)。
