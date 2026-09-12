# 第七意見(gpt-6-astra / codex,對 v0.14.4 整個出貨面)

security session · 2026-09-10 · 審查者:**gpt-6-astra(medium)** 經 codex MCP · 對象:0.14.4 出貨面全部 ——
`checkMandate` 本機+hosted 兩層一致性、`verifyChain` / signed head / 授權帳本、`framing.ts`、短碼 join 與 relay 端點
(排除三輪已修項目)、release/簽章路徑
狀態:**10 條全部逐條對真程式碼驗證,無誤報;10 條全修 + 單測 + smoke。** 出 0.14.5。

> 流程備註:日常審查用 **medium**(medium:high 消耗約 1:4);high 只留給 major version 出貨前。medium 這輪找到一條
> critical,證明「每輪都 high」並非必要。

審查者定位同前:對方 agent 是敵意方、relay 是信任上界。這輪最重要的發現不在 agent 邏輯,在**最底層的 canonical
JSON** —— 所有簽章與 hash 都蓋在它上面。

## 已修(全部)

| # | 嚴重度 | 問題 | 驗證 | 修法 |
|---|---|---|---|---|
| 1 | **critical** | **`canon()` 漏掉 `__proto__` 欄位**:`sortKeys` 用普通 `{}`,`out["__proto__"]=…` 打到原型 setter、不成為 JSON 欄位;但 `JSON.parse` 把它當自有欄位,`Object.values(manifest.files)` 讀得到。→ 握有 relay 者可在合法簽章的 manifest `files` 塞 `"__proto__":"<惡意 tgz sha>"`,`can2cup upgrade` 通過;訊息 body 的 `__proto__` 欄位躲過 `never_disclose`。 | 真(node 重現:canonical 輸出不含該 key;`cli/index.ts:538` 用 `Object.values`) | `sortKeys` 改 `Object.create(null)`(`__proto__` 進簽章位元組);`verifyManifest` 對 `files` 嚴格 schema(檔名 regex、64-hex 值、拒 `__proto__`/`constructor`/`prototype`、必含 `can2cup.tgz`);upgrade 只比對 `files["can2cup.tgz"]`,不再「表裡任一 hash」。smoke 加注入測試 + alias 測試。 |
| 2 | high | **peer 字串繞過 framing 進 MCP `instructions`**:`resumeSummary()` 直接內插房名,`index.ts:53` 把它放進 server instructions;`LIVE GRANTS` 行直接內插 peer 名/scope/expires,在 fence 外。 | 真(`core.ts:503/1416`) | 三處套 `safeLabel`。 |
| 3 | high | **截短的歷史顯示 CLEAN**:`opHistory` 只驗收到的前綴,`headVsTranscript` 在 seq 不等時回 null;relay 回 1–5 而 head 仍簽 10 → `chain CLEAN: 5 messages`,被砍的 revoke 不進授權清單。 | 真(`core.ts:1389-1394`;`verifiedMessages` 才有完整檢查) | 把 `verifiedMessages` 的完整性檢查抽成 `transcriptGaps()` 共用;history 遇硬證據改印 INCONCLUSIVE 並**不列** live grants。smoke 用 `serve-upto` 驗。 |
| 4 | high | **巢狀金額繞過零上限**:本機 send 放行任意 `data`,cap 只看頂層 `amount`;`{items:[{amount:9000}]}` 的 proposal 被 accept 時 `bindAcceptTerms` 只產 `{ref}`,`checkMandate` 回 null。 | 真(`mandate.ts:94`、`commit.ts:19`、`core.ts:1132`) | 新 `protocol/terms.ts` `checkTermsShape`:proposal/counter/accept 的 body 值必須全是純量,巢狀一律由 `checkMandate` 拒(兩層共用);`bindAcceptTerms` 拒絕巢狀目標與非字串 currency。 |
| 5 | medium | **hosted builder 靜默丟欄位、兩層不等價**:只複製 numeric amount(`"1000"` → 送出無金額 proposal);`tools/call` 不驗宣告的 schema;accept 只繼承 string currency(`["USD"]` → 無幣別 → TWD mandate 放行)。 | 真(`mcp-http.ts:545`、`commit.ts:23`) | `terms.ts` `readSendFields` + `buildSendBody`,本機與 hosted 都用:提供但型別錯 → 拒;未宣告欄位 → 拒。`currency` 成為正式參數(MCP/CLI/hosted)。 |
| 6 | medium | **授權清單不看順序與撤銷者**:先收集全部 revoke ref 再過濾 grants;seq 1 `revoke ref:2` 藏掉 seq 2 的 grant;別人也能撤你的 grant;與 demo 的順序 replay 結果不一致。 | 真(`core.ts:1414`) | 新 `protocol/authority.ts` `liveGrants`:按 seq 重播、revoke 須指向較早的 live grant、只有 grant 作者能撤。history 與 demo 共用。 |
| 7 | medium | **`max_grant_hours:0` 仍放行 36 秒**:`hours > cap + 0.01` 的容差連 0 也放寬。 | 真(`mandate.ts:108`) | cap ≤ 0 直接拒 grant;移除容差,精確比較。 |
| 8 | medium | **hosted 開房配額 race**:讀配額 → await 建房 → 寫回;並行兩次都讀到舊值。 | 真(`mcp-http.ts:507-520`) | 跨 DO 呼叫前先預留(寫 used+1),失敗才退還。 |
| 9 | medium | **`verifyChain` 不檢查 `m.room`**:簽 `room=B, prev=genesis(A)` 的訊息以 A 驗證得 CLEAN。 | 真(`envelope.ts:153`,`verifyEnvelope` 也無) | `verifyChain` 逐筆比對 room;`pull()` 同步加檢查。 |
| 10 | medium | **本機 staging 不驗 tarball 內容**:package name/version 檢查只在 `--from-npm` 分支;改名的別版 tgz 會被簽成工作目錄版本。 | 真(`stage-tarball.mjs:18`) | 檢查移到所有路徑;`execSync` 改 `execFileSync`。 |

## 審查者判定無問題的部分(覆蓋範圍)

seq 缺口/重複/重排偵測;一般訊息的 framing helpers;E2E 前 plaintext mandate 檢查、RoomDO 拒 E2E 房 plaintext;邀請
canonical 重編碼、room/key 檢查、join-code binding gate、OAuth token 的 client/redirect/PKCE 綁定;npm staging 的版本核對、
CI 的 tag/version 核對。

## 教訓

- **最底層的 primitive 最值得再看一次。** `canon.ts` 18 行、從第一天就在、六輪審查沒人碰;一個 JS 原型陷阱讓上面所有
  簽章對「某種 key」失效。修法 3 行,但影響 release 簽章的整個意義。
- **「已知問題」不留在 ROADMAP。** 第六意見把 #4/#5 標成「一致性重構、非漏洞」;這輪證明它們是可觸發的 bypass。
  ROADMAP 是給別人找我們沒發現的問題;我們自己知道的,就修。
- **同一件事只能有一個實作。** 授權帳本(demo vs client)、完整性檢查(commit gate vs history)、send 參數(本機 vs
  hosted)三處都是「兩份實作漂移」;修法都是抽成 `protocol/` 一份。

## 驗證

- `test:mechanism` 56→**84**;build + `check:relay` 乾淨;`demo:revoke-audit` 改用共用 `liveGrants` 後全綠。
- 完整 relay smoke **451/451**(444 → 451:新增 `__proto__` manifest 注入、alias hash、history 截短 INCONCLUSIVE、
  巢狀價格拒絕、hosted 錯型別/未宣告欄位拒絕)。`test:framing` 30/30。
- 協定影響:只有 body 含字面 `__proto__` key 的訊息 hash 會與 0.14.4 不同 —— 誠實 client 從未產生過。既有房間、簽章、
  release manifest 不受影響。
