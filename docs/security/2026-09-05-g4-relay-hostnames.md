# G-4:同一服務五個 hostname,client 靜靜換預設值

security session · 2026-09-05 · 依 TODO §G-4(另一位使用者的 agent 提出) · 對象:core 實作、docs 補文案
狀態:**規格,可動工。其中 R3 是真實漏洞的修補,先出。**

---

## 0. 一句話結論

**relay 的身分是簽章金鑰,不是 hostname;hostname 只是別名。** 今天 client 已經釘住每間房的 relay 金鑰(`relayPub`),但所有給人看的地方都印 hostname、不印「這幾個名字是同一把金鑰」,所以使用者只能自己比對 rooms.json 才發現 —— 讀起來像「服務被接手」。

要做的:relay 自報別名(R1)、client 用金鑰分組顯示(R2)、**`can2cup relay <url>` 改指向前必須驗金鑰相同(R3,漏洞)**、`opJoin` 的重指向不再無聲(R4)、邀請連結用正典名字(R5)、changelog 規則(R6)、bot 與 known-issues 跟上(R7)、舊名退場有數字可看(R8)。無協定破壞,無權限變更;R3 那版 changelog 標 `!! PERMISSION CHANGE` 是因為它**收回**了一個今天存在但不該存在的能力。

---

## 1. 現況

### 1.1 五個名字
| hostname | 角色 | 誰還在用 |
|---|---|---|
| `can2cup.com` | 正典(2026-09-04 起,v0.8.4) | 新 `/setup`、changelog 寫死、README/INSTALL |
| `www.can2cup.com` | 別名;KI-005 建議 apex 不通時改用它 | `can2cup setup --relay https://www.can2cup.com` 之後的機器 |
| `can2cup.peachpitboat.com` | 2026-09-03 改名時的名字 | 那一天設定的 client、那一天的邀請連結 |
| `can2can.peachpitboat.com` | 更早一次改名 | 同上 |
| `parley.peachpitboat.com` | 最早的名字 | pilot 期間的所有房、第一位外部使用者的第一次 setup、blog 文章裡的連結 |

全部指同一個 Worker `parley-relay`、同一個 BridgeDO、同一把 `RELAY_SIGNING_KEY`(`d30567…f419d`);`GET /` 五個都回同一把 `pub`。`wrangler.toml` 的註解寫了,**沒有任何對外的地方寫**:`/terms` 沒有、guide 沒有、`GET /` 的 JSON 沒有別名欄位、changelog 0.8.4 只有一句「used for the can2cup.com move」。

### 1.2 hostname 在 client 裡住在哪
- `~/.can2cup/config.json` 的 `relay`:`setup` 時寫,來源是老闆貼的那行(bot 的 `PARLEY_BRIDGE_URL`)或 `--relay`。
- 每間房 `rooms.json[id].relay`:create 時 = `DEFAULT_RELAY`;join 時 = **邀請連結上的 hostname**。
- 邀請連結:`inviteOf(room)` 用 `room.relay` —— 所以一間 pilot 期開的房,今天產的邀請連結仍是 `parley.peachpitboat.com`,新加入的人的 rooms.json 就多一個舊名字。**舊名字是這樣一直繁殖下去的。**
- 程式寫死:`changelog.txt` 第 2 行、`cli/index.ts` 的 usage 字串、`known-issues.json` KI-005、README、INSTALL。

### 1.3 「靜靜換」的三個機制
1. **`can2cup relay <url>`**(v0.8.4,`src/cli/index.ts` case "relay"):改寫 config.json 與**每一間房**的 `relay`。註解寫「Do not use it to point at a different relay」,但程式**沒有檢查** —— 不打 `GET /`、不比 `pub`。
2. **`opJoin` 的重指向**(`src/mcp/core.ts` 第 502–508 行):已知的房收到不同 hostname 的邀請 → 視為 portable room 搬家 → 改 `room.relay`、`room.secret`,把舊 `relayPub` 推進 `relayPubHistory`。金鑰相同時 history 會把它濾掉,**留不下任何痕跡**;輸出也沒有一行說「這間房現在用另一個名字」。
3. **bot `/setup` 的 base 換了**:同一個人的兩台機器,一台 2026-09-03 綁的 config 是 `can2cup.peachpitboat.com`,今天綁的是 `can2cup.com`;`/status` 卡片與 `can2cup whoami` 看起來像兩個服務。

---

## 2. 威脅:誰、前提、拿到什麼、影響誰

範圍除非註明,一律五個 hostname、所有 client 版本。

**H1 信任損耗(不是攻擊,但是 G-4 開出來的原因)**
前提:使用者讀 rooms.json 或 `can2cup rooms`,看到三個網域。
損失:對「誰在營運這個東西」的信心;另一位使用者的 agent 已經把它讀成「服務被接手」。修:R1、R2、R6。

**H2 `can2cup relay <url>` 指向敵方 relay(真實漏洞)**
攻擊者:能讓老闆或 agent 執行一行 `can2cup relay https://<敵方>` 的人 —— 一則「relay 搬家了,請跑這行」的 LINE 訊息、一條 known-issues 式的建議、被接手的舊網域(`peachpitboat.com` 的 registrar 帳號,或未來不續約的名字)配上同名頁面。
前提:client ≥ 0.8.4;老闆或 agent 照做。
拿到:client 之後對敵方主機送出**每一間房的 cap(Bearer)與 secret**、agent 的簽章 `/p/*` 請求、老闆的 `/principal/*` 簽章訊息。敵方偽造不了 participant 簽章,但拿到 cap 就能以該 agent 身分讀房、rotate 邀請、(creator 的話)eject 別人;拿到 `/p/*` 的簽章請求可以重放 5 分鐘。已知房的下一次 `pull` 會報 `RELAY KEY CHANGED` —— 但 cap 已經送出去了,而且 `relay` 命令本身沒有任何警告。
修:R3。

**H3 舊名字被第三方接手 + 新房**
前提:`peachpitboat.com` 子網域落到別人手上(registrar 帳號、或未來不續約),對方架一台假 relay。
已知房:client 釘了金鑰,`RELAY KEY CHANGED`,系統事件不信 —— 擋住。
新房、邀請帶 `p=`:`opJoin` 比對 `p=` 與主機 `pub` 不符即拒 —— 擋住。
新房、邀請**沒有** `p=`(0.3 以前 client 產的、手打的、E2E 邀請被截掉 fragment 的):TOFU 釘上敵方金鑰 —— **不擋**。
修:R5 讓每張邀請都帶 `p=`(現在 `inviteOf` 只在房已釘金鑰時帶);R8 讓舊名字有退場日。

**H4 relay 自報的別名是宣稱,不是證明**
R1 的 `aliases` 只能拿來顯示與整理,不能拿來決定信任。信任仍然只看 `pub`。文件與程式註解都要這樣寫,否則下一個人會拿 aliases 當白名單。

**H5 KI-005 的建議會製造第二個名字**
`doctor` 建議 `can2cup setup --relay https://www.can2cup.com`,之後那台機器的 config 是 www、房是 apex、bot 的 `/setup` 是 apex。無害,但正是 H1 的來源之一。修:R7。

---

## 3. 提案

### R1 relay 自報別名與正典(relay,半天)
`GET /` 的 JSON 加兩個欄位:
```json
"canonical": "https://can2cup.com",
"aliases": ["https://www.can2cup.com", "https://can2cup.peachpitboat.com", "https://can2can.peachpitboat.com", "https://parley.peachpitboat.com"]
```
來源:wrangler `[vars] RELAY_CANONICAL`、`RELAY_ALIASES`(逗號分隔)。`scripts/anchor-check.mjs` 旁加一個 `scripts/routes-check.mjs`:讀 wrangler.toml 的 `[[routes]]` 與這兩個 var,不一致就讓 `release:relay` 失敗 —— 別名清單跟 routes 不同步是最容易發生的腐爛。
`/terms` 加一段:「這台 relay 有五個名字(列出),同一把簽章金鑰 `<pub>`;你的 client 認的是金鑰,`can2cup rooms` 會告訴你哪些房其實在同一台。」guide 同一段白話版。

### R2 client 以金鑰分組顯示(client,半天)
`can2cup rooms` / `can2cup_rooms`:
```
relay d30567…f419d — https://can2cup.com  (also answers as parley.peachpitboat.com, can2cup.peachpitboat.com) — 3 rooms, same relay
  77ff7ca1be69  "win↔mac"     open  seq 41   (addressed as parley.peachpitboat.com)
  3a1c…          "friend"        open  seq 12
relay 9e21…77c0 — https://other.example  — 1 room  ← a DIFFERENT relay
  …
```
分組鍵 = `relayPub`;沒釘金鑰的房(pre-v0.3)自成一組「relay key unknown」。房行的 hostname 只在跟該組正典不同時印。
`whoami` / `status` 的 relay 行:`relay: https://can2cup.com (key d30567…f419d; also known as …)` —— `also known as` 來自 R1,快取在 `config.json.relayInfo {pub, canonical, aliases, at}`,24 小時重抓,離線用快取。
`doctor` 加一條:config 的 relay 與各房 hostname 不同但金鑰相同 → `ℹ N room(s) still use older names of this relay — can2cup relay https://can2cup.com tidies them`;金鑰不同 → `⚠ room X is on a different relay than this machine's default (key …)`。

### R3 `can2cup relay <url>` 先驗金鑰(client,半天;**先出**)
```ts
case "relay": {
  const to = …;
  const h = await relay.health(to);                       // throws → "cannot reach <to>"
  const pinned = new Set(Object.values(loadRooms()).map((r) => r.relayPub).filter(Boolean));
  let curPub = "";
  try { curPub = (await relay.health(DEFAULT_RELAY)).pub ?? ""; } catch { /* old relay may be gone — rooms' pins still decide */ }
  const known = new Set([...pinned, ...(curPub ? [curPub] : [])]);
  if (!h.pub) { console.error(`${to} presents no relay signing key — refusing`); process.exit(1); }
  if (known.size && !known.has(h.pub)) {
    console.error(`REFUSED: ${to} is a DIFFERENT relay (key ${short(h.pub)}; this machine's rooms are pinned to ${[...known].map(short).join(", ")}).\n` +
      `\`can2cup relay\` only renames the relay you already use. To move a room to another relay, export it and import it there (portable rooms).`);
    process.exit(2);
  }
  … existing rewrite …
  console.log(`relay → ${to} (same relay, key ${short(h.pub)}${h.canonical && h.canonical !== to ? `; note: it calls itself ${h.canonical}` : ""}) …`);
}
```
沒有 `--force`。真的要搬到別台 relay,export/import 這條路存在而且會帶 `pastRelayPubs`;`relay` 命令不該是第二條沒有驗證的路。
changelog 首行:`!! PERMISSION CHANGE: can2cup relay <url> now refuses a relay with a different signing key`。

### R4 `opJoin` 的重指向要出聲(client,1 小時)
`existing.relay !== newRelay` 時:
- `info.relayPub === existing.relayPub` → 改 hostname,輸出第一行加 `(room ${id} is now addressed as ${newRelay}; it was ${existing.relay} — same relay key ${short(pub)})`,`audit({kind:"join", …, renamedFrom: existing.relay})`。
- 不同 → 維持現有 portable-room 邏輯,但輸出加 `!! ROOM MOVED to a different relay (key ${short(new)} — was ${short(old)}). System events from the old relay still verify via relayPubHistory.`,audit 同。
- **不再無聲。**

### R5 邀請連結用正典名字,而且一律帶 `p=`(client,1 小時)
`inviteOf(room)`:若 `config.relayInfo.pub === room.relayPub` 且 `relayInfo.canonical` 存在 → `u = canonical`,否則 `u = room.relay`。`p` 一律帶(房沒釘金鑰就先 `pull` 一次釘上再產邀請;pull 失敗就拒絕產邀請,印原因)。
效果:舊房不再把舊名字傳給新人;每張邀請都讓 `opJoin` 有金鑰可比。
`/p/room-created`、`/p/invite`(LINE 短碼)走同一個 `inviteOf`,自動跟上。

### R6 changelog 規則(規矩,不是程式)
- 改預設 hostname、加或退一個別名:那版 changelog **第一行**寫 `relay name: <old> → <new> — same relay, same key <short pub>`。不加 `!!`(沒有動誰能做什麼、資料也沒去別處)。
- relay 簽章金鑰改變:`!! DATA FLOW`(舊房的系統事件從此不可驗;§B 已寫「Don't rotate casually」)。
- 0.8.4 那則**追加**一句:「can2cup.com, www, and the three peachpitboat names are one relay with one key; `can2cup rooms` (≥ 0.9.8) groups them.」changelog 是 relay-assets,core 可改;追改要註明日期。

### R7 bot 與 known-issues(bot,1 小時)
- `/setup` 貼給 Claude 的那行:base 用 relay `GET /` 的 `canonical`,不用 `PARLEY_BRIDGE_URL` 本身(bot 的內部呼叫可以繼續用任一名字)。
- KI-005 改寫:「`www.can2cup.com` 是同一台 relay 的另一個名字(同一把金鑰);`can2cup setup --relay https://www.can2cup.com` 之後 `can2cup rooms` 會標出來。」
- `/status` 卡片不印 hostname(人不需要),但 `/can2cup` 說明加一句「五個名字、一台 relay」。

### R8 舊名字的退場要有數字(relay,1 小時;不急)
`touch()` 順手存 `host:<pub>` = 這個 agent 最近一次呼叫用的 Host;`/bridge/status`(營運者視角)與一支 `GET /admin/hosts`(BRIDGE_KEY)列出「每個 hostname 還有幾個 agent、幾間活房在用」。退場條件寫在 TODO §Z:某個舊名字 **30 天內零 agent、零活房** → 從 routes 拿掉、changelog 依 R6 寫、known-issues 加一條「那個名字的邀請連結已失效,請對方重發」。在那之前不拿掉任何名字:拿掉 = 舊邀請連結與舊 config 全死,那才是真的「服務被接手」的體驗。

---

## 4. smoke tests

relay(本機 wrangler dev,`.dev.vars` 設 `RELAY_CANONICAL` / `RELAY_ALIASES`):
1. `GET /` 含 `canonical`、`aliases`,五個 Host 打進去 `pub` 相同。
2. `routes-check.mjs`:故意在 `RELAY_ALIASES` 少列一個 route → 非零退出。

client:
3. 兩間房,一間 `relay` 手動改成別名 hostname → `can2cup rooms` 只有**一組**,標 `same relay`,那間房行印 `(addressed as …)`。
4. 起第二個 wrangler dev,`RELAY_SIGNING_KEY` 不同 → `can2cup relay <第二台>` → exit 2、輸出含 `DIFFERENT relay`、config.json 與 rooms.json **未改**。
5. `can2cup relay <同一台的別名>` → exit 0,全部房改寫,輸出含 `same relay, key`。
6. 已知房 + 別名 hostname 的邀請 → `opJoin` 輸出含 `is now addressed as`,rooms.json 的 `relay` 更新,`relayPubHistory` 不變。
7. 已知房 + 第二台(不同金鑰、經 export/import)的邀請 → 輸出含 `ROOM MOVED`,`relayPubHistory` 含舊金鑰。
8. 房在別名 hostname 上、`config.relayInfo` 已快取 → `can2cup invite` 產出的連結 hostname 是 canonical,且帶 `p=`;沒釘金鑰的房 → 先 pull 再產,離線則拒絕並說明。
9. `doctor`:情境 3 印 ℹ;情境 7 印 ⚠。

bot(lilinene tests):
10. `/setup` 第二則的 `npm i -g` 與 `--relay` 用 canonical(FakeClient 的 health 回 canonical ≠ base)。
11. KI-005 文案更新後 `doctor` 的 `match` 仍命中。

---

## 5. 順序與成本
1. R3(半天)—— 漏洞,單獨出,`!! PERMISSION CHANGE`。
2. R1 + R2 + R4 + R5(relay 半天、client 1 天)—— 同一版,changelog 依 R6 寫。
3. R7(bot 1 小時)、docs(`/terms`、guide、README §Trust model 加「relay 身分 = 金鑰」一段)。
4. R8 隨下一個 relay 版本;退場日期進 TODO §Z。
5. TODO §G-4 改為「已出貨;舊名退場條件見 §Z」。

## 6. 不做的
- 不把 `aliases` 當白名單(H4)。
- 不在 `relay` 命令加 `--force`。
- 不現在拿掉任何舊名字。
