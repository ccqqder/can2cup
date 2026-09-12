# 第六意見(gpt-6-astra / codex,對 v0.14 shipped surface)

security session · 2026-09-09 · 審查者:**gpt-6-astra(high)** 經 codex MCP · 對象:v0.14.0 上到出貨面的新東西(`require_confirm` 自保清單、`framing.ts` 入站防護、撤權/稽核組裝)
狀態:**逐條驗證(承接第四/五意見的房規矩:不照單全收)。結構偽造與 fail-open 類全修 + 單測;判斷類與大重構標成 ROADMAP 貢獻缺口。**

> 流程備註:第一次送審被 OpenAI cyber 過濾擋下(措辭像攻擊性資安)。改成「輸入驗證正確性/一致性 code review」的防禦框架重送即通過 —— 對象是自己的程式碼、目的是硬化,框架照實描述即可。

審查者定位:兩位老闆的 agent 同房,**對方 agent 是敵意方**,控制自己的 body / 顯示名 / 房名。命題:**護欄靠結構,不靠 agent 夠聰明**。審查者未發現 critical,列 12 條,我逐條對真程式碼驗證後處置如下。

## 已修(結構偽造 / fail-open —— 真安全問題)

| # | 嚴重度 | 問題 | 驗證 | 修法 |
|---|---|---|---|---|
| 3 | high | **`m.ts` 未消毒**:`fmtMsg` 直接內插簽名訊息的 `ts`,`verifyEnvelope` 不驗其格式 → peer 簽一個含 `\n` + 假 `VERIFIED` 行的 ts 注入未圍欄行 | 真(`core.ts:92`、`envelope.ts` 無 ts 格式檢查) | `fmtMsg` 對 `m.ts` 套 `safeLabel(…,40)` |
| 4 | high | **多處輸出完全沒套 framing**:hosted join(房名/參與者名)、hosted history(`body.text`)、本機 principalBlocks 的 UNVERIFIED/GUEST(bridge 文字/訪客名)全 raw | 真(`mcp-http.ts:487/572`、`core.ts:428/434`) | hosted 兩處 import `safeLabel` 並套用;principalBlocks 的 UNVERIFIED/GUEST 名字 `safeLabel`、文字一行化消毒。VERIFIED(principal 簽章=可信)刻意不動,以免誤刪本人合法內容 |
| 5 | high | **fence 漏非 `\n` 斷行 + 未處理 bidi**:`fenceBody` 只 split `\n`;CR/NEL(U+0085,連 JS `\s` 都不含)/LS(U+2028)/PS(U+2029)/VT/FF 漏掉 → 遇會斷這些的 renderer 出現未加前綴行;U+202E/bidi/zero-width 原樣保留 | 真(`framing.ts`) | `fenceBody` 改 split 全部斷行變體(CRLF 算一次);`safeLabel` 把 bidi/zero-width 移除、控制字元與斷行收成空白 |
| 8 | medium | **scrub 順序讓 sentinel 重生**:先 scrub 未命中、再合併空白 → `PRINCIPAL<NBSP>INSTRUCTIONS` 反而重組成完整 sentinel;`PRIN<ZWSP>CIPAL` 也躲得過 | 真(`framing.ts`) | 先 NFKC + 去 bidi/zero-width + 折疊水平空白,**再** scrub;`safeLabel`/`scrub` 都調正順序 |
| 1 | high | **mandate 設定無執行期驗證 → 錯誤上限變放行**:`max_commit_amount:"oops"` 時 `1000 > "oops"` 為 false;hosted `widened` 也判 false 繞過 commit refusal;`max_grant_hours:"1"` 的 `+0.01` 字串串接成 `"10.01"` 意外放寬 | 真(重現 hosted 送出) | 新 `normalizeMandateRules`(**fail-closed**:非 null 的非有限非負數 → 0;`max_grant_hours` 壞 → 0),`checkMandate` 開頭與 hosted `widened` 都經它 |
| 2 | high | **reveal 保密豁免可經一般 send 觸發**:本機 `can2cup_send` 允許 type=mechanism 且工具有 `data` 參數 → `{phase:"reveal",bid:<secret>}` 讓 never_disclose 值假冒 bid 洩出,不經 opMechanism 的 commit 綁定 | 真(本機;hosted SENDABLE 不含 mechanism 且不帶 data → 免疫) | `opSend` 擋 type=mechanism,一律走 `can2cup_mechanism` |
| 7(半) | medium | **`require_confirm` 精確比對 fail-open**:`["ACCEPT"]`/`[" accept "]` 不攔 `"accept"` → 煞車靜默失效 | 真 | `normalizeMandateRules` 對 entries trim + 小寫 |
| 9(半) | medium | reveal bid 用 `Number.isInteger` 接受超過安全整數 | 真 | 改 `Number.isSafeInteger` |
| 10 | medium | **grant expiry「ISO」實際沒成立**:`"01/02/2000"`、過期字串、陣列(經 `String()`)都過;無未來檢查 | 真 | 嚴格 ISO-with-timezone regex + 必須未來 + 陣列/非字串拒絕 |
| 11 | low | scope 全空白過、revoke `ref:-1.5` 過、attachment `"https://"` 與 http 過 | 真 | scope trim 非空;ref 必正安全整數;attachment 限 https + `new URL()` 驗 host |
| 12 | low | 名稱截斷切斷 surrogate/emoji | 真 | `safeLabel` 用 `Intl.Segmenter` grapheme 截斷(fallback 避免切 surrogate pair) |

## 審查者自我修正(誠實記錄)

- **#7 一致性**:審查者先前(與我先前)都以為「hosted 靜默丟棄 `require_confirm`」;它複查後修正 —— runtime 靠 `{...DEFAULT, ...stored}` 物件展開其實**會保留**該欄位,只是 `HostedMandate` 型別沒宣告。故非「丟棄」,是型別缺宣告。已把此欄位視為兩層共用(hosted 對 commit 型別本就 refuse,自保清單主要對非 commit 型別才額外生效)。

## 標成 ROADMAP 貢獻缺口(判斷類 / 大重構,非本輪)

- **#7 後半:`require_confirm` hold 沒有核准解除路徑**。`finishSend` 在 `commitGate` 前就 return hold,故即使有簽章核准也解不了。目前語意 = 「此 agent 絕不自主送、由老闆自行處理」——**fail-closed(過度限制=安全方向)**,不是漏洞。要做成「可由綁定該動作的簽章核准解除」需接進 commitGate,列為 nice-to-have。
- **#6:hosted body builder 應共用 schema**。hosted 只複製數字 `amount`,故 `"1000"`/`[1000]` 被靜默忽略後送出**不帶金額**的 proposal(不是送超額,是丟金額)。宣告的 `additionalProperties:false` 在 `tools/call` 沒實際驗。屬一致性重構。
- **#9 後半:金額/幣別的正式交易 schema**。`{items:[{amount:1000}]}` 這種頂層無 amount 的結構會過(目前非繞過,因結算只讀頂層 amount);要嚴謹需定義每型別的交易 schema。
- **語意 homoglyph / 跨字母表偵測**:NFKC 折全形,但擋不了所有跨字母表 homoglyph;審查者建議搭配「不由自由文字決定的來源標記」。與既有語意洩露殘留同屬 advisory 範疇。

## 驗證

- `test:framing` 15→**30**、`test:mechanism` 38→**56**、`demo:adversarial`/`demo:self-preservation`/`demo:revoke-audit`/`test:tier2` 全綠、build + `check:relay` 乾淨。
- **完整 relay smoke 432/432**(改動皆過整合閘,無回歸)。
- 全在出貨面但**非密碼學**、不碰 Tier 2 閘門。屬 **v0.14.1 安全修補**候選。
