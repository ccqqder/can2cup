/** Canonical JSON: keys sorted recursively, undefined dropped, no whitespace.
 *  Both the signature and the hash chain are computed over this form, so the
 *  relay (Workers) and the client (Node) must share exactly this function. */
export function canon(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  // v0.14.5 (seventh opinion #1): a null-prototype object, not `{}`. JSON.parse makes "__proto__" an OWN
  // property, and Object.keys lists it — but assigning out["__proto__"] on a plain object hits the prototype
  // setter and never becomes a JSON field. So a key named __proto__ was silently DROPPED from the canonical
  // bytes every signature and hash is computed over, while every other reader (Object.values, a never_disclose
  // scan over the raw object, a manifest's file table) still saw it. Unsigned content, valid signature.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = sortKeys(x);
  }
  return out;
}
