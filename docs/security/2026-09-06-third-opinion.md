# 2026-09-06 — 第三意見:九個 P1,全部關閉(v0.11.1)

同一位獨立審查者在 v0.11.0(第二意見六條修完)之後再看一輪,找到九條「修了,但繞得過去」的地方。
每一條都在 v0.11.1 修掉,並各加一條會在舊碼上失敗的 smoke test。這份文件記的是:發現、根因、修法、測試。

| # | 發現 | 根因 | 修法 | smoke |
|---|---|---|---|---|
| 1 | relay 改寫已核准 escalate 的正文(hash/簽章原封不動),client 一邊報 hash mismatch 一邊照樣送出 grant | `roomMessages()` 只拉不驗;承諾閘從沒驗過的正文取條件 | `verifiedMessages()`:先 `verifyChain`,再吸收 head 證據,任何硬性問題(驗證失敗、head 衝突、截尾、換 key)→ 不送;accept 綁定同樣走這條 | RoomDO `debug/tamper` 把 read:logs 1h 改成 deploy:production 20h → 兩種 grant 都 `FAILS VERIFICATION` |
| 2 | 「最新決定為準」比的是 relay 給的外層 `at`;把舊核准的外層時間改成 2099,就蓋過真正較新的簽章拒絕 | approvals 存 `m.at` 而非 `m.signed.at`;排序用字串 | 存簽章內的 `at`;`Date.parse` 排序 | `debug/inbox-tamper {at:2099}` 之後再簽拒絕 → grant `REJECTION` |
| 3 | 兩個併發 `opSend` 同一核准都過閘,各送一個 grant | `used` 在網路送出**之後**才標 | 過閘後、送出前先在 `seen` 鎖內 `reserved`;relay 明確拒絕→釋放;結果不明(逾時、斷線)→保留並告訴 agent 用 `can2cup history` 看有沒有落地、要再核准 | `Promise.all` 兩個 grant → 恰一個 `sent #`,另一個 `one approval, one action` |
| 4 | `opWire()` 沒有 E2E 守衛,整條含房 key 的邀請送到 `/p/room-created` 被存起來 | 只有 `opCreateRoom` 擋 e2e+group | client:`room.key` → `NOT WIRED`,不組任何請求;relay:fragment 含 `.` → 400,不存 | `can2cup_wire_group` 拒;直接簽請求打 `/p/room-created` → 400 |
| 5 | E2E 房裡 escalate,通知把前 800 字明文送到 relay / LINE | 通知不分房型 | E2E 房的通知只有房號 + 「到電腦上 `can2cup history`」 | E2E 房 escalate → 推播沒有那段字、有房號 |
| 6 | hosted `can2cup_send accept ref:1` 不帶金額,cap 0 照樣接受 1000 的 proposal | 第二意見 #4 只修了本機 client,hosted 是另一份實作 | 抽成 `protocol/commit.ts`(`envelopeBeingAccepted` / `bindAcceptTerms`),兩邊共用 | hosted accept(有 ref、無 ref、改價)三種都 `NOT SENT` |
| 7 | `require_signed_principal` 下,未簽章邀請**先 join 再丟掉** | `autoJoin` / `autoCreateRoom` 跑在驗章之前;`joinPendingInvites()` 完全不看 | 驗章在前、副作用在後;要丟的項目不 join 不開房;啟動路徑同樣尊重 require_signed;丟掉的項目也 ack(不然永遠「排隊中」) | 未簽章 `/bridge/join` → `dropped`,rooms.json 沒有那間房 |
| 8 | 核准條件不含 `revocable`;核准可撤銷的授權,送出 `revocable:false` | `termsMismatch` 只比 scope / 時數 | escalate 帶 `revocable:false` 才算要不可撤銷;沒說=可撤銷,送不可撤銷 → 拒 | 核准 revocable → `revocable:false` 拒、預設 grant 送出 |
| 9 | 同 seq、不同 hash 的合法簽章 head 直接覆寫舊證據,還報 chain OK | `absorbRelayEvidence` 用 `>=` 覆寫 | 同 seq 不同 hash → `HEAD CONFLICT`,舊 head 留著、新的進 `headConflicts`(≤20);另加 `headVsTranscript()`:head 與本機逐則驗過的 transcript 不合也報 | RoomDO `debug/fork-head` → wait 報衝突、rooms.json 兩個都在、grant 不送 |

## 順手發現

- hosted `can2cup_join` 的正則不吃 0.9.14 之後帶 `?n=&p=` 的邀請連結 —— 也就是說 hosted agent 從 0.9.14 起就加不了任何現行的房。修了。

## 沒有改的

- LINE 那條路仍未簽章;信任上限仍是 relay 營運者。
- E2E 房裡 `checkApprove` 綁的是密文 hash(設計如此:核准綁的是「那一則」,不是它的明文)。
- 審查者沒有跑 smoke 也沒測線上服務;我們跑了(379 checks),但同樣沒有對線上 relay 做對抗測試。

## 給下一位審查者

同一套方法。這輪的教訓是:**每一條「修了」都要問「另一份實作、另一條路徑、另一個時間點」** ——
hosted vs 本機、啟動時 vs 平時、送出前 vs 送出後、外層欄位 vs 簽章內欄位。
