// check:line-app — scripts/line-app.mjs against a fake LINE Messaging API on 127.0.0.1, never the real one.
// No relay, no LINE account, no real token: a fake token goes into a temporary .env.line (LINE_ENV_FILE), and
// LINE_API_BASE / LINE_API_DATA_BASE point the script at the fake server (the data host is served under /data).
// Proves: `show` output; `app` sets <relay>/line/webhook and then asks for a test event; `menus` creates and uploads
// console before onboard, sets the default only after the onboard image is up, deletes last and only older menus with
// either prefix; refusals call nothing (wrong name prefix, image size mismatch, not PNG/JPEG, over 1 MB, no --relay);
// --dry-run calls nothing; a failed upload rolls back what the run created; the token is never printed.
// The menu files come from tools/richmenu/make_richmenu.py when a Python with Pillow is found (PYTHON names one;
// else python3, python) and from hand-built PNG headers otherwise (or when LINE_APP_CHECK_NO_PYTHON=1).
//   node scripts/line-app-check.mjs        (npm run check:line-app)
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "line-app.mjs");
const GEN = path.join(ROOT, "tools", "richmenu", "make_richmenu.py");
const TOKEN = `fake-token-${randomBytes(12).toString("hex")}`;
const SECRET = `fake-secret-${randomBytes(12).toString("hex")}`;
const VERBOSE = !!process.env.VERBOSE;
let fails = 0, checks = 0;
const expect = (c, m) => { checks++; console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ---- menu files --------------------------------------------------------------------------------------------------
const GUIDE = "https://relay.example/guide", PRIVACY = "https://relay.example/privacy/";
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const b = Buffer.alloc(8 + td.length); b.writeUInt32BE(data.length, 0); td.copy(b, 4); b.writeUInt32BE(crc32(td), 4 + td.length); return b; };
/** A PNG header (signature, IHDR, IEND) of the given pixel size: enough for a size check, not a viewable image. */
const png = (w, h) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]); };
/** A JPEG header: SOI, a JFIF APP0, SOF0 with the size, EOI. */
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const ACTIONS = {
  console: [
    { type: "message", text: "/status" },
    { type: "postback", data: "menu:a", inputOption: "openKeyboard", fillInText: "/a " },
    { type: "message", text: "/pause" }, { type: "message", text: "/resume" }, { type: "message", text: "/quota" }, { type: "message", text: "/help" },
    { type: "uri", uri: GUIDE }, { type: "uri", uri: `${GUIDE}#start` },
  ],
  onboard: [{ type: "message", text: "/setup" }, { type: "message", text: "/help" }, { type: "uri", uri: GUIDE }, { type: "uri", uri: PRIVACY }],
};
function layout(name, bar, w, h, cols, rows, actions) {
  const cw = Math.floor(w / cols), ch = Math.floor(h / rows);
  const areas = actions.map((action, i) => {
    const col = i % cols, row = Math.floor(i / cols), x0 = col * cw, y0 = row * ch;
    return { bounds: { x: x0, y: y0, width: (col === cols - 1 ? w : x0 + cw) - x0, height: (row === rows - 1 ? h : y0 + ch) - y0 }, action };
  });
  return { size: { width: w, height: h }, selected: true, name, chatBarText: bar, areas };
}
const EXPECTED = {
  console: layout("can2cup-menu-console-v1", "Menu", 2500, 1686, 4, 2, ACTIONS.console),
  onboard: layout("can2cup-menu-onboard-v1", "Start", 2500, 843, 4, 1, ACTIONS.onboard),
};
function handBuilt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const key of ["console", "onboard"]) {
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(EXPECTED[key], null, 2));
    fs.writeFileSync(path.join(dir, `${key}.png`), png(EXPECTED[key].size.width, EXPECTED[key].size.height));
  }
}
function fromPython(dir) {
  if (process.env.LINE_APP_CHECK_NO_PYTHON === "1") return "LINE_APP_CHECK_NO_PYTHON=1";
  for (const py of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const probe = spawnSync(py, ["-c", "import PIL"], { timeout: 20_000, stdio: "ignore" });
    if (probe.status !== 0) continue;
    const r = spawnSync(py, [GEN, "--out", dir, "--guide", GUIDE, "--privacy", PRIVACY, "--lang", "en"], { timeout: 120_000, encoding: "utf8" });
    if (r.status === 0) return null;
    return `${py} ${path.relative(ROOT, GEN)} failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`;
  }
  return "no Python with Pillow";
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "line-app-check-"));
const GOOD = path.join(TMP, "good");
const whyNot = fromPython(GOOD);
const viaPython = whyNot === null;
if (!viaPython) handBuilt(GOOD);
console.log(`menu files: ${viaPython ? "tools/richmenu/make_richmenu.py" : `hand-built PNG headers (${whyNot})`}`);
if (viaPython) {
  for (const key of ["console", "onboard"]) {
    const got = JSON.parse(fs.readFileSync(path.join(GOOD, `${key}.json`), "utf8"));
    expect(same(got, EXPECTED[key]), `generator: ${key}.json has the v9 layout, name, chat bar text and actions`);
    const b = fs.readFileSync(path.join(GOOD, `${key}.png`));
    expect(b.readUInt32BE(16) === got.size.width && b.readUInt32BE(20) === got.size.height && b.length <= 1_000_000, `generator: ${key}.png is ${got.size.width}x${got.size.height} and under 1 MB (${b.length} bytes)`);
  }
  const bad = spawnSync(process.env.PYTHON || "python3", [GEN, "--out", path.join(TMP, "nope"), "--guide", GUIDE], { timeout: 20_000, encoding: "utf8" });
  expect(bad.status === 2 && /--privacy/.test(bad.stderr), "generator: --privacy is required");
}
/** A copy of the good files, changed by `edit(dir)`. */
function variant(name, edit) {
  const dir = path.join(TMP, name);
  fs.cpSync(GOOD, dir, { recursive: true });
  edit(dir);
  return dir;
}
const editJson = (dir, key, f) => { const p = path.join(dir, `${key}.json`); const j = JSON.parse(fs.readFileSync(p, "utf8")); f(j); fs.writeFileSync(p, JSON.stringify(j)); };

// ---- the fake LINE API -------------------------------------------------------------------------------------------
let state;
function reset(menus = []) {
  state = { calls: [], menus: menus.map((m) => ({ ...m })), def: null, endpoint: null, next: 1, failWhen: null,
    testResult: { success: true, timestamp: "2026-09-14T00:00:00.000Z", statusCode: 200, reason: "OK", detail: "200" } };
}
const oldMenu = (id, name) => ({ richMenuId: id, name, size: { width: 2500, height: 843 }, selected: true, chatBarText: "old", areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: "postback", data: "menu:a", inputOption: "openKeyboard", fillInText: "/a " } }], image: true });
const OLD = () => [oldMenu("old-console", "can2cup-menu-console-v0"), oldMenu("other", "someone-elses-menu"), oldMenu("old-onboard", "can2cup-menu-onboard-v0"), oldMenu("old-samename", "can2cup-menu-console-v1")];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://fake");
    const host = url.pathname.startsWith("/data/") ? "data" : "api";
    const p = host === "data" ? url.pathname.slice(5) : url.pathname;
    const call = { method: req.method, host, path: p, auth: req.headers.authorization, type: req.headers["content-type"], body };
    state.calls.push(call);
    if (VERBOSE) console.log(`   ↳ ${req.method} ${host} ${p}`);
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const json = () => { try { return JSON.parse(body.toString("utf8")); } catch { return undefined; } };
    const route = `${req.method} ${host} ${p}`;
    if (route === "POST api /oauth2/v3/token") {
      const f = new URLSearchParams(body.toString("utf8"));
      return f.get("client_secret") === SECRET ? send(200, { access_token: TOKEN, expires_in: 900, token_type: "Bearer" }) : send(400, { error: "invalid_client" });
    }
    if (call.auth !== `Bearer ${TOKEN}`) return send(401, { message: "Authentication failed. Confirm that the access token in the authorization header is valid." });
    const fail = state.failWhen?.(call);
    if (fail) return send(fail, { message: "injected failure" });
    const pub = (m) => { const { image, ...rest } = m; return rest; };
    let m;
    if (route === "GET api /v2/bot/info") return send(200, { userId: "Ufake", basicId: "@fakebot", displayName: "fake bot", chatMode: "bot", markAsReadMode: "manual" });
    if (route === "GET api /v2/bot/channel/webhook/endpoint") return send(200, { endpoint: state.endpoint ?? "", active: true });
    if (route === "PUT api /v2/bot/channel/webhook/endpoint") { const j = json(); if (!j?.endpoint) return send(400, { message: "endpoint required" }); state.endpoint = j.endpoint; return send(200, {}); }
    if (route === "POST api /v2/bot/channel/webhook/test") return send(200, state.testResult);
    if (route === "GET api /v2/bot/message/quota") return send(200, { type: "limited", value: 200 });
    if (route === "GET api /v2/bot/message/quota/consumption") return send(200, { totalUsage: 12 });
    if (route === "GET api /v2/bot/richmenu/list") return send(200, { richmenus: state.menus.map(pub) });
    if (route === "GET api /v2/bot/richmenu/alias/list") return send(200, { aliases: [] });
    if (route === "GET api /v2/bot/user/all/richmenu") return state.def ? send(200, { richMenuId: state.def }) : send(404, { message: "no default rich menu" });
    if (route === "POST api /v2/bot/richmenu") {
      const j = json();
      if (!j?.name || !j?.size || !Array.isArray(j.areas)) return send(400, { message: "The request body has 1 error(s)" });
      const id = `richmenu-new${state.next++}`;
      state.menus.push({ ...j, richMenuId: id, image: false });
      return send(200, { richMenuId: id });
    }
    if (req.method === "POST" && host === "data" && (m = /^\/v2\/bot\/richmenu\/([^/]+)\/content$/.exec(p))) {
      const menu = state.menus.find((x) => x.richMenuId === m[1]);
      if (!menu) return send(404, { message: "Not found" });
      if (!["image/png", "image/jpeg"].includes(call.type)) return send(415, { message: "Unsupported Media Type" });
      if (menu.image) return send(400, { message: "An image has already been uploaded to the richmenu" });
      menu.image = true;
      return send(200, {});
    }
    if (req.method === "POST" && host === "api" && (m = /^\/v2\/bot\/user\/all\/richmenu\/([^/]+)$/.exec(p))) {
      const menu = state.menus.find((x) => x.richMenuId === m[1]);
      if (!menu) return send(404, { message: "Not found" });
      if (!menu.image) return send(400, { message: "must upload richmenu image before applying it to user" });
      state.def = menu.richMenuId;
      return send(200, {});
    }
    if (req.method === "DELETE" && host === "api" && (m = /^\/v2\/bot\/richmenu\/([^/]+)$/.exec(p))) {
      const i = state.menus.findIndex((x) => x.richMenuId === m[1]);
      if (i < 0) return send(404, { message: "Not found" });
      state.menus.splice(i, 1);
      if (state.def === m[1]) state.def = null;
      return send(200, {});
    }
    return send(404, { message: `fake LINE has no ${route}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ENV_TOKEN = path.join(TMP, ".env.line");
fs.writeFileSync(ENV_TOKEN, `LINE_CHANNEL_ACCESS_TOKEN=${TOKEN}\n`);
const outputs = [];
/** Run line-app.mjs against the fake API. */
function run(argv, { envFile = ENV_TOKEN, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of ["LINE_MENU_CONSOLE", "LINE_MENU_ONBOARD", "CAN2CUP_ENV_DIR"]) delete base[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...argv], { cwd: TMP, timeout: 60_000, env: { ...base, LINE_API_BASE: BASE, LINE_API_DATA_BASE: `${BASE}/data`, LINE_ENV_FILE: envFile, ...env } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      outputs.push(stdout, stderr);
      if (VERBOSE) console.log(`   $ line-app.mjs ${argv.join(" ")} → ${code}\n${stdout}${stderr}`);
      resolve({ code, out: stdout, err: stderr });
    });
  });
}
const seq = () => state.calls.map((c) => `${c.method} ${c.host} ${c.path}`);

// ---- show ----------------------------------------------------------------------------------------------------------
reset(OLD()); state.def = "old-onboard";
let r = await run(["show"]);
expect(r.code === 0, "show exits 0");
expect(r.out.includes('"basicId":"@fakebot"') && r.out.includes('"chatMode":"bot"'), "show prints the bot profile");
expect(r.out.includes("rich menus: 4") && /can2cup-menu-onboard-v0 .*← default/.test(r.out), "show lists the rich menus and marks the default");
expect(r.out.includes('postback menu:a (keyboard: "/a ")') && r.out.includes("rich menu aliases: (none)"), "show describes each area's action and the aliases");
expect(state.calls.every((c) => c.method === "GET"), `show only reads (${state.calls.length} GETs)`);
reset();
r = await run(["show"], { envFile: path.join(TMP, "env-id-secret") });
expect(r.code === 2 && r.err.includes("not found") && state.calls.length === 0, "show without an env file refuses before any call");
fs.writeFileSync(path.join(TMP, "env-id-secret"), `LINE_CHANNEL_ID=1234567890\nLINE_CHANNEL_SECRET=${SECRET}\n`);
r = await run(["show"], { envFile: path.join(TMP, "env-id-secret") });
expect(r.code === 0 && seq()[0] === "POST api /oauth2/v3/token" && seq().slice(1).every((s) => s.startsWith("GET ")), "show with channel id + secret mints a stateless token first, then reads");

// ---- app -----------------------------------------------------------------------------------------------------------
reset();
r = await run(["app"]);
expect(r.code === 2 && r.err.includes("--relay is required") && state.calls.length === 0, "app without --relay refuses, no call");
r = await run(["app", "--relay", "http://relay.example"]);
expect(r.code === 2 && state.calls.length === 0, "app with an http:// relay refuses (LINE takes HTTPS only), no call");
r = await run(["app", "--relay", "https://relay.example/"]);
expect(r.code === 0, "app exits 0");
expect(same(seq(), ["PUT api /v2/bot/channel/webhook/endpoint", "POST api /v2/bot/channel/webhook/test"]), `app: PUT the endpoint, then POST the test (${seq().join(", ")})`);
expect(same(JSON.parse(state.calls[0].body), { endpoint: "https://relay.example/line/webhook" }), "app: the endpoint body is <relay>/line/webhook (trailing slash dropped)");
expect(same(JSON.parse(state.calls[1].body), { endpoint: "https://relay.example/line/webhook" }), "app: the test names the same endpoint");
expect(r.out.includes('"success":true') && r.out.includes('"statusCode":200'), "app prints the test result");
reset(); state.testResult = { success: false, timestamp: "2026-09-14T00:00:00.000Z", statusCode: 404, reason: "NOT_FOUND", detail: "404" };
r = await run(["app", "--relay", "https://relay.example"]);
expect(r.code === 1 && r.out.includes('"statusCode":404') && r.err.includes("did not answer"), "app: a failed webhook test exits 1 and says why");

// ---- menus: refusals and dry runs call nothing ----------------------------------------------------------------------
const refused = async (label, argv, needle, opts) => {
  reset(OLD());
  const x = await run(argv, opts);
  expect(x.code === 2 && x.err.includes(needle) && state.calls.length === 0, `${label} (exit ${x.code}, ${state.calls.length} calls)`);
};
await refused("menus without --dir refuses", ["menus"], "--dir is required");
await refused("menus refuses a console name without the console prefix", ["menus", "--dir", variant("wrong-name", (d) => editJson(d, "console", (j) => { j.name = "my-menu-console-v1"; }))], 'does not start with "can2cup-menu-console"');
await refused("menus refuses an image whose pixel size differs from its JSON", ["menus", "--dir", variant("size-mismatch", (d) => fs.writeFileSync(path.join(d, "onboard.png"), png(2500, 1686)))], "pixels, but onboard.json declares 2500x843");
await refused("menus refuses an image that is neither PNG nor JPEG", ["menus", "--dir", variant("gif", (d) => fs.writeFileSync(path.join(d, "console.png"), Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")))], "not a PNG or JPEG");
await refused("menus refuses an image over 1 MB", ["menus", "--dir", variant("big", (d) => fs.writeFileSync(path.join(d, "console.png"), Buffer.concat([png(2500, 1686), Buffer.alloc(1_000_001)])))], "1 MB");
await refused("menus refuses a size LINE does not take (aspect ratio under 1.45)", ["menus", "--dir", variant("tall", (d) => { editJson(d, "onboard", (j) => { j.size = { width: 1200, height: 1000 }; j.areas = [{ bounds: { x: 0, y: 0, width: 1200, height: 1000 }, action: { type: "message", text: "/help" } }]; }); fs.writeFileSync(path.join(d, "onboard.png"), png(1200, 1000)); })], "width/height");
await refused("menus refuses a missing image", ["menus", "--dir", variant("no-image", (d) => fs.rmSync(path.join(d, "onboard.png")))], "missing");
await refused("menus refuses --console-prefix the JSON name does not match", ["menus", "--dir", GOOD, "--console-prefix", "custom-console"], 'does not start with "custom-console" (--console-prefix)');
await refused("menus takes LINE_MENU_ONBOARD from the env file", ["menus", "--dir", GOOD, "--dry-run"], "LINE_MENU_ONBOARD (", { envFile: (fs.writeFileSync(path.join(TMP, "env-prefix"), `LINE_CHANNEL_ACCESS_TOKEN=${TOKEN}\nLINE_MENU_ONBOARD=custom-onboard\n`), path.join(TMP, "env-prefix")) });
await refused("menus refuses prefixes where one starts with the other", ["menus", "--dir", GOOD, "--dry-run", "--console-prefix", "can2cup-menu"], "one starts with the other");

reset(OLD());
r = await run(["menus", "--dir", GOOD, "--dry-run"]);
expect(r.code === 0 && state.calls.length === 0, "menus --dry-run exits 0 with zero calls");
expect(r.out.includes('create the console menu "can2cup-menu-console-v1" 2500x1686, 8 areas') && r.out.includes('make "can2cup-menu-onboard-v1" the default') && r.out.includes("dry run: nothing was sent"), "…and prints the plan");
r = await run(["menus", "--dir", GOOD, "--dry-run"], { envFile: path.join(TMP, "no-such-env") });
expect(r.code === 0 && state.calls.length === 0, "menus --dry-run works without an env file");
const custom = variant("custom", (d) => { editJson(d, "console", (j) => { j.name = "fork-console-v3"; }); editJson(d, "onboard", (j) => { j.name = "fork-onboard-v3"; }); });
r = await run(["menus", "--dir", custom, "--dry-run"], { env: { LINE_MENU_CONSOLE: "fork-console", LINE_MENU_ONBOARD: "fork-onboard" } });
expect(r.code === 0 && r.out.includes('"fork-console" from LINE_MENU_CONSOLE (environment)'), "menus takes the prefixes from the process environment");
r = await run(["menus", "--dir", custom, "--dry-run", "--console-prefix", "fork-console", "--onboard-prefix", "fork-onboard"]);
expect(r.code === 0 && r.out.includes('"fork-onboard" from --onboard-prefix'), "menus takes the prefixes from the flags");
const jpg = variant("jpeg", (d) => { fs.rmSync(path.join(d, "console.png")); fs.writeFileSync(path.join(d, "console.jpg"), jpeg(2500, 1686)); });
r = await run(["menus", "--dir", jpg, "--dry-run"]);
expect(r.code === 0 && r.out.includes("console.jpg (image/jpeg"), "menus reads a JPEG's pixel size from its SOF header");
reset(OLD());
r = await run(["menus", "--dir", variant("jpeg-wrong", (d) => { fs.rmSync(path.join(d, "console.png")); fs.writeFileSync(path.join(d, "console.jpg"), jpeg(2500, 843)); })]);
expect(r.code === 2 && r.err.includes("2500x843 pixels") && state.calls.length === 0, "…and refuses a JPEG of the wrong size, no call");

// ---- menus: the install ---------------------------------------------------------------------------------------------
reset(OLD());
r = await run(["menus", "--dir", GOOD]);
expect(r.code === 0, `menus exits 0${r.code ? `: ${r.err}` : ""}`);
expect(same(seq(), [
  "POST api /v2/bot/richmenu", "POST data /v2/bot/richmenu/richmenu-new1/content",
  "POST api /v2/bot/richmenu", "POST data /v2/bot/richmenu/richmenu-new2/content",
  "POST api /v2/bot/user/all/richmenu/richmenu-new2",
  "GET api /v2/bot/richmenu/list",
  "DELETE api /v2/bot/richmenu/old-console", "DELETE api /v2/bot/richmenu/old-onboard", "DELETE api /v2/bot/richmenu/old-samename",
]), "menus call order: console create+upload, onboard create+upload, default, list, deletions last");
if (VERBOSE || state.calls.length !== 9) console.log(`       calls: ${seq().join(" | ")}`);
const [cCreate, cUpload, oCreate, oUpload] = state.calls.length >= 4 ? state.calls : Array(4).fill({ body: Buffer.from("{}") });
expect(JSON.parse(cCreate.body).name === "can2cup-menu-console-v1" && JSON.parse(oCreate.body).name === "can2cup-menu-onboard-v1", "the first create is the console menu, the second the onboard menu");
expect(same(JSON.parse(cCreate.body), JSON.parse(fs.readFileSync(path.join(GOOD, "console.json"), "utf8"))), "the console create sends console.json as it is");
expect(cUpload.type === "image/png" && cUpload.body.equals(fs.readFileSync(path.join(GOOD, "console.png"))) && oUpload.body.equals(fs.readFileSync(path.join(GOOD, "onboard.png"))), "each upload sends its file's bytes as image/png to the data host");
expect(state.def === "richmenu-new2", "the onboard menu is the default");
expect(same(state.menus.map((m) => m.richMenuId).sort(), ["other", "richmenu-new1", "richmenu-new2"]), "only older menus with either prefix were deleted (another menu and the new ones stay; an old one with the new name goes)");
expect(r.out.includes("created console: richmenu-new1") && r.out.includes("created onboard: richmenu-new2") && r.out.includes('deleted: old-console "can2cup-menu-console-v0"'), "menus prints the created ids and the deletions");
reset([oldMenu("other", "someone-elses-menu")]);
r = await run(["menus", "--dir", GOOD]);
expect(r.code === 0 && r.out.includes("deleted: none") && !seq().some((s) => s.startsWith("DELETE")), "menus with no older menus deletes nothing");

// ---- menus: a failure before the default rolls back -------------------------------------------------------------------
reset(OLD()); state.def = "old-onboard";
state.failWhen = (c) => (c.host === "data" && c.path.includes("richmenu-new2") ? 500 : null);
r = await run(["menus", "--dir", GOOD]);
expect(r.code === 1 && r.err.includes("upload the onboard image"), "a failed onboard upload exits 1 and says which step");
expect(same(seq().slice(4), ["DELETE api /v2/bot/richmenu/richmenu-new2", "DELETE api /v2/bot/richmenu/richmenu-new1"]) && !seq().some((s) => s.includes("/user/all/richmenu")), `…deletes the two menus it created, sets no default (${seq().slice(4).join(", ")})`);
expect(same(state.menus.map((m) => m.richMenuId).sort(), ["old-console", "old-onboard", "old-samename", "other"]) && state.def === "old-onboard", "…and leaves the older menus and the default as they were");

// ---- the token -------------------------------------------------------------------------------------------------------
expect(!outputs.some((o) => o.includes(TOKEN) || o.includes(SECRET)), `the token and secret appear in no output (${outputs.length / 2} runs)`);

server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nall ${checks} passed`);
process.exit(fails ? 1 : 0);
