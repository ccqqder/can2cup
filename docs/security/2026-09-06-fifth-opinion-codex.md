# 2026-09-06 — 第五意見(codex / gpt-6-astra 複查 v0.11.2):九條 P1 + 一條 P2,全修(v0.11.3)

第四意見的同一個模型、乾淨上下文,只給它一個範圍:**複查 v0.11.2 的十條修法**(「另一份實作、另一條路徑、另一個時間點」)。
它這次自己搭了測試架(把 src/mcp、src/protocol 轉譯到 scratch、relay-client 換成記憶體回應、兩個 Node 程序重現鎖競態),
九條 P1 每條都附了它跑過的重現。逐條對源碼確認:**九條全部成立**。全修在 v0.11.3,各加一條會在 0.11.2 上失敗的 smoke(#3、#8 例外,見下)。

| # | 發現 | 對源碼確認 | 修法 | smoke |
|---|---|---|---|---|
| 1 | gate 讀收件匣失敗被當成「沒有新消息」;拒絕的 envelope 抓不到時,nonce 記了、決定丟了、還 ack | 成立:`principalInbox` 的 catch 回傳空 Sorted;拒絕也要 `checkApprove` 確認才進帳本 | `Sorted.failed`:讀失敗 → gate 擋「收件匣讀不到,可能有決定在等」;拒絕不需要確認就進帳本(它只拿走權限) | bridge `debug/inbox-fail` → grant 擋;serve-upto 讓拒絕的 envelope 抓不到 → 帳本仍有 ok:false → grant `REJECTION` |
| 2 | v0.11.2 之前存的 rooms.json 沒有 `e2e` 欄位;升級後沒 key 的舊 E2E 房照樣以明文送出(relay 會拒,但明文已到 relay) | 成立:只有 join 會寫 `e2e` | `e2eKnown()`:沒 key 且 `e2e === undefined` → 先問 relay 一次記下來,問不到就不送;join/create 一律明寫 `e2e: true/false` | 把 eve 的 rooms.json 刪掉 `e2e` → send 擋,且欄位補回 true |
| 3 | 兩個讀者:B 先推游標、還在 `checkApprove`;A 用推過的游標讀到空、reserve 舊核准送出;B 才把拒絕寫進帳本 | 成立:游標在抓到就存 | 游標改在**帳本合併之後**才推 —— 看到推過的游標就代表帳本至少一樣新 | 無法穩定重現;結構性修法 |
| 4 | `principalKey()` 只在 null 時重讀;跑著的時候換 principal.json,B 的拒絕過不了 A 的驗章、被丟並 ack;A 的舊核准照用 | 成立 | 每次都重讀;帳本每條決定記 `by`(簽章者),`latestDecision` 只算現任 principal 的(舊條目沒 `by` 的照舊算) | 換成 B 並向 bridge 註冊 → 舊核准「needs a signed approval」;B 簽的核准不重啟就生效;換回 A |
| 5 | 較新的拒絕因超過 30 天被丟(還 ack),更舊的核准繼續能用 | 成立 | 拒絕永不算 stale;核准超過 30 天 gate 就不認(`older than 30 days`) | 36 天前核准(注入)+ 35 天前簽的拒絕 → `REJECTION`;40 天前核准 → 擋 |
| 6 | 已花掉的核准與 nonce 各有計數上限(2000 / 5000),越過就能重播 | 成立 | 不再按計數:nonce 改記 `{n, at}` 按**年齡**修剪(兩倍視窗);used/reserved 的核准也按年齡留;超過視窗的項目本身就會被當 stale 拒 | 既有 400 條 filler 測試仍過;年齡規則靠 #5 的測試 |
| 7 | 同一個簽章 `at` 的核准 + 拒絕(不同 nonce)被去重成一條,拒絕被吃掉 | 成立:去重鍵是 room/hash/at | 帳本記 `nonce`,以 nonce 去重;`latestDecision` 同時刻時拒絕排後(拒絕贏);reserve 也用同一個函數 | 同一 `at` 先核准後拒絕 → 帳本兩條、grant `REJECTION` |
| 8 | 兩個程序同時回收一個死掉的鎖:A 確認持有者死了、停在 unlink 前;B unlink 並建了自己的鎖;A 醒來 unlink 掉 B 活的鎖 | 成立 | 回收改成原子 `rename`(只有一個程序成功);釋放前確認鎖檔內容是自己的 pid 才 unlink | 死 pid 的舊鎖 → 回收、grant 出、沒留 `.stale`;兩程序競態無法在 smoke 穩定重現 |
| 9 | `saveRoom` 整個覆寫:A 讀房、等網路;B 記下衝突 head;A 存回舊快照,衝突消失。另外 `slice(-50)` 會丟第一條 | 成立 | `saveRoomUnlocked` 在鎖內**合併**磁碟上的 `headConflicts`(以 hash 去重),磁碟與快照的 head 同 seq 異 hash 也記進去;上限 200 | 外部往 rooms.json 塞一條衝突 → alice 的 server 存房之後它還在 |
| P2 | gate 已 ack 的收件匣項目,在「房已關」「房到期」「丟例外」三條路徑上沒回給 agent | 成立 | 三條路徑都 `withInbox`;例外時把 principal 區塊接在錯誤訊息後面 | — |

## 這一輪的教訓

- **同一個模型第二次看,還是找得到。** 九條裡有五條(#1、#3、#4、#5、#7)是 v0.11.2 才引進的修法本身的邊界:
  修法寫成「讀收件匣」就要問「讀失敗呢」;寫成「去重」就要問「鍵選對了嗎」;寫成「null 時重讀」就要問「不是 null 但變了呢」。
- 它自己搭了測試架來跑重現,比第四輪的純推論可信得多。
- 這一輪分類器擋了兩次(附註裡的 crash injection / failover authorization 字眼),最後靠「範圍切小 + 中性措辭 + 邊做邊寫 notes.md」拿到報告;
  報告寫完前又撞到用量上限,靠 notes.md 與它已寫出的 report.md 補齊。範圍 B(遷移 / mirror / promote / viewer / A2A)與 C(檔案耐久性、丟失回應、三程序併發)還沒跑。

## 沒有改的

- LINE 那條路仍未簽章;信任上限仍是 relay 營運者。
- `withLock` 的 `holderAlive` 把所有 `process.kill` 錯誤當「死了」;審查者指出 EPERM(對方是提權程序)會誤判。本機 agent 不會以提權跑,先記著。
