# 第八意見(gpt-6-astra / codex,對 channel registry 重構 + Telegram adapter)

security session · 2026-09-10 · 審查者:**gpt-6-astra(medium)** 經 codex MCP · 對象:未 commit 的工作樹 —— Phase 0 接縫整理
(`channels.ts` registry、結構化 `Verdict`、字彙表)與 Phase 1/2 的 `telegram.ts`、`telegram-check.mjs`、`telegram-app.mjs`
狀態:**8 條(4 medium、4 low),無 critical/high;逐條驗證,全修。** 出 0.15.0。

審查者確認**沒有問題**的邊界:Worker hop 與 DO 都先驗 secret,缺/錯/過短一律拒;constant-time 比對正確;偽造 `reply_to_message`
能影響解析出的文字但 `userId` 仍取自 `from`,群組 `/unbind` 在打 API 前就被拒;群組 `my_chat_member` 只產生 join/leave,不會變成別人的
follow/unfollow;registry 對 undefined / 未知形狀 id 的 LINE fallback 正確;UTF-16 offset 對 emoji 前置的 mention 正確;26 個指令名
完全相同、Discord 22 個註冊物件逐項相同;配額與 health 分類與 HEAD 一致;既有 via 值保留。

## 已修

| # | 嚴重度 | 問題 | 修法 |
|---|---|---|---|
| 1 | medium | **出口填字會改寫 peer 原文**:`renderFor` 對整段 `out.text` 做 `{chat}` 替換,peer 傳 `literal {chat}` 到 LINE 會變 `literal LINE`。舊 LINE 不替換,所以是回歸(舊 Discord 的 `/LINE/g` 也有同類問題)。 | **改回建構時組句**:`Vocab` 進 `BotCtx`,bot.ts 18 處用 `v.chat` / `v.pull` / `v.pullShort`;bridge 的 push 文案讀 `this.chanFor(to).vocab`;`renderFor` / `fillVocab` 刪除。telegram-check 加「/a 文字含 {chat} 原樣進 inbox」。 |
| 2 | medium | **Telegram 長度處理靜默丟字**:單行 >4000 只留前段;圖片 caption >1024 的餘下被 `shift()` 丟掉;card 不經 `splitText`,可送出 4204 字被 Telegram 拒。 | `splitText` 把長行切成多段;caption 餘下留成下一段;card 每個 bubble 也經 `splitText`;總數仍 ≤5。 |
| 3 | medium | **forwarder 的 429 分類與 HEAD 不同**:舊 regex `^forward (5\d\d|error)` 不重試 429,新判式會。 | 判式加 `v.channel !== "forward"`,維持舊行為並註明。 |
| 4 | medium | **`parse()` 會拋錯、接受缺失的 id**:`entities: [null]` 拋 TypeError(DO 路由的 parse 在 try 外);`from: {}` 產生 `tg:u:undefined`。 | `parse` 包 try/catch 回 `[]`;新 `idStr()` 驗證 id 為 safe integer 或十進位字串,缺 id 的事件丟棄;entities 逐項驗型別。 |
| 5 | medium | **`/cmd@other_bot` 被當自己的指令**:regex 剝掉任何 `@xxx`。 | 後綴不是本 bot 的 username → 整則不理(`return []`);check 加 `/pause@other_bot` 不暫停的斷言。 |
| 6 | low | **長文字 chip 被 inline 按鈕蓋掉**:只要有 inline 就丟掉 reply-keyboard 的 keys;`slice(0,100)` 截短指令。 | `markup` 回 `{inline, keys}` 兩者;最後一則帶 inline,另補一則「⬇️ 接著可以:」帶 reply keyboard;key 上限放到 256。 |
| 7 | low | **operator 警告經 forwarder 時 `{chat}` 漏出**。 | 文案在建構時用 `chanFor(OPERATOR_LINE_USER_ID).vocab.chat`(#1 的做法一併解決)。 |
| 8 | low | **`/link` 成功文案漏掉第二條舊替換規則**(「把我拉進一個群,在群裡打 /status」在 Discord 退回 LINE 用語)。 | `Vocab` 加 `pullShort`,三個 channel 各自給值。 |

## 驗證

- `check:relay` + build 乾淨;`check:telegram`(含新加 2 項)、`check:line`、`check:discord` 全過;完整 smoke **451/451**。
- 流程備註:這輪 smoke 有兩次在「ledger lock 5 秒」那項失敗,與 codex 同時跑(CPU 忙)有關,第九、十次獨跑都過;另兩次失敗是
  wrangler 熱重載(smoke 中改了 relay-assets)與殘留 workerd 鎖住 SQLite,都已記進 memory 的 relay-local-smoke-gotchas。
