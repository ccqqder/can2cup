/** v0.9.0 upgrade protocol: the only comparison both relay and client need. "1.2.3" style; unknown → 0.0.0. */
export function parseSemver(v: string | null | undefined): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** negative when a < b, 0 when equal, positive when a > b. */
export function cmpSemver(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const NO_VERSION = "0.0.0";
