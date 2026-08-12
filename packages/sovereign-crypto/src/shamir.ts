/**
 * Shamir's Secret Sharing over GF(256).
 * Shares use x = 1..n; reconstruct evaluates Lagrange at x = 0.
 */

import { randomBytes, bytesToBase64Url, base64UrlToBytes } from "./encoding.js";

const LOG: number[] = new Array(256).fill(0);
const EXP: number[] = new Array(256).fill(0);

(function initTables() {
  // GF(2^8) with primitive polynomial 0x11d (x^8+x^4+x^3+x^2+1).
  // Doubling generates the multiplicative group (order 255).
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = x << 1;
    if (x >= 256) x ^= 0x11d;
  }
  EXP[255] = EXP[0]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF div by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

function evalPoly(coeffs: Uint8Array, x: number): number {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    y = gfMul(y, x) ^ coeffs[i]!;
  }
  return y;
}

export type ShamirShare = {
  index: number;
  value: string;
};

export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  shareCount: number,
): ShamirShare[] {
  if (threshold < 2) throw new Error("threshold must be >= 2");
  if (shareCount < threshold || shareCount > 255) {
    throw new Error("shareCount must satisfy threshold <= n <= 255");
  }
  if (secret.length === 0) throw new Error("empty secret");

  const shares: Uint8Array[] = Array.from({ length: shareCount }, () =>
    new Uint8Array(secret.length),
  );

  for (let bi = 0; bi < secret.length; bi++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[bi]!;
    for (let c = 1; c < threshold; c++) {
      coeffs[c] = randomBytes(1)[0]!;
    }
    for (let x = 1; x <= shareCount; x++) {
      shares[x - 1]![bi] = evalPoly(coeffs, x);
    }
  }

  return shares.map((value, i) => ({
    index: i + 1,
    value: bytesToBase64Url(value),
  }));
}

export function combineShares(shares: ShamirShare[]): Uint8Array {
  if (shares.length < 2) throw new Error("need at least 2 shares");
  const points = shares.map((s) => ({
    x: s.index,
    y: base64UrlToBytes(s.value),
  }));
  const len = points[0]!.y.length;
  if (!points.every((s) => s.y.length === len && s.x >= 1 && s.x <= 255)) {
    throw new Error("invalid share set");
  }
  const xs = new Set(points.map((s) => s.x));
  if (xs.size !== points.length) throw new Error("duplicate share indexes");

  const secret = new Uint8Array(len);
  for (let bi = 0; bi < len; bi++) {
    let acc = 0;
    for (let i = 0; i < points.length; i++) {
      const xi = points[i]!.x;
      const yi = points[i]!.y[bi]!;
      let num = 1;
      let den = 1;
      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        const xj = points[j]!.x;
        num = gfMul(num, xj);
        den = gfMul(den, xi ^ xj);
      }
      acc ^= gfMul(yi, gfDiv(num, den));
    }
    secret[bi] = acc;
  }
  return secret;
}

export function splitRecoveryMasterKey(
  threshold: number,
  shareCount: number,
  secretBytes = 32,
): { secret: Uint8Array; shares: ShamirShare[] } {
  const secret = randomBytes(secretBytes);
  return { secret, shares: splitSecret(secret, threshold, shareCount) };
}
