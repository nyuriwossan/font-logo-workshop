import type { Mat, Vec } from '../model/types';

export const I: Mat = [1, 0, 0, 1, 0, 0];

/** m1 * m2 （m2 を先に適用し、その結果に m1 を適用） */
export function mul(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function apply(m: Mat, x: number, y: number): Vec {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, -e, -f];
  const id = 1 / det;
  return [d * id, -b * id, -c * id, a * id, (c * f - d * e) * id, (b * e - a * f) * id];
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/** 点 (cx, cy) を中心に m を適用する行列 */
export function about(m: Mat, cx: number, cy: number): Mat {
  return mul(translate(cx, cy), mul(m, translate(-cx, -cy)));
}

/** 行列の平均的な拡大率（線幅や影のスケールに使う） */
export function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function isIdentity(m: Mat): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

export function roundMat(m: Mat): Mat {
  return m.map((v) => Math.round(v * 1e6) / 1e6) as Mat;
}
