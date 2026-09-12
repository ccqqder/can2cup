import * as ed from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils.js";

// noble-ed25519 v3: the sync API needs a SHA-512 wired in. Same code runs in
// Node and in Workers, so we avoid the WebCrypto async path entirely.
ed.hashes.sha512 = sha512;

export { bytesToHex, hexToBytes };

export function randomHex(bytes: number): string {
  return bytesToHex(randomBytes(bytes));
}

export function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

export function newKeypair(): { priv: string; pub: string } {
  const priv = ed.utils.randomSecretKey();
  return { priv: bytesToHex(priv), pub: bytesToHex(ed.getPublicKey(priv)) };
}

export function pubFromPriv(privHex: string): string {
  return bytesToHex(ed.getPublicKey(hexToBytes(privHex)));
}

export function signHex(message: string, privHex: string): string {
  return bytesToHex(ed.sign(utf8ToBytes(message), hexToBytes(privHex)));
}

export function verifyHex(sigHex: string, message: string, pubHex: string): boolean {
  try {
    return ed.verify(hexToBytes(sigHex), utf8ToBytes(message), hexToBytes(pubHex));
  } catch {
    return false;
  }
}
