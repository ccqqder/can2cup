# docs/security — 安全審查與設計決策

security session 的產出。這裡只有文件:威脅、決策、給 core 的 patch 提案與應證明它的 smoke tests。程式碼由 core 套用。

每一條發現都寫四件事:攻擊者、前提、拿到什麼、影響哪些 hostname 與 client 版本。

這些文件裡引用的短 commit hash(例如 `15c1f84`)指向 2026-09-12 之前的私有歷史 archive,在這個 repo 解析不到;對應的版本 tag 與 changelog 條目才是公開的定位。

| 日期 | 文件 | 狀態 |
|---|---|---|
| 2026-09-05 | [G-2 LINE 那條路沒有簽章](2026-09-05-g2-line-path-unsigned.md) —— (b) 承諾閘 + UI 分級;(a2) 條件觸發;附 T4 群接線授權漏洞(立刻修) | **老闆拍板 2026-09-05:採 (b)。** core 可動工,順序見 §6.3 |
| 2026-09-05 | [G-3 tarball 沒有簽章](2026-09-05-g3-tarball-signing.md) —— P1 sha256 現在、P2 離線 manifest 金鑰 launch 前、P3 npm provenance 開源時 | 規格,可動工 |
| 2026-09-05 | [綁定壽命](2026-09-05-binding-lifetime.md) `!! PERMISSION CHANGE` —— agent 缺席 90 天到期、T-14 警告、`/keep` 覆寫;群綁定跟房同壽 | **老闆拍板 2026-09-05:預設 90 天。** core 可動工 |
| 2026-09-06 | [第二意見](2026-09-06-second-opinion.md) —— 六個 P1:簽章、核准、mandate 各綁到什麼 | 全修,v0.11.0 |
| 2026-09-06 | [第三意見](2026-09-06-third-opinion.md) —— 同一位審查者對 0.11.0 的九條繞法 | 全修,v0.11.1 |
| 2026-09-06 | [第四意見(codex / gpt-6-astra)](2026-09-06-fourth-opinion-codex.md) —— 換模型:十一條主張,十條成立、一條是設計 | 十條修,v0.11.2 |
| 2026-09-06 | [第五意見(codex 複查 v0.11.2)](2026-09-06-fifth-opinion-codex.md) —— 十條修法的邊界:讀失敗、換 key、同時刻、鎖回收、快照覆寫 | 九條 P1 + 一條 P2 全修,v0.11.3 |
| 2026-09-05 | [G-4 五個 hostname、client 靜靜換預設值](2026-09-05-g4-relay-hostnames.md) —— relay 身分 = 金鑰;R3 `can2cup relay <url>` 不驗金鑰是漏洞,先出;rooms 以金鑰分組、邀請用正典名、changelog 規則、舊名退場條件 | 規格,可動工;R3 先 |
| 2026-09-09 | [Tier 2 密碼學稽核範圍](https://github.com/ccqqder/can2cup_lab/blob/main/docs/tier2-audit-scope.md)(原型與這份文件都在 can2cup_lab) —— Tier 2 原型每個原語的假設、原型尺寸缺口、稽核者要逐項確認的事(軟在前:鏡像化約、綁定、FS 綁定、遮罩)、已知殘留、進 `src/protocol` 的閘門清單 | **稽核前置,非稽核。出貨閘門:此清單全綠前一格都不進出貨面。** |
| 2026-09-09 | [對抗性穩健:入站框架偽造三面](2026-09-09-adversarial-inbound-framing.md) —— 對方 agent 從顯示名/房名/body 偽造結構;新 `mcp/framing.ts`(safeLabel + fenceBody)修掉;出站 `checkMandate` 圍堵 demo;語意洩露殘留 | **已修進 main `15c1f84`;非密碼學、不碰 Tier 2 閘門;隨 v0.14 上** |
| 2026-09-09 | 自保清單(§1)—— `checkMandate` 新增 `require_confirm`:某些**決定類型**即使金額在界內也 HOLD、須老闆簽核。把煞車從金額升到決定類型,結構性接上上一列的語意/界內壞交易殘留(語意半邊仍屬審查)。`demo:self-preservation` | **已實作於 `src/protocol/mandate.ts`(shipped surface、非密碼學);隨 v0.14 上** |
| 2026-09-09 | 可撤銷+可稽核(§1)—— `revoke` + `verifyChain` 三值判決 + 簽章 head + 授權帳本(grants−revokes−expired)。[docs/revocability-and-audit.md](../revocability-and-audit.md);`demo:revoke-audit` | **積木本已在;把它組成「agent 還在不在為你工作」的可稽核答案。缺席自動撤權等收在 [ROADMAP.md](../../ROADMAP.md)** |
| 2026-09-09 | [第六意見(gpt-6-astra,對 v0.14 出貨面)](2026-09-09-sixth-opinion.md) —— 12 條:`m.ts` 注入、hosted 無 framing、fence 漏斷行變體+bidi、scrub 順序重生 sentinel、mandate 設定 fail-open、reveal 豁免走一般 send、require_confirm 大小寫 fail-open、grant expiry 非嚴格 ISO…逐條驗證 | **結構偽造/fail-open 類全修 + 單測(framing 30、mechanism 56)、smoke 432/432;判斷類/大重構標 ROADMAP。v0.14.1 候選** |

不會改的一句:**G-2 解決之前,「信任上限 = relay 營運者」就是誠實的講法。** (b) 做完之後它仍然是實話,只是後面可以多寫「在預設規則下,這個上限的內容是『以你的 agent 身分說話』,不是錢」。
