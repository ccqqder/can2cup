# 「我名下的 agent」—— dashboard 第一階段:hosted MCP 工具 + `/p/dashboard`

狀態:**已實作(0.15.2)**。codex(medium)第二意見 8 條全部折入,見 §7;ROADMAP 的 dashboard 條目第一階段完成。ROADMAP 的 dashboard 條目拆成兩階段:本文件是第一階段(資料 + connector 工具 + CLI),第二階段才是 HTML 頁。

## 1. 問題

- 一個人常有好幾台 agent(一台綁 Telegram、另一台綁 Discord、hosted 的零安裝 agent);今天要知道「哪台綁哪個 app、在不在線、接了哪些群」得一台一台跑 `can2cup status`,或到每個 app 打 `/status`。
- claude.ai 的 remote connector(`/mcp`,OAuth)本來就是「人」在用的入口,不綁單一機器,但它的視角目前 = 「OAuth 當時用的聊天帳號所綁的那一個 agent」。實際遇到的情形:connector 還綁在 LINE 測試期留下的舊 agent 上,列出來的都是舊房 —— 正是問題本身。

## 2. 身分:以 principal 為中心

- 每台本機 agent 上線時把 principal 公鑰登記到 relay:`/p/principal` → `principal:<agentPub> = P`。
- **「我名下」= 所有 `principal:<pub> == P` 的 agent**,加上 connector 自己的 agent。P 從 connector 的 agent 反查:`tok.pub → principal:<pub> → P`。
- **證明**(新):今天 `/p/principal` 只有 agent 簽章,`principalPub` 是自報的 —— 任何 agent 都能登記「別人的」P,把假的一列塞進別人的清單(拿不到別人資料,但能造噪音、冒名)。改成登記時附 **principal 簽章的 proof**:`signPrincipal({ kind: "claim-agent", agent: <agentPub>, principalPub: P, at })`,relay 用 P 驗過才存 `principalProof:<pub> = at`。dashboard 只列**有 proof** 的 agent(加上 connector 自身);舊的未證明登記不列,並在結果裡提示「跑 `can2cup principal init`(或升級後重啟)以登記證明」。client 端:`registerPrincipal` 在有 `principal.json`(含私鑰)時一律附 proof;沒私鑰的機器(只同步了公鑰?principal.json 本來就含私鑰)不會發生。
- hosted agent(relay 持鑰)沒有 principal key:只在它就是 connector 自身時出現。已知限制,寫進工具說明。

## 3. 資料:一個函式,三個出口

BridgeDO 新 `dashboardFor(callerPub)` → JSON,全部來自既有 key,無新儲存:

```
{ principal: P | null, proven: boolean, agents: [ {
    pub, short, name, custody: "local"|"hosted", host, version,
    presence: { online, lastSeen, sinceMin },
    binding: { channel, userId(short), boundAt, idle: {days, expiresAt, forever}, paused, agentMode } | null,
    channelHealth: { state, channel, okAt, failAt, status } | null,
    groups: [ { alias, name, channel, wiredRoom | null } ],
    rooms: { open, total, ids: [ { id, name, lastSeq } ] },
    pendingInstructions: n,
    self: boolean
} ], note?: string }
```

- 出口 1 **hosted MCP 工具 `can2cup_status`**(唯讀;走 connector 時本機金鑰的 agent 本來就唯讀):回上面的 JSON 加一段人讀的摘要(每台一行:`🟢 alice (win, 0.15.1) — Telegram, 2 groups, 2 open rooms`)。
- 出口 2 **`/p/dashboard`**(agent 簽章)給 CLI `can2cup status --all`。
- 出口 3 之後的 HTML 頁直接吃同一份。

不列的:live grants(要抓每房 transcript 驗鏈,成本高;`history` 已有)、audit 尾巴(本機資料)。

## 4. 邊界

- **唯讀**:連 connector 都不提供動作;unbind / keep / pause 留在簽章路徑。
- **隱私**:只回 principal == P 且有 proof 的 agent;peer 可控字串(agent 名、群名、房名)一律 `safeLabel`;userId 只給截短。
- **hosted 面配額**:沿用既有 tools/call 的 ban 與速率;dashboard 讀 N 個 agent 的十幾個 key,N 小(個位數),可接受;>50 個 agent 時截斷並說明。
- **舊 connector 綁定**:新設計後 connector 自動變成人視角(只要它的 agent 有 proven principal);測試期留下的舊 agent 沒有 principal,會只看到自己 → 提示重新 `/link` + OAuth,或在那台跑 `can2cup principal init`。

## 5. 測試

- smoke(hosted rpc 骨架):`can2cup_status` 對 hosted agent 只列自己;對綁了 proven principal 的兩個本機 agent(alice、gina 共用 principal)列兩台;第三台自報同一 P 但無 proof → 不列;`/p/dashboard` 與工具回同一份;`status --all` 印摘要。
- `/p/principal` 帶錯 proof(別人的 principal 簽)→ 400;不帶 proof → 存但 `principalProof` 不存在(相容舊 client)。

## 6. 工作量

BridgeDO 函式 + `/p/principal` proof + 工具 + `/p/dashboard` + CLI 旗標 + client 端 proof + smoke 約一天。

## 7. 第二意見(gpt-6-astra medium,2026-09-10)與處置

| # | 嚴重度 | 意見 | 處置 |
|---|---|---|---|
| 1 | high | **查詢者自己也要有 proof**:否則攻擊者用無 proof 登記你的 P,再查 dashboard 就列出你所有 proven agent。 | `dashboardFor` 先算 caller 的 `provenPrincipal`;沒有 → scope `self`,**不查索引**、不回 P 是否存在。 |
| 2 | high | **proof 要跟 P 持久綁定**:只存 `at` 的 marker,先用自己的 Q 拿 proof、再用舊 client 路徑把 `principal:` 改成 P,就被誤判 proven。 | 存 `{principalPub, relayPub, at, verifiedAt}`,每次使用比對目前 P 與本 relay;無 proof 換 P → 清 proof 與索引;erase 一併清。 |
| 3 | high | **舊 OAuth token 會跟著 agent 換 principal**而取得跨 agent 權限。 | token 發放時記下當時 proven 的 P;工具呼叫時只有 token.P === 目前 proven P 才給 principal scope;舊 token(無欄位)→ self。 |
| 4 | medium | 需要**專用簽章格式**、綁 relay 公鑰、新鮮度;現有 `verifyPrincipal` 不做這些。 | `protocol/principal.ts` 新 `signAgentClaim` / `verifyAgentClaim`:簽 `{kind, agent, principalPub, relayPub, at, nonce}`,驗 signer === principalPub、agent === caller、relayPub === 本 relay、±5 分鐘。 |
| 5 | medium | 群組歷史 ≠ 目前授權;欄位要明確挑選、`short()` 不算遮罩、health 含共享 detail。 | 群組稱「已知」,`wiredRoom` 需 `inRoom()`;不展開 participants / 他人 binding;`userIdHint` 只留前綴+3 字;health 只挑 state/okAt/failAt/status。 |
| 6 | medium | 全掃 `principal:` 是 O(M);沒有通用限流。 | 索引 `principalAgent:<P>:<pub>`(只為 proven 建,換 P / erase 同步刪);取 51 筆判截斷;每 agent 每小時 60 次。 |
| 7 | medium | 相容提示要區分「未證明」「沒有 P」「hosted」「connector 綁舊 agent」;啟動登記有兩處且吞錯。 | `principalStatus` enum + 對應 hint;登記合併到 core.ts 一處。 |
| 8 | low | DTO 命名:`relayHost` 非機器名、`rooms.items`、`unreadInstructions`、`paused` 放 agent 層、加 `callerPub/scope/generatedAt/truncated`。 | 全部採用;`/p/dashboard` 不在 presence touch 清單。 |

驗證:smoke 新增 15 項(proof 登記、ada 同 principal 出現、eve 無 proof 不出現且只看自己、錯 agent / 錯 relay / 過期 / 簽章者不符四種 400、Q→P 無 proof 切換掉 proof、hosted 只看自己、敏感欄位不存在、CLI `--all` 與 `--json`)。
