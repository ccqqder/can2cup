/**
 * Focused end-to-end test for the brokerage layer, isolated from the full smoke suite so a sealed-bid
 * settlement can be validated on its own against a live relay. Two MCP servers (a buyer and a seller with
 * separate homes) talk through a relay and settle by sealed bid — exercising BOTH authorisation paths:
 *   - unsigned_may_commit: the agent sets its own hidden bid within the cap;
 *   - signed: the principal authorises the figure with `can2cup seal-bid`, off-chain, on the machine.
 *
 *   RELAY=http://127.0.0.1:8787 RELAY_KEY=dev node dist/scripts/mechanism-e2e.js
 *   (same relay requirements as smoke: RELAY_SIGNING_KEY + PRESENCE_GRACE_SEC=2 in .dev.vars)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { newKeypair, decodeInvite } from "../protocol/index.js";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const RELAY_KEY = process.env.RELAY_KEY ?? "dev";
const server = path.resolve("dist/mcp/index.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function expect(cond: unknown, msg: string): void {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  passed++; console.log("  ok:", msg);
}

const transports = new Map<Client, StdioClientTransport>();
async function spawn(name: string, home: string, canCreate: boolean): Promise<Client> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, PARLEY_HOME: home, PARLEY_NAME: name, PARLEY_RELAY: RELAY };
  if (canCreate) env.PARLEY_RELAY_KEY = RELAY_KEY;
  const t = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "inherit" });
  const c = new Client({ name: `mech-${name}`, version: "0" });
  await c.connect(t); transports.set(c, t); return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await c.callTool({ name, arguments: args });
  const content = (r.content as Array<{ type: string; text?: string }>) ?? [];
  const out = content.map((x) => x.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name} failed: ${out}`);
  return out;
}
function tmpHome(name: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `mech-${name}-`)); }
const seqOf = (s: string): number => Number(/sent #(\d+)/.exec(s)?.[1]);

const aliceHome = tmpHome("alice");
const bobHome = tmpHome("bob");
const aliceMandatePath = path.join(aliceHome, "mandate.json");
const unsignedAlice = { never_disclose: [], may_share: [], may_grant: [], max_grant_hours: 24, max_commit_amount: 5000, currency: "TWD", unsigned_may_commit: true };
const signedAlice = { ...unsignedAlice, unsigned_may_commit: false };
fs.writeFileSync(aliceMandatePath, JSON.stringify(unsignedAlice));
fs.writeFileSync(path.join(bobHome, "mandate.json"), JSON.stringify({ never_disclose: ["3500"], may_share: [], may_grant: [], max_grant_hours: 2, max_commit_amount: 3000, currency: "TWD", unsigned_may_commit: true }));
fs.writeFileSync(path.join(aliceHome, "principal.json"), JSON.stringify({ ...newKeypair(), createdAt: new Date().toISOString(), label: "mech-e2e" }));

function cli(home: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), ...args], { env: { ...process.env as Record<string, string>, PARLEY_HOME: home, PARLEY_RELAY: RELAY }, encoding: "utf8" });
}

async function makeRoom(alice: Client, bob: Client, name: string): Promise<string> {
  const created = await call(alice, "can2cup_create_room", { name });
  const roomId = /room created: ([0-9a-f]{12})/.exec(created)?.[1]!;
  const link = /https?:\/\/\S+\/j\/[0-9a-f]{12}\S*/.exec(created)?.[0]!;
  decodeInvite(link); // sanity
  await call(bob, "can2cup_join", { invite: `join: ${link}` });
  await call(alice, "can2cup_wait", { room: roomId, timeout: 0 }); // drain the join event
  return roomId;
}

const alice = await spawn("Alice", aliceHome, true);
const bob = await spawn("Bob", bobHome, false);

// ============================================================ 1) unsigned path ============
console.log("\n[1] unsigned_may_commit path — each agent sets its own hidden bid within its cap");
{
  const room = await makeRoom(alice, bob, "sealed unsigned");
  const open = seqOf(await call(bob, "can2cup_mechanism", { room, phase: "open", side: "sell", k: 0.5, currency: "TWD" }));
  expect(open > 0, "seller opened the mechanism");

  const bobC = await call(bob, "can2cup_mechanism", { room, phase: "commit", ref: open, bid: 2600 });
  expect(bobC.startsWith("sent #"), "seller committed 2600 (hidden)");
  const held = await call(bob, "can2cup_mechanism", { room, phase: "reveal", ref: open });
  expect(held.startsWith("NOT SENT") && /other side has not committed/.test(held), "seller cannot reveal before buyer commits (seal holds)");
  const over = await call(bob, "can2cup_mechanism", { room, phase: "commit", ref: open, bid: 99999 });
  expect(over.startsWith("NOT SENT") && /exceeds max_commit_amount/.test(over), "a bid over the cap is refused");

  await call(alice, "can2cup_wait", { room, timeout: 0 });
  const aliceC = await call(alice, "can2cup_mechanism", { room, phase: "commit", ref: open, bid: 3400 });
  expect(aliceC.startsWith("sent #"), "buyer committed 3400 (hidden)");

  const hist = await call(bob, "can2cup_history", { room });
  expect(!hist.includes("2600") && !hist.includes("3400"), "neither bid is on the transcript while only the commits are");

  expect((await call(bob, "can2cup_mechanism", { room, phase: "reveal", ref: open })).startsWith("sent #"), "seller revealed after both committed");
  await call(alice, "can2cup_wait", { room, timeout: 0 });
  expect((await call(alice, "can2cup_mechanism", { room, phase: "reveal", ref: open })).startsWith("sent #"), "buyer revealed");

  await call(bob, "can2cup_wait", { room, timeout: 0 });
  const status = await call(bob, "can2cup_mechanism", { room, phase: "status", ref: open });
  expect(/DEAL at 3000/.test(status), `settled at k=0.5 midpoint of 2600 and 3400 = 3000  [${status.slice(0, 100)}]`);
}

// ============================================================ 2) signed seal-bid path =====
console.log("\n[2] signed path — the principal authorises the bid with `can2cup seal-bid`, off-chain");
{
  fs.writeFileSync(aliceMandatePath, JSON.stringify(signedAlice)); // widened, NOT unsigned: signature required
  const room = await makeRoom(alice, bob, "sealed signed");
  const open = seqOf(await call(alice, "can2cup_mechanism", { room, phase: "open", side: "buy", k: 0.5, currency: "TWD" }));
  expect(open > 0, "buyer (alice) opened the mechanism");

  const noAuth = await call(alice, "can2cup_mechanism", { room, phase: "commit", ref: open, bid: 3200 });
  expect(noAuth.startsWith("NOT SENT") && /seal-bid/.test(noAuth), "under a signed mandate, committing without a seal-bid is refused (and names the command)");

  const sb = cli(aliceHome, "seal-bid", room, String(open), "buy", "3200");
  expect(sb.status === 0 && /sealed bid authorised/.test(sb.stdout), "the principal authorised the bid locally with can2cup seal-bid");

  const aliceC = await call(alice, "can2cup_mechanism", { room, phase: "commit", ref: open });
  expect(aliceC.startsWith("sent #"), "buyer committed using the principal-signed bid (no bid arg needed)");

  await call(bob, "can2cup_wait", { room, timeout: 0 });
  const bobC = await call(bob, "can2cup_mechanism", { room, phase: "commit", ref: open, bid: 2400 });
  expect(bobC.startsWith("sent #"), "seller (unsigned path) committed 2400");

  await call(alice, "can2cup_wait", { room, timeout: 0 });
  expect((await call(alice, "can2cup_mechanism", { room, phase: "reveal", ref: open })).startsWith("sent #"), "buyer revealed");
  await call(bob, "can2cup_wait", { room, timeout: 0 });
  expect((await call(bob, "can2cup_mechanism", { room, phase: "reveal", ref: open })).startsWith("sent #"), "seller revealed");

  await call(alice, "can2cup_wait", { room, timeout: 0 });
  const status = await call(alice, "can2cup_mechanism", { room, phase: "status", ref: open });
  expect(/DEAL at 2800/.test(status), `settled at k=0.5 midpoint of 2400 and 3200 = 2800  [${status.slice(0, 100)}]`);
}

console.log(`\nmechanism-e2e: ${passed} checks passed`);
for (const c of transports.keys()) await c.close().catch(() => undefined);
await sleep(200);
process.exit(0);
