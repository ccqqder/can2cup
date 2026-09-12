/**
 * End-to-end encryption (v0.5.0). Simple and stupid on purpose:
 *
 *   - The room key is a 32-byte secret minted at room creation. It rides in the invite's
 *     URL FRAGMENT (the part after #, which a browser never sends and the relay never
 *     logs) — the same channel the room secret already uses. Whoever holds the invite
 *     holds the key; that is the room's existing trust model, now extended to content.
 *   - AES-256-GCM through WebCrypto, which Node 18+ and Workers both ship. The room id
 *     is the additional authenticated data, so a ciphertext cannot be replayed into a
 *     different room.
 *   - Signatures and the hash chain are computed over the CIPHERTEXT. Verification,
 *     ordering, export, import and mirroring therefore work unchanged on encrypted
 *     rooms — the relay keeps doing its whole job without understanding a word.
 *
 * What this is not: forward secrecy, per-message ratchets, deniability. Anyone who ever
 * held the invite can read the whole room. That is the documented trade for "everyone
 * can use it"; a stricter scheme can replace this file without touching the chain.
 */
import { bytesToHex, hexToBytes, randomHex } from "./crypto.js";

export interface EncBody { e2e: 1; iv: string; ct: string }

export const isEncrypted = (b: unknown): b is EncBody =>
  !!b && typeof b === "object" && (b as { e2e?: unknown }).e2e === 1
  && typeof (b as EncBody).iv === "string" && typeof (b as EncBody).ct === "string";

export function newRoomKey(): string {
  return randomHex(32);
}

function aesKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(keyHex) as unknown as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptBody(keyHex: string, room: string, body: unknown): Promise<EncBody> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(room) },
    await aesKey(keyHex),
    new TextEncoder().encode(JSON.stringify(body ?? null)),
  );
  return { e2e: 1, iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)) };
}

/** Returns undefined when the key is wrong or the ciphertext / room id was tampered with. */
export async function decryptBody(keyHex: string, room: string, b: EncBody): Promise<unknown> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(b.iv) as unknown as BufferSource, additionalData: new TextEncoder().encode(room) },
      await aesKey(keyHex),
      hexToBytes(b.ct) as unknown as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return undefined;
  }
}
