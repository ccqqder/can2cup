# G-3 規格:tarball 沒有簽章 —— `/dl/VERSION.sha256`、`can2cup upgrade` 驗證、然後往 sigstore / 離線 manifest 金鑰

security session · 2026-09-05 · 依 TODO §G-3 · 對象:core 實作、老闆知情
狀態:**三階段。P1 現在(1 天)、P2 launch 前(2–3 天)、P3 開源時(隨 npm publish)。**

---

## 0. 先講老實話

`can2cup upgrade` = agent 依 relay 的指示,在自己的機器上執行 `npm i -g https://can2cup.com/dl/can2cup.tgz`。SKILL 規則「patch 版直接升」(TODO §E,2026-09-04 定案)讓這件事**自動發生**。所以今天:

> **誰能改 relay 上的 `/dl/can2cup.tgz`,誰就能在每一台跑 can2cup 的電腦上執行任意程式,最晚在下一個 patch 版。**

這是設計上的遠端執行通道,不是漏洞;問題是它目前**沒有任何一把不在 relay 手上的鑰匙**擋著。

- **P1 的 sha256 放在同一個 relay 上,不改變這句話。** 它給的是完整性(下載沒壞、CDN 沒給舊檔、staging 沒漏),不是真實性(是維護者發的)。營運者或拿到 Cloudflare 帳號的人可以同時換 tgz 和 .sha256。P1 值得做,因為它便宜、讓 hash 成為可記錄可比對的識別碼,也是 P2 的地基 —— 但 changelog 不能寫成「已簽章」。
- **P2 的離線金鑰才是把「誰能推碼」從 relay 營運者手上拿走。** 金鑰在維護者的電腦,永遠不進 wrangler secret、不進 repo。
- **P3 的 npm provenance(sigstore)把 relay 從散佈鏈整個拿掉。** 條件是 repo 公開 —— 那是 §Z 的最後一步。

---

## 1. 威脅:誰、前提、拿到什麼、影響誰

五個 hostname 共用同一份 `relay-assets`,影響範圍一律全部。

| | 攻擊者 | 前提 | 拿到什麼 | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| T1 | relay 營運者 / Cloudflare 帳號持有者 | 能 `wrangler deploy` 或改 assets | 每台 agent 機器的使用者權限,自動、延遲 ≤ 一個 patch 版 | ✗ | ✓ | ✓ |
| T2 | 拿到 can2cup.com DNS 或憑證的人 | CF 帳號 = DNS + Worker + 憑證,同一個根;或 registrar 帳號 | 同 T1 | ✗ | ✓ | ✓ |
| T3 | 網路:部分下載、CDN 舊快取、staging 漏拷 | 無 | 壞掉或版本錯亂的安裝;`npm i -g <url>` 對 URL 安裝**沒有** integrity 檢查 | ✓ | ✓ | ✓ |
| T4 | 首次安裝(`/setup` 貼給 Claude 的那行) | 使用者第一次跑 | 這一次沒得驗,TOFU | △ | △ | ✓(改裝 npm registry) |
| T5 | 維護者的電腦被拿到 | 拿到 release 金鑰 | 等於 T1 | — | ✗(要輪替) | ✓(keyless,每次 CI 簽) |

client 版本:`upgrade` 從 0.9.0 起存在;0.8.4 以前只有 `doctor` 比 `/dl/VERSION`;0.8.4 以前的 client 收不到任何升級通知,只能靠 relay 每月一次的 LINE 推播(§E-2)。

---

## 2. P1 —— `/dl/VERSION.sha256` + `upgrade` 先驗再裝(現在,1 天)

### 2.1 relay 端(純靜態資產,無程式改動)
`scripts/stage-tarball.mjs` 在拷貝 tgz 之後:

```js
import { createHash } from "node:crypto";
const sha = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
// sha256sum-compatible: "<hex>  <filename>" — one line per name the relay serves, so `sha256sum -c` works verbatim
const lines = ["can2cup.tgz", "can2can.tgz", "parley.tgz", src].map((n) => `${sha}  ${n}`).join("\n") + "\n";
fs.writeFileSync("relay-assets/dl/VERSION.sha256", lines);
for (const n of ["can2cup.tgz", "can2can.tgz", "parley.tgz"]) fs.writeFileSync(`relay-assets/dl/${n}.sha256`, `${sha}  ${n}\n`);
console.log(`sha256 ${sha}`);
```

`GET /` 的 JSON 加 `dlSha256: <hex>`(relay 從 ASSETS 讀 `dl/VERSION.sha256` 第一欄,跟 `latestVersion()` 同一個 60 s 快取)。`/dl/VERSION` 與 `.sha256` **同一次 deploy 出去**,才不會出現版本與 hash 錯開的視窗(現在 `release:relay` 已是 stage + deploy 一步,維持)。

### 2.2 client 端 `upgrade`(`src/cli/index.ts` case "upgrade")
把「把 URL 交給 npm」改成「自己下載、驗、再把檔案交給 npm」:

```ts
const base = `${DEFAULT_RELAY}/dl`;
const latest = (await (await fetch(`${base}/VERSION`)).text()).trim();
if (latest === VERSION && !has("force")) { …already current… }
let expected = "";
try { const t = await (await fetch(`${base}/VERSION.sha256`, { signal: AbortSignal.timeout(8000) })).text(); expected = /^[0-9a-f]{64}/.exec(t.trim())?.[0] ?? ""; } catch { /* relay predates P1 */ }
if (!expected && has("require-checksum")) { console.error("relay serves no VERSION.sha256 — refusing (--require-checksum)"); process.exit(2); }
const tmp = path.join(os.tmpdir(), `can2cup-${latest || "latest"}-${randomHex(4)}.tgz`);
const buf = Buffer.from(await (await fetch(`${base}/can2cup.tgz`, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
const actual = createHash("sha256").update(buf).digest("hex");
if (expected && actual !== expected) {
  console.error(`REFUSED: sha256 of the downloaded tarball does not match what the relay advertises.\n  expected ${expected}\n  got      ${actual}\nNothing was installed. Run  can2cup report "upgrade sha256 mismatch"  so the operator hears about it.`);
  process.exit(2);
}
if (!expected) console.error("note: this relay serves no VERSION.sha256 yet — installing unverified (same as before 0.9.8).");
fs.writeFileSync(tmp, buf);
const rr = run("npm", ["i", "-g", tmp]);
try { fs.unlinkSync(tmp); } catch { /* best effort */ }
…existing post-install…
saveInstalled(v, { sha256: actual, verified: !!expected });
```

`state.ts`:`UpgradeNag.installed` 多 `sha256`、`verified`。`doctor` 印 `installed from sha256 <short> (verified against relay)` 或 `(unverified — relay had no checksum)`。`status` 一行同。

首次安裝(T4):`lilinene` 的 `/setup` 訊息第二則附一行「安裝完成後 `can2cup doctor` 會印 sha256,前 8 碼應該是 `XXXXXXXX`」—— bot 從 relay `GET /` 的 `dlSha256` 取。同源,擋不了 T1,但它在**另一個時間點、另一個 app** 出現在人眼前,relay 被換掉一天以上的話會對不上。誠實標示為「弱」。

### 2.3 相容矩陣
| client | relay 有 .sha256 | relay 沒有 |
|---|---|---|
| ≥ 0.9.8(P1) | 驗,不符拒裝 | 警告後照裝;`--require-checksum` 可拒 |
| ≤ 0.9.7 | 看不見,行為如今日 | 如今日 |

### 2.4 smoke(`src/scripts/smoke.ts` 新段 "dl integrity",跑在本機 wrangler dev)
1. `GET /dl/VERSION.sha256` 第一欄 == `sha256(GET /dl/can2cup.tgz)`;三個別名同 hash。
2. `GET /` 的 `dlSha256` == 上面。
3. 用一份改過一個 byte 的 tgz 起第二個 wrangler dev(或 assets 目錄暫換)→ `can2cup upgrade` 以 `CAN2CUP_RELAY` 指過去 → exit 2、輸出含 `REFUSED`、`npm ls -g can2cup` 版本不變、tmp 檔已刪。
4. 正常 relay → `upgrade --force` → exit 0,`upgrade.json.installed.sha256` == 1 的值,`verified: true`。
5. relay 拿掉 `.sha256` → `upgrade --force` 印 `unverified` 但成功;`--require-checksum` → exit 2。
6. `doctor` 顯示 hash 前 8 碼與 verified 狀態。

---

## 3. P2 —— 離線 manifest 金鑰(launch 前、開放給朋友層之前;2–3 天)

### 3.1 格式
`relay-assets/dl/manifest.json`

```json
{ "v": 1, "version": "0.9.9", "date": "2026-09-12",
  "files": { "can2cup-0.9.9.tgz": "<sha256>" },
  "changelogSha256": "<sha256 of changelog.txt at release>",
  "permissionChange": true,
  "dataFlowChange": false,
  "minClient": "0.0.0" }
```
`relay-assets/dl/manifest.sig`:`signHex(canon(manifest), releasePriv)`(`protocol/canon.ts` 已有 canon;同 envelope 的簽法,不發明新格式)。`can2cup.tgz` 等別名照舊,驗的是內容 hash 不是檔名。

### 3.2 金鑰
- 產生:`node scripts/release-key.mjs init` → `~/.can2cup-release/release.json`(維護者機器;**不進 repo、不進 wrangler secret、不進 config repo**)。備份一份離線。
- 公鑰:`src/protocol/release.ts` 的 `RELEASE_PUBS: string[]`,燒進 client。輪替 = 新版 client 列兩把、下一版拿掉舊的;`doctor` 印目前信任的 release key 前 8 碼。
- 現有安裝的第一次:TOFU —— 0.9.9 之前的 client 不認 manifest,升到第一個 P2 版本那次是同源信任(P1 等級);之後每次都是離線金鑰。
- 被偷(T5):輪替 + changelog 寫明 + 舊金鑰簽的 manifest 在新 client 一律拒 —— 但舊 client 仍會信,所以輪替後要抬 `MIN_CLIENT`(§E-5 的流程,先在 known-issues 預告 7 天)。

### 3.3 client 驗證順序(取代 P1 的裸 sha256 比對,P1 的檔案留著給 `sha256sum -c` 用)
1. GET `manifest.json` + `manifest.sig` → `verifyHex(sig, canon(manifest), pub)` 對 `RELEASE_PUBS` 任一把 → 不過就拒,**不退回 P1**(退回等於沒做)。
2. `manifest.version` == `/dl/VERSION`(不一致 = staging 不完整,拒)。
3. 下載 tgz → sha256 在 `manifest.files` 裡 → 才 `npm i -g <file>`。
4. `manifest.permissionChange || dataFlowChange` 為 true → **就算是 patch 版也先告訴老闆**(`tell_principal` + watch 輸出),等 VERIFIED 或老闆在電腦上說可以才裝。這把 §G-5 的 changelog 標記從「人眼看」變成「機器讀」,也讓 §E「patch 直接升」在有權限變更時自動降級為「先問」—— 不改 §E 的規則,只是加了它本來就該有的例外。
5. `saveInstalled` 記 `sha256`、`manifestSig` 前 16 碼、`releasePub` 前 8 碼。

### 3.4 release 流程(`npm run release:relay`)
`pack → stage-tarball(算 hash、寫 manifest.json)→ release-sign(讀 ~/.can2cup-release、寫 manifest.sig)→ wrangler deploy`。沒有金鑰的機器跑 `release:relay` 直接失敗 —— 這是刻意的:**只有維護者的機器能出版**,其他 session(interface / docs / security)本來就不該 deploy。

### 3.5 smoke
1. 正確簽章 → 升級成功,`installed.releasePub` 有值。
2. `manifest.sig` 改一個字元 → 拒,exit 2,不退回 sha256。
3. manifest 的 hash 對、tgz 被換 → 拒。
4. `manifest.version` ≠ `VERSION` → 拒,訊息說 staging 不完整。
5. `permissionChange: true` + patch 版 → `upgrade` 不自動裝,印出「這版動到權限,先告訴老闆」;`--acknowledged` 才裝。
6. 用不在 `RELEASE_PUBS` 的金鑰簽 → 拒,訊息含「release key not trusted by this client」。

---

## 4. P3 —— npm registry + provenance(sigstore),開源那天一起做

- 條件:repo 公開(§Z 最後一步)、GitHub Actions 發版、npm 帳號開 2FA。`can2cup-name-hold` 佔位包已準備,尚未 publish(HANDOFF 2026-09-03)。
- 做法:`npm publish --provenance --access public` 在 Actions 內跑(OIDC → sigstore Fulcio/Rekor,keyless,每次 CI 一把短命金鑰,沒有 T5 問題)。使用者端 `npm i -g can2cup@<ver>`;`npm audit signatures` 驗 registry 簽章與 provenance attestation。
- 之後 `/dl/` 的角色:bootstrap 與鏡像(離線環境、npm 被擋的網路),`VERSION` 改指 npm 上的版本,`upgrade` 預設走 `npm i -g can2cup@<ver>`,`--from-relay` 才走 `/dl/`(仍驗 P2 manifest)。
- `/setup` 貼給 Claude 的那行變成 `npm i -g can2cup` —— T4 也解了:第一次裝就走 registry + provenance,relay 完全不在散佈鏈上。
- P2 的離線金鑰在 P3 之後可以退場,或留著給 `--from-relay`。二選一,launch 時再定;不要兩套都長期維護。

---

## 5. 跟 §E 升級協定的關係(不改決議,補一個例外)

§E 定的是「patch 直接升、minor 先問、低於 min 一定升」。P1 之前,「patch 直接升」在安全上等於「營運者可在 ≤ 一個 patch 版的延遲內推碼到每台機器」—— 這在 relay 營運者 = 老闆本人的今天是可接受的,但**開放給朋友層之前**要有 P2,否則「請信任我不會推壞碼」是 launch 文案裡站不住的一句。

補的例外只有一條:**manifest 標了 permissionChange / dataFlowChange 的版本,不論 patch 或 minor,先問。** 這跟 §G-5 是同一件事的機器版。

---

## 6. 順序與交付
1. P1:`stage-tarball.mjs`、`upgrade`、`state.ts`、`doctor`/`status` 各一行、smoke 6 條、bot `/setup` 第二則附 hash 前 8 碼。changelog 首行不標 `!! PERMISSION CHANGE`(這版沒有動誰能做什麼),但要寫「sha256 is integrity, not authorship — the relay operator can still change both files」。
2. P2:`release.ts`、`release-key.mjs`、`release-sign.mjs`、`upgrade` 改驗 manifest、smoke 6 條、`MIN_CLIENT` 抬到第一個 P2 版本的流程照 §E-5。changelog 首行 `!! PERMISSION CHANGE: upgrades now require a release signature; a version that touches permissions no longer auto-installs`。
3. P3:隨開源。
