# 第九意見(Claude Fable 5.1,0.16.0 出貨前整體審查)

security session · 2026-09-10 · 審查者:**Claude Fable 5.1**(subagent,唯讀)· 對象:v0.15.0..064192e 整個出貨面 —— channel registry、
Telegram adapter 與 forge 工具、client 去 LINE 假設、dashboard 第一階段的 proof / token / 索引生命週期、`purgeCounters`
狀態:**1 medium + 4 low + forge 工具建議;全部修入 0.16.0。** 原訂 codex high 兩度撞額度,老闆決定改由 Fable 審。

審查者確認**沒有問題**的:`/p/principal` 先驗 claim 再寫;`verifyAgentClaim` 六項檢查(kind、簽章者 == principalPub、agent == 驗過的 caller、relayPub 與 `GET /` 同源、nonce、±5 分鐘、canonical bytes 簽章)完整;proof 與索引只在有效 claim 時寫、換 P 無 proof 時一起刪、erase 兩種 scope 都刪、idle 到期 `keepSigned` 一起留;`provenPrincipal` 每次比對 proof ↔ 目前 P ↔ relayPub,`dashboardFor` 對索引中每個 pub 再驗主紀錄;`dashboardFor` 只能由簽章驗出的 pub 或 OAuth token 的 pub 進入,principal scope 需 `tok.principal === proven`,舊 token 一律 self;未證明的查詢者碰不到索引。Telegram `parse` 全包 try、`idStr` 驗 id、DO 路由每事件 try/catch;`alarm()` 形狀未變。bot.ts 與 v0.15.0 的 diff 只有 `/quota`(LINE 文字相同);retry / 每對象 60 / 每房 40 / ban 閘不變;LINE 仍以 180 擋;`/p/state`、`/p/claim`、`/bridge/quota`(無 `?user=`)形狀不變。`Dashboard` 型別兩邊逐字相同;`registerPrincipalProven` 對舊 relay(無簽章金鑰)以 `""` 相符;無漏 await。`purgeCounters` 的四種桶正則正確,活的 key 不會被刪。

## 已修

| # | 嚴重度 | 問題 | 修法 |
|---|---|---|---|
| 1 | medium | **health 分類兩邊都錯**:(a) 401(bot token 失效,三個平台皆然)只記在該目標,不再標 channel 級,其他人要等自己的目標失敗才知道;(b) Discord adapter 對「開不了 DM」回 `status: 0`,`deliver` 丟掉 0 → 被當成 channel 級且可重試,六次重試 30 分鐘、全 Discord 標紅。 | `channelWide` 加 401;discord.ts 的兩個 per-target 失敗改回 400 / 404。 |
| 2 | low | **forge 工具會改掉真人的快取顯示名**:`parse` 每則 Update 都 `remember(uid, nameOf(from))`,forge 的 `first_name: "forged"` 會頂掉 6 小時;而且 `remember(uid, undefined)` 也算命中,壓掉 `getChat` 查詢。 | `parse` 只在有名字時才快取;forge 工具不再送 first_name。 |
| 3 | low | **`purgeCounters` 沒涵蓋全部時間桶 key**:`reports:<pub>:<day>` 漏掉;`code:` / `pcode:` 只在兌換成功時刪,沒兌換的永遠留著。 | 前綴加 `reports:`;`purgeExpired` 依 `at` 清超過 TTL + 1 小時的 `code:` / `pcode:`。 |
| 4 | low | **admin 介面仍講全站計數**:`/admin/activity` 的 `pushes` 是舊的全站 `quota:<month>`(所有 channel 都加),對照 180 的 LINE 額度會被 Discord / Telegram 灌高。 | 加 `pushesByChannel`(每 channel 的 n 與 budget);全站數字保留給相容。 |
| 5 | low | `can2cup status` 第 5 項前半改讀 channel 名,後半仍寫「in LINE: /a …」。 | 後半同樣用 `chatAppLabel`。 |
| D | 建議 | forge 工具預設打正式 relay、可驅動 `/unbind` `/forgetme` `/link`,打錯 `--user` 就動到陌生人;relay 要不要分辨 forge 與真 Update。 | `say` 對 `/unbind|/forgetme|/erase|/link` 需 `--force`;forge 不送顯示名。relay 端不區分(exercising production path 正是目的),IP 範圍標記列為之後可做。 |

## 驗證

- `check:relay` + build 乾淨;`check:telegram` / `check:line` / `check:discord` 全過;完整 smoke **470/470**。
- 本輪之前老闆自審(同日)已修:時間桶計數 key 從不清理(`purgeCounters`)。
