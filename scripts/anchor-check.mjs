// Local end-to-end: does a commitment on a real room reach the TSA and land as an anchor?
import { pubFromPriv, signHex, signingBytes, randomHex } from "../dist/protocol/index.js";
const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const KEY = process.env.RELAY_KEY;
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; } };

const priv = randomHex(32), pub = pubFromPriv(priv);
const room = await j(await fetch(`${RELAY}/rooms`, { method: "POST",
  headers: { "content-type": "application/json", "x-parley-key": KEY },
  body: JSON.stringify({ name: "anchor probe", creator: { pubkey: pub, name: "probe" } }) }));
if (!room.id) { console.error("create failed:", room); process.exit(1); }
console.log("room:", room.id);

const auth = { "content-type": "application/json", authorization: `Bearer ${room.cap}` };
const before = await j(await fetch(`${RELAY}/rooms/${room.id}/messages?since=0`, { headers: auth }));
const prev = before.lastHash;

const unsigned = { v: 1, room: room.id, from: pub, ts: new Date().toISOString(),
  type: "accept", body: { text: "probe accepts the terms" }, prev };
const sent = await j(await fetch(`${RELAY}/rooms/${room.id}/messages`, { method: "POST", headers: auth,
  body: JSON.stringify({ ...unsigned, sig: signHex(signingBytes(unsigned), priv) }) }));
console.log("accept stored at seq:", sent.seq, "type:", sent.type);

for (let i = 0; i < 20; i++) {
  const a = await j(await fetch(`${RELAY}/rooms/${room.id}/anchor`, { headers: auth }));
  if (a.token) {
    console.log("ANCHOR seq:", a.seq, "status:", a.status, "tsa:", a.tsa);
    console.log("head hash matches accept hash:", a.hash === sent.hash);
    console.log("stale:", a.stale, "| token b64 bytes:", a.token.length);
    const fs = await import("node:fs");
    fs.writeFileSync(process.argv[2] + "/worker-resp.tsr", Buffer.from(a.token, "base64"));
    console.log("token written for openssl verification");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error("no anchor appeared within 10s");
process.exit(1);
