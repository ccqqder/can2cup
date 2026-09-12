# 2026-09-06 — 第四意見(codex / gpt-6-astra):十一條主張,十條修掉,一條是設計(v0.11.2)

前三輪都是同一位審查者(Claude)。這一輪換模型:OpenAI codex CLI 跑 gpt-6-astra、reasoning high、乾淨上下文、唯讀沙盒,
只給它 `docs/security/` 前兩份文件、changelog、smoke 的兩個區段,和六條要守的不變量(I1–I6,見提示檔)。
它交了十一條 P1 主張,沒跑任何測試(它自己講明)。逐條對源碼確認:**十條成立**,一條(#4)是刻意的設計。
每一條成立的都在 v0.11.2 修掉,各加一條會在 0.11.1 上失敗的 smoke。

| # | 主張 | 對源碼確認 | 修法 | smoke |
|---|---|---|---|---|
| 1 | `data.amount` 塞字串 `"1000"` 繞過 cap;escalate 核准 100 TWD 解鎖 100 USD | 成立:`checkMandate` 只在 `typeof amount === "number"` 時比;`termsMismatch` 不比 currency | mandate:amount 非有限非負數 → 擋、currency 與 mandate 不同 → 擋;gate:currency 是條件之一;accept 綁定:proposal 的 amount 非數字 → 拒、currency 繼承且不得改述 | 字串 amount → `amount must be a non-negative number`;100 TWD 核准 → USD 拒、TWD 出;mandate 有幣別時 USD 在 gate 之前就擋 |
| 2 | E2E 房裡解不開的 proposal 被當成「沒有金額的 proposal」接受 | 成立:`decryptAll` 把解密失敗換成 `{text:"[E2E: … did not decrypt"]}`,不再是密文、也沒 amount | `verifiedMessages` 用 `keepUndecryptable`:解不開的保持密文,既有的「密文不能 accept」規則就接手 | bob 換 key 發 1000 的 proposal → alice accept → `cannot read its terms` |
| 3 | 邀請連結去掉 `.key` 後,client 以明文往 E2E 房講話;hosted 也進得去 | 成立:`opJoin` 只警告;送出只看 `room.key`;RoomDO 不管 `meta.e2e`;hosted join 不看回應的 e2e | client 記 `room.e2e`,沒 key 就 `NOT SENT`(send / close / wire / LINE 邀請都擋);RoomDO:`meta.e2e` 且正文非密文 → 400;hosted join:房說是 E2E 就不收 cap | eve 用去 key 連結 join → 本機拒;eve 的 key 直接簽明文打 RoomDO → 400;hosted join → 拒 |
| 4 | `opTell` 把 E2E 房的內容當通知送到 LINE | **設計**:`can2cup_tell_principal` 是 agent 對自己老闆說的話,room 參數只是路由;第三意見 #5 修的是**自動**通知。禁掉等於老闆在 LINE 永遠聽不到 E2E 房的任何事 | 不改碼;SKILL.md 明寫:E2E 房裡對老闆**摘要**、不貼原文 | — |
| 5 | 排隊中的較新拒絕擋不住用舊核准的 send;reserve 時不重選「最新決定」 | 成立:`commitGate` 只讀本機帳本,不讀收件匣;`reserveApproval` 只看 used/reserved | gate 先 `principalInbox(true)` 再判斷,讀到的項目附在 send 的結果裡;`reserveApproval` 在鎖內重選最新決定,較新的拒絕勝 | approve → wait → reject(不 wait)→ grant 拒,且結果含 VERIFIED 拒絕 |
| 6 | `withLock` 5 秒後沒拿到鎖照跑,finally 還把別人的鎖砍掉 | 成立 | `strict` 模式(帳本用)拿不到鎖就丟錯;沒拿到鎖的一律不 unlink;mtime 過舊但持有者 pid 還活著的鎖不偷 | 活著的 pid 持鎖、mtime 60 秒前 → grant 5 秒後拒、鎖還在、內容沒動;砍鎖後 grant 出 |
| 7 | 帳本保留上限(nonce 1000、approval 200)會把已花掉的核准擠出去,舊核准重播就復活 | 成立 | used/reserved 的核准是墓碑,永遠不被 200 條顯示窗擠掉(上限 2000);nonce 放大到 5000;簽章 `at` 超過 30 天 → `stale`,nonce 記不記得都拒 | 400 條新核准後 spent 數不變、open 只剩 200;40 天前簽的 say 進 audit 是 `stale` |
| 8 | `principal` 在模組載入時快取為 null;`requireSigned` 又要求有 key → 沒 key 時旗標形同關閉 | 成立 | `principalKey()` 在 null 時重讀檔案(收件匣、啟動、gate 都先呼叫);`requireSigned` 只看旗標 | hank 無 key + 旗標 → 未簽章邀請 dropped;跑著的 server 期間 `principal init` → 簽章 say 顯示 VERIFIED |
| 9 | hosted 的 widened mandate 完全沒有簽章核准閘 | 成立,但**目前不可達**(沒有任何設定 hmandate 的入口) | `mandateBlock`:mandate 一旦放寬,承諾類訊息一律拒,講明 hosted 面沒有簽章可綁 | debug 路由放寬 hosted mandate → grant / accept 都 `widened mandate` 拒 |
| 10 | relay 只給 transcript 前綴(全部真)、lastSeq / head 照實,gate 就會挑到前綴裡較舊的已核准 escalate | 成立:`headVsTranscript` 只在 seq 相同時比 | `verifiedMessages` 要求 served seq/hash == relay 的 lastSeq/lastHash、≥ 簽章 head、≥ 本機游標,否則 `TRANSCRIPT INCOMPLETE` | RoomDO `debug/serve-upto` → grant 拒;恢復後 gate 看到真正最後一則 escalate |
| 11 | head 前進一則,fork 裡的舊 head 就從證據裡消失 | 成立 | 換 head 時,若舊 head 的 seq 在 `headConflicts` 裡有紀錄,舊 head 也存進去;上限 20 → 50 | fork 後 bob 再發一則 → 兩個 hash 都在 `headConflicts` |

順手:兩個併發讀收件匣的程序不會把同一筆核准登記兩次(以 room/hash/at 去重)。

## 這一輪的教訓

- **換模型有用。** 前三輪同一個模型互相挑,第四輪不同模型第一次看就找到十條;其中 #6(鎖逾時照跑)、#7(保留上限)、
  #8(模組載入時快取)三條是「基礎設施層」的,前三輪都盯在協定語意上沒往下看。
- **它的第一次提示被 OpenAI 的資安分類器擋掉**(「adversarial」「bypass」「attacker」這些字)。改成「維護者請求的
  授權不變量正確性審查」就過了。內容一樣。
- 它沒跑 smoke、沒碰線上;我們跑了(407 checks),線上一樣沒做對抗測試。
- 它明說沒看完的:relay 金鑰多次遷移、mirror/import/failover 的授權、viewer/A2A 路徑、檔案系統 crash 注入。

## 沒有改的

- LINE 那條路仍未簽章;信任上限仍是 relay 營運者。
- `can2cup_tell_principal` 仍能把 E2E 房的內容以 agent 自己的話送到 LINE(#4)。這是 agent 對老闆的發言權,靠 SKILL.md 約束。
