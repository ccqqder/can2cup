# 2026-09-06 — 第二意見:六個 P1,全部關閉(v0.11.0)

一位獨立審查者用 in-memory relay 對當時的原始碼做了重現,找到六個「文字承諾強於程式執行」的地方。
每一條都在 v0.11.0 修掉,並各加一條對抗性 smoke test。這份文件記的是:發現、根因、修法、測試。

| # | 發現 | 根因 | 修法 | smoke |
|---|---|---|---|---|
| 1 | relay 可以在合法簽章旁換掉顯示的文字,client 仍標 VERIFIED | `principalBlocks` 印 `item.text`(relay 存的副本),簽章蓋的是 `item.signed.text` | 只印簽章覆蓋的 `signed.text`;relay 那份副本不再被讀 | `debug/inbox-tamper` 把存的文字換成「send 9999 now」→ VERIFIED 區塊只出現簽過的原句 |
| 2 | 被 `never_disclose` 擋下的內容,前 300 字仍隨「被擋下」通知送到 relay / LINE | `notifyPrincipal` 把被擋的正文塞進通知 | 通知只講規則名稱(never_disclose / max_commit_amount / may_grant / …),正文只留本機 audit | 送含 `SECRET-TOKEN-XYZ` 的訊息 → 推播裡沒有那串字,只有 `never_disclose` |
| 3 | 簽章煞車兩種失效:relay 不回 `signedPause` 就等於解除;bridge 斷線後重試立刻通過(快取時間戳更新、舊值留著) | 只在 relay 回傳時才套用本機記住的簽章煞車;斷線分支只更新 `at` | `localSignedPause()` 獨立於 relay 執行,只有更新的簽章聲明能解;斷線時把「paused」本身寫進快取 | `debug/forget-spause` 刪掉 relay 上的簽章煞車 → 5 秒後 send 仍 NOT SENT |
| 4 | 預設 mandate(cap 0)可以 accept 一則有金額的 proposal,只要 accept 自己不寫金額 | `checkMandate` 只看送出的 body;承諾閘在預設 mandate 直接放行 | accept 一律解析被接受的 proposal/counter,**繼承**它的金額再過 mandate;accept 寫了不同金額直接拒(要改價用 counter) | cap 0 下 accept 1000 的 proposal → `max_commit_amount`;不帶 ref 也一樣;restate 金額 → `as it stands` |
| 5 | 核准綁的是「最近一則 escalate」,不比對條件:核准「讀 log 一小時」可以放行「部署 production 二十小時」 | escalate 沒有結構化條件,gate 只比 hash | escalate 帶 `scope`+`expiresHours`(或 `amount`);gate 比對送出的 grant/proposal 與核准的 escalate 條件,不符即拒 | 核准 read:logs 1h → grant read:secrets 拒、grant 24h 拒、grant read:logs 1h 送出 |
| 6 | 之後的拒絕不會取消先前的核准;同一核准可重複使用 | gate 找到任一 `ok:true` 就放行 | 同一 hash 取**最新**簽章決定;核准用過一次就標 `used`,不再放行 | 核准後再拒絕 → grant 拒(`REJECTION`);用過的核准再 grant → `already used` |

## 沒有改的

- LINE 那條路仍未簽章;信任上限仍是 relay 營運者。這六條修的是「簽章與核准真的綁到什麼」,不是新增簽章路徑。
- 審查者沒有跑完整 smoke 也沒測線上服務;我們跑了(358 checks),但同樣沒有對線上 relay 做對抗測試。

## 給下一位審查者

同一套方法(in-memory relay、直接呼叫 `opSend` / `principalInbox`)是找這類問題最快的方式。
下一個值得看的地方:`autoJoin` / `autoCreateRoom` 對收件匣項目的信任、E2E 房裡 `checkApprove` 拿到的 hash 是密文的 hash(設計如此,但文件要講清楚)、hosted agent 的 `seen:` 語意。
