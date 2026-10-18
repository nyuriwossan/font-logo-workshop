import type { Obj, Mat, Vec } from '../model/types';
import { strokeOutline, pathFlat, ringsBBox } from './outline';
import { apply, mul, invert, matScale } from './matrix';
import { layoutText } from '../render/textLayout';
import type { RenderEnv } from '../render/env';
import { distToSegment } from './path';

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const emptyBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export const boxValid = (b: BBox) => isFinite(b.minX) && isFinite(b.maxX);

export function boxUnion(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function transformBox(b: BBox, m: Mat): BBox {
  if (!boxValid(b)) return b;
  const pts = [apply(m, b.minX, b.minY), apply(m, b.maxX, b.minY), apply(m, b.minX, b.maxY), apply(m, b.maxX, b.maxY)];
  const out = emptyBox();
  for (const p of pts) {
    out.minX = Math.min(out.minX, p.x);
    out.minY = Math.min(out.minY, p.y);
    out.maxX = Math.max(out.maxX, p.x);
    out.maxY = Math.max(out.maxY, p.y);
  }
  return out;
}

const localCache = new WeakMap<Obj, { env: RenderEnv | null; box: BBox }>();

/** オブジェクト自身の座標系での範囲（transform 適用前） */
export function localBox(o: Obj, env: RenderEnv, depth = 0): BBox {
  const hit = localCache.get(o);
  if (hit && (hit.env === env || o.type === 'stroke' || o.type === 'path')) return hit.box;
  let box = emptyBox();
  switch (o.type) {
    case 'stroke': {
      const b = ringsBBox([strokeOutline(o)]);
      if (b) box = b;
      else if (o.points.length) {
        const [x, y] = o.points[0];
        box = { minX: x, minY: y, maxX: x, maxY: y };
      }
      break;
    }
    case 'path': {
      const b = ringsBBox([pathFlat(o)]);
      if (b) {
        const r = o.strokeWidth / 2;
        box = { minX: b.minX - r, minY: b.minY - r, maxX: b.maxX + r, maxY: b.maxY + r };
      }
      break;
    }
    case 'group':
      for (const c of o.children) box = boxUnion(box, transformBox(localBox(c, env, depth), c.transform));
      break;
    case 'text': {
      const l = layoutText(o, env);
      box = { minX: l.bbox.x, minY: l.bbox.y, maxX: l.bbox.x + l.bbox.w, maxY: l.bbox.y + l.bbox.h };
      // 縁取り分を含める
      if (o.style?.outline.on) {
        const w = o.style.outline.width;
        box = { minX: box.minX - w, minY: box.minY - w, maxX: box.maxX + w, maxY: box.maxY + w };
      }
      break;
    }
    case 'logoRef': {
      const logo = env.logos.find((l) => l.id === o.logoId);
      if (logo && depth < 3) box = objectsBox(logo.objects, env, depth + 1);
      if (!boxValid(box) && logo) box = { minX: 0, minY: 0, maxX: logo.width, maxY: logo.height };
      break;
    }
  }
  localCache.set(o, { env, box });
  return box;
}

export function objBox(o: Obj, env: RenderEnv, depth = 0): BBox {
  return transformBox(localBox(o, env, depth), o.transform);
}

export function objectsBox(objs: Obj[], env: RenderEnv, depth = 0): BBox {
  let b = emptyBox();
  for (const o of objs) if (!o.hidden) b = boxUnion(b, objBox(o, env, depth));
  return b;
}

// ===== ヒットテスト =====

function windingContains(r: Vec[], p: Vec): boolean {
  let wn = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[j];
    const b = r[i];
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) wn++;
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) wn--;
  }
  return wn !== 0;
}

function nearPolyline(pts: Vec[], p: Vec, tol: number, closed: boolean): boolean {
  if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y) <= tol;
  for (let i = 0; i < pts.length - 1; i++) if (distToSegment(p, pts[i], pts[i + 1]) <= tol) return true;
  if (closed && pts.length > 2 && distToSegment(p, pts[pts.length - 1], pts[0]) <= tol) return true;
  return false;
}

/** p は親座標。tol は親座標での許容距離 */
export function hitObj(o: Obj, p: Vec, tol: number, env: RenderEnv, parent: Mat = [1, 0, 0, 1, 0, 0]): boolean {
  if (o.hidden) return false;
  const m = mul(parent, o.transform);
  const inv = invert(m);
  const lp = apply(inv, p.x, p.y);
  const lt = tol / Math.max(1e-6, matScale(m));
  switch (o.type) {
    case 'stroke': {
      const ring = strokeOutline(o);
      if (ring.length >= 3 && windingContains(ring, lp)) return true;
      const center = o.points.map(([x, y]) => ({ x, y }));
      return nearPolyline(center, lp, lt + o.pen.size * 0.3, false);
    }
    case 'path': {
      const flat = pathFlat(o);
      if (o.closed && o.fill && flat.length >= 3 && windingContains(flat, lp)) return true;
      return nearPolyline(flat, lp, lt + o.strokeWidth / 2, o.closed);
    }
    case 'group':
      return o.children.some((c) => hitObj(c, p, tol, env, m));
    case 'text':
    case 'logoRef': {
      const b = localBox(o, env);
      return lp.x >= b.minX - lt && lp.x <= b.maxX + lt && lp.y >= b.minY - lt && lp.y <= b.maxY + lt;
    }
  }
}

/** 上にあるものから順にヒットを探す */
export function hitTopmost(objs: Obj[], p: Vec, tol: number, env: RenderEnv): Obj | null {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.locked) continue;
    if (o.type === 'stroke' && o.erase) continue;
    if (hitObj(o, p, tol, env)) return o;
  }
  return null;
}

/** 消しゴム（線ごと）用：点の近くの全オブジェクト */
export function hitAll(objs: Obj[], p: Vec, tol: number, env: RenderEnv): Obj[] {
  return objs.filter((o) => !o.locked && hitObj(o, p, tol, env));
}
