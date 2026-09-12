/**
 * RFC 3161 trusted timestamps over the transcript head.
 *
 * The problem this closes: the relay signs the head, so a client that pinned the
 * relay key can prove a fork after the fact — but only against a relay that keeps
 * its key honest. The operator holds that key. For a transcript meant to be cited
 * later, "trust the operator's clock" is exactly the objection the reader will
 * raise. A Time Stamping Authority is a neutral third party that signs
 * "this digest existed at this time", and it is the primitive eIDAS/PAdES/CAdES
 * already build on, so the attestation is one a lawyer recognises.
 *
 * Scope, deliberately: we BUILD the TimeStampReq and STORE the TimeStampResp as
 * an opaque DER blob. We do not verify the CMS SignedData or walk the TSA's X.509
 * chain here — doing that properly needs a real PKI stack, and a half-verified
 * token is worse than an unverified one. Verification belongs where the tooling
 * exists: `openssl ts -verify`. The relay only checks PKIStatus so it never
 * stores a rejection as if it were evidence.
 *
 * Disabled unless TSA_URL is set. An unset relay answers "not configured" rather
 * than silently skipping, so nobody believes they have an anchor they do not have.
 */

// ------------------------------------------------------------------ DER ---

const tag = (t: number, body: Uint8Array): Uint8Array => {
  const len = body.length;
  let header: number[];
  if (len < 0x80) header = [t, len];
  else {
    const bytes: number[] = [];
    for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
    header = [t, 0x80 | bytes.length, ...bytes];
  }
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const SEQUENCE = 0x30, INTEGER = 0x02, OCTET_STRING = 0x04, NULL = 0x05, BOOLEAN = 0x01, OID = 0x06;

/** 2.16.840.1.101.3.4.2.1 — id-sha256 */
const OID_SHA256 = new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToB64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

/**
 * TimeStampReq ::= SEQUENCE {
 *   version INTEGER {v1(1)}, messageImprint MessageImprint,
 *   reqPolicy TSAPolicyId OPTIONAL, nonce INTEGER OPTIONAL,
 *   certReq BOOLEAN DEFAULT FALSE, extensions [0] IMPLICIT Extensions OPTIONAL }
 *
 * `digest` is the sha256 the TSA will attest to — for us, the chain head hash,
 * which is already a sha256 over the canonical envelope.
 */
export function buildTimeStampReq(digest: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error("sha256 digest must be 32 bytes");
  const algId = tag(SEQUENCE, concat(tag(OID, OID_SHA256), tag(NULL, new Uint8Array(0))));
  const messageImprint = tag(SEQUENCE, concat(algId, tag(OCTET_STRING, digest)));
  // DER INTEGER is signed: a leading bit of 1 would read as negative.
  const n = nonce[0] & 0x80 ? concat(new Uint8Array([0]), nonce) : nonce;
  return tag(SEQUENCE, concat(
    tag(INTEGER, new Uint8Array([1])),
    messageImprint,
    tag(INTEGER, n),
    tag(BOOLEAN, new Uint8Array([0xff])), // certReq: ask the TSA to include its cert
  ));
}

/**
 * Read PKIStatus out of a TimeStampResp. Structure:
 *   TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken TST OPTIONAL }
 *   PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }
 * 0 = granted, 1 = grantedWithMods; anything else is a rejection.
 */
export function readPkiStatus(resp: Uint8Array): number | undefined {
  let i = 0;
  const readLen = (): number => {
    let len = resp[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + resp[i++];
    }
    return len;
  };
  if (resp[i++] !== SEQUENCE) return undefined; // TimeStampResp
  readLen();
  if (resp[i++] !== SEQUENCE) return undefined; // PKIStatusInfo
  readLen();
  if (resp[i++] !== INTEGER) return undefined;
  const len = readLen();
  let v = 0;
  for (let k = 0; k < len; k++) v = v * 256 + resp[i++];
  return v;
}

// ------------------------------------------------------------- request ---

export interface Anchor {
  seq: number;
  hash: string;        // the transcript head this attests to
  requestedAt: string; // relay clock — informational only; the TSA's clock is inside the token
  tsa: string;
  status: number;      // PKIStatus: 0 granted, 1 grantedWithMods
  token: string;       // base64 DER TimeStampResp — verify with `openssl ts -verify`
}

export class AnchorError extends Error {}

/** POST an RFC 3161 query and return the stored anchor. Throws AnchorError on any
 *  outcome that is not a granted token, so a failure is never stored as evidence. */
export async function requestTimestamp(
  tsaUrl: string, seq: number, headHash: string, nonceHex: string,
): Promise<Anchor> {
  const req = buildTimeStampReq(hexToBytes(headHash), hexToBytes(nonceHex));
  let res: Response;
  try {
    res = await fetch(tsaUrl, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query" },
      // workers-types' BodyInit predates TS's generic Uint8Array<ArrayBufferLike>; the
      // runtime accepts a typed array here. Narrow cast rather than copying the buffer.
      body: req as unknown as BodyInit,
    });
  } catch (e) {
    throw new AnchorError(`TSA unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new AnchorError(`TSA returned HTTP ${res.status}`);

  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length === 0) throw new AnchorError("TSA returned an empty body");
  const status = readPkiStatus(body);
  if (status === undefined) throw new AnchorError("TSA response is not a TimeStampResp");
  if (status !== 0 && status !== 1) throw new AnchorError(`TSA rejected the request (PKIStatus ${status})`);

  return {
    seq, hash: headHash, requestedAt: new Date().toISOString(),
    tsa: tsaUrl, status, token: bytesToB64(body),
  };
}
