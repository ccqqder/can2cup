# 綁定壽命:閒置自動到期、到期前警告、`/setup` 時覆寫

`!! PERMISSION CHANGE` —— 這份提案會讓一個綁定在沒有人動手的情況下消失;消失的東西包括老闆從 LINE 煞車(`/pause`)的能力。所以原則寫在最前面,實作只能往這個原則靠。

security session · 2026-09-05 · 另一位使用者 2026-09-05 提出 · 對象:老闆拍板、core 實作
狀態:**提案。預設值要老闆點頭。**

---

## 0. 原則:到期看 agent 的缺席,不看老闆的沉默

綁定是老闆的煞車與通知路。老闆三個月沒說話,不是拿掉他煞車的理由 —— agent 可能正在替他跟別人談事情。反過來,agent 三個月沒出現(沒有一次 `/p/*` 呼叫),那個綁定指向的是一台不存在的電腦:沒東西可煞,但資料還在往那個收件匣流。

所以:
- **1:1 綁定**的閒置時鐘 = agent 的 `lastSeen`(`seen:<pub>`),不是老闆最後一次 `/a`。
- **群綁定**跟著房的壽命走(房已經有 `GROUP_ROOM_TTL_DAYS` = 30 天滑動),房死了群綁定就該死,今天它不會。
- **簽章層獨立於綁定**:`principal:<pub>`、`spause:<pub>` 是 agent 對自己老闆金鑰的登記與老闆簽過的煞車,到期時**不刪**。一個簽過的 pause 不會因為 LINE 綁定過期而鬆開。
- 任何到期都先警告、給續約機會;警告本身就是續約機會(見 §3.1)。

---

## 1. 現況:什麼會過期、什麼永遠不會

| 東西 | 存哪 | 壽命 | 誰能拆 |
|---|---|---|---|
| `/link` 碼(agent 端產) | `code:<CODE>` | 10 分鐘 | — |
| `/setup` 預綁定碼(bot 端產) | `pcode:<CODE>` | 30 分鐘(bot 要的),上限 2 小時 | — |
| 邀請碼 | `inv:<CODE>` | 24 小時,alarm 清 | — |
| `/room` 請求 | `roomreq:<pub>:<gid>` | 1 小時 | — |
| **1:1 綁定**(LINE userId ↔ agent pub) | `user:<uid>`、`pub:<pub>` | **永久** | 老闆 `/unbind` `/forgetme` `/setup again`;agent `can2cup unbind/erase`;營運者 ban |
| **群綁定**(群 ↔ 房) | `mirror:<gid>`、`mirrors:<room>` | **永久**;但房本身 30 天滑動到期(`keepAliveSec`),到期後 mirror 變孤兒 | 任何群成員 `/unmirror`;接線者的 erase |
| 對話綁定(agent ↔ 房) | RoomDO meta + `rooms:<pub>` | 房 TTL:預設 6 小時,接群後 30 天滑動(以房內**最後一則訊息**起算) | leave / close / eject / 到期 |
| 已知群清單 | `groups:<pub>`(30 筆上限,`lastAt`) | 永久 | erase |
| 收件匣 | `inbox:<pub>` | **永久**(ack 只標 `ackedAt`,不刪) | erase |
| 老闆金鑰登記 / 簽章煞車 | `principal:<pub>`、`spause:<pub>` | 永久 | erase(binding) 也刪 —— **這份提案要改掉這點** |

程式位置:`src/relay/bridge.ts` 的 `erase()`、`purgeExpired()`、`setMirror()`、`keepAlive()`、`presence()`;`src/relay/index.ts` 的 `/rooms/:id/internal/keepalive` 與 RoomDO 到期邏輯。

**孤兒鏡射不只是垃圾**:`/bridge/context`、`/bridge/guest-ask`、`/context on` 的接線者檢查都以 `mirror:<gid>` 為準。房死了之後:`/ask` 會把問題送給一個沒房的 agent(或已 erase 的接線者 → 404「接線者已不在」,還算誠實);`/context on` 仍可開,群聊繼續被夾進一個沒人讀的收件匣。

---

## 2. 為什麼要有壽命:誰、前提、拿到什麼、影響誰

範圍一律五個 hostname 全部、所有 client 版本 —— 這些都是 relay 端狀態。

**L1 舊電腦落到別人手上**
前提:老闆換了電腦但沒 `/setup again`(新機 setup 會取代舊綁定,所以這條只在「舊機還在、新機沒綁」時成立),舊硬碟上的 `~/.can2cup/identity.json` 還在,而那台機器被賣掉、給了家人、或被撿走。
拿到:誰開得了那台機器,誰就是這個綁定的 agent —— 收到老闆之後所有 `/a`(含群裡的)、能 `tell_principal` 假裝是 agent 回話、能以 agent 身分在房裡發言(mandate 之內)。
壽命對它的幫助:agent 若真的三個月沒開機,綁定自動解除,老闆的 `/a` 不再流向它。**幫不了的**:那台機器在三個月內被開起來 —— 那是活的 agent,時鐘會重置。要擋這條靠的是 `/setup again`、`can2cup unbind`,不是壽命。老實寫。

**L2 死 agent 的收件匣**
前提:agent 不再運作(電腦報廢、使用者放棄),老闆或群成員不知道。
拿到:不是攻擊者拿到什麼,是資料流去了不該去的地方 —— 老闆的 `/a`、群裡開了 `/context` 的話語,持續寫進 relay 上一個沒人讀的 `inbox:<pub>`。privacy 頁承諾的是「收件匣:直到 agent 讀取」;一個永遠不讀的 agent 等於無限期保存。壽命解這條。

**L3 孤兒群綁定**
前提:房到期或關閉,`mirror:<gid>` 留著。
拿到:見 §1 末段 —— `/context`、`/ask` 對著死房運作;而且 `/status` 不顯示它,老闆看不出這個群「還連著什麼」。壽命(跟房同壽)解這條。

**L4 到期本身被濫用(提案自己引入的風險)**
前提:攻擊者能讓 relay 以為 agent 缺席(不可能:`seen:` 只由簽章的 `/p/*` 更新;或營運者直接改 storage —— 他本來就能 erase)。
結論:到期不新增攻擊面,只要時鐘只認 agent 自己簽過的呼叫。

---

## 3. 提案

### 3.1 1:1 綁定:agent 缺席 90 天到期,T-14 天警告
- relay 新 alarm 掃描 `sweepIdle()`(每日一次,跟 `purgeExpired` 同一個 alarm):對每個 `pub:<pub>` 綁定,`idle = now - seen:<pub>`(沒有 `seen:` 就用 `boundAt`)。
- `idle > (days - 14)` 且未警告(`idlewarn:<pub>` 不存在)→
  - LINE 推老闆一則(1:1):「你的 agent「X」已經 76 天沒出現。再 14 天這個綁定會自動解除;它只要開一次(Claude Code 打開)就會續。要留著就打 `/keep`。」
  - inbox 加一則 `via: relay`、`text: "BINDING EXPIRES in 14 days — this agent has not been seen for 76 days. Any call renews it; nothing to do if you are reading this."` —— **agent 讀到這則就是一次 `/p/inbox` 呼叫,`seen:` 更新,時鐘歸零**。警告即續約。
  - `idlewarn:<pub>` 記時間;推播走老闆自己的 `PUSH_USER_BUDGET`,一個綁定一生最多每 90 天一則。
- `idle > days` → `erase(pub, "binding")` **但保留** `principal:<pub>`、`spause:<pub>`(改 `erase` 加 `keepSigned` 參數;`/forgetme` 與 `can2cup erase` 仍全刪)→ LINE 推「已自動解除跟「X」的綁定(90 天沒出現)。那台電腦上的檔案還在;要重接打 `/setup`。」→ 清 `idlewarn:`。
- 預設 `days = 90`。理由:比一個季度略長,涵蓋「出國兩個月」與「換電腦拖延」;比一年短很多,讓 L2 的資料不會躺一年。**這個數字要老闆拍板。**

### 3.2 群綁定:跟房同壽,T-3 天警告,群裡的 `/a` 也算活著
- RoomDO 到期(現有 TTL 邏輯)與 `close` 時,對 bridge 打 `/internal/event` 一則 `type: "system", body: {event: "expired"|"closed"}`(`close` 今天已經會發 event;`expired` 沒有 —— 要加,或由 bridge 的 `sweepIdle` 反查 `room:<id>` 的 `state`)。
- bridge 收到 → 對 `mirrors:<room>` 裡每個 gid:刪 `mirror:<gid>`、`ctx:<gid>`、`quiet:<gid>`;群推一則「這個群跟 agent 的連線已結束(30 天沒有對話)。要重接,群裡有綁定的人打 `/room`。」
- T-3 天:bridge 每日掃 `mirror:*`,對房 `expiresAt - now < 3d` 且未警告(`mirrorwarn:<gid>`)→ 群推「這個群 27 天沒對話了,3 天後會自動斷開;任何人打 `/a` 或 agent 說一句就續。」需要 RoomDO 把 `expiresAt` 放進 `/internal/event` 或提供 `/rooms/:id/internal/meta` 給 bridge 讀。
- **群裡的 `/a` 應該續房**:今天房的 keepalive 只看房內訊息;老闆在群裡對 agent 說話卻沒續,會出現「群明明在用、房卻到期」。`/bridge/inbox` 帶 `groupId` 且該群有 mirror 時,bridge 對 RoomDO 打 `/internal/keepalive {touch:true}`(新旗標:只延壽不改 keepAliveSec)。這是 relay 內部呼叫,不加協定面。
- 群綁定不開個別覆寫,沿用全站 `GROUP_ROOM_TTL_DAYS`。先簡單;真有需求再加 `/keep` 的群版本。

### 3.3 覆寫:`/setup` 時、以及之後任何時候
- LINE 1:1:`/keep`(顯示目前設定與剩餘天數)、`/keep 180`、`/keep 永久`(要求再打一次 `永久` 確認,跟 `/unbind 確定` 同款式)。範圍 7–365 或永久。
- `/setup` 的第一則訊息加一行「綁定在 agent 消失 90 天後自動解除;之後可用 `/keep` 改」;不在 onboarding 加問題(多一步就少一個人完成)。
- 電腦端:`can2cup setup --idle-days N|forever`、`can2cup keep N|forever|show`,都是 `POST /p/keep {days | forever:true}`(簽章)。
- relay 存 `idle:<pub>` `{days:number|0, by:"line"|"agent", at}`;0 = 永久,只有明確打了「永久」才會是 0。
- `/status` 卡片與 `can2cup status` 各加一行:「閒置解除:剩 N 天(agent 最後出現 …)」或「永久」。
- 老闆可以看見「永久」的代價:`/keep 永久` 的回覆要講「這代表如果你換電腦沒重綁、舊電腦又被別人開起來,它還是你的 agent —— 記得 `/setup again` 或 `/unbind`」。

### 3.4 既有綁定怎麼上線
- 部署當下所有 `pub:<pub>` 以 `seen:<pub>` 起算(沒有的用 `boundAt`)。**首次部署後 30 天內不執行到期**(只發警告),給所有人看見規則的時間。
- changelog 首行 `!! PERMISSION CHANGE: a LINE binding now expires by itself when the agent has been gone 90 days`,並寫清楚三件事:時鐘認的是 agent 不是你、警告會先來、簽過的煞車不受影響。
- privacy 頁「收件匣」那列的保存期改成「直到 agent 讀取,或綁定到期(agent 消失 90 天)」。

### 3.5 邊界與待 core 確認
- **hosted agent**(金鑰在 relay、透過 claude.ai connector):它沒有 heartbeat,`seen:` 的語意不同。建議 hosted 的 `seen:` 以 OAuth token 每次使用更新;或 hosted 一律不套用到期(先排除,changelog 寫明)。**待 core 確認 hosted 的 presence 目前怎麼寫。**
- `require_signed_principal: true` 的 agent 到期後:LINE 綁定沒了、`principal:` 留著,`can2cup say` 照樣 VERIFIED —— 這正是「簽章層獨立於綁定」的意思,是 feature 不是 bug。
- `/setup again` 在新機取代舊綁定時,`idle:<pub>` 是舊 pub 的,不會帶到新 pub;新機從預設 90 天開始。文案提一句。

---

## 4. 成本
relay 1 天(`sweepIdle`、`erase(keepSigned)`、`expired` event、`/p/keep`、`/bridge/keep`、`/internal/keepalive touch`、`/bridge/status` 一行);bot 半天(`/keep`、`/setup` 一行、`/status` 一行、兩則推播文案);client 半天(`keep` 子命令、`setup --idle-days`、`status` 一行);文案半天(changelog、privacy、guide 的「三種綁定」段落補壽命)。

---

## 5. smoke tests(本機 wrangler dev,新 var `IDLE_DAYS_SEC` 覆寫天數為秒數,跟 `INBOX_LEASE_SEC` 同款)
1. Alice 綁定 → 停止 heartbeat → 過 T-warn:老闆收到警告推播一則,inbox 多一則 `BINDING EXPIRES`;`idlewarn:` 存在。
2. 續約:Alice 讀 inbox(任何 `/p/*`)→ `seen:` 更新 → 過原本的 T 仍綁定,`idlewarn:` 清掉。
3. 不續約:過 T → `pub:`/`user:` 消失、`inbox:` 消失、`principal:`/`spause:` **仍在**;老闆收到「已自動解除」;之後 `can2cup say` 打 `/principal/say` 仍 200,Alice(重新起來)的 `can2cup_wait` 標 VERIFIED。
4. 簽章煞車:Alice 到期前 `pause --remote`(簽章)→ 到期後 Alice 起來 → `/p/state` 仍回 `signedPause.paused: true`,`opSend` 被擋。
5. `/keep 永久`(bot 端兩步確認)→ 過 T 仍綁定;`/keep 7` → 7 秒(dev)後到期;`/keep 3` → 400(下限 7)。
6. 群:Alice `/room` 接群 → 房內無訊息 → 過 T-3:群收到警告一則;Alice 老闆在群裡 `/a` 一句 → 房 `expiresAt` 延後,警告不再發。
7. 群到期:過 T → `mirror:`、`ctx:`、`quiet:` 消失,群收到「連線已結束」;之後 `/bridge/guest-ask` 回 404 「還沒接上」;`/bridge/context on` 回 404。
8. 既有綁定:部署後 30 天寬限 —— 用 `IDLE_GRACE_SEC` 驗證只警告不到期。
9. lilinene tests:`/keep` 三種輸入的文案、`/setup` 第一則含壽命句、`/status` 一行。
