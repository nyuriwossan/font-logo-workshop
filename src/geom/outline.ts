import { getStroke } from 'perfect-freehand';
import type { Obj, PathObj, StrokeObj, Vec, Glyph, Mat } from '../model/types';
import { flattenPath } from './path';
import { apply, mul, I, about, scale as scaleM, translate } from './matrix';
import {
  type Ring,
  type Shape,
  unionNonZero,
  unionShapes,
  differenceShapes,
  offsetPolyline,
  shapesToRings,
} from './clip';
import { EM, BASELINE } from '../model/defaults';

// ===== 表示・出力用の派生データ（キャッシュのみ。保存はしない） =====

const strokeCache = new WeakMap<StrokeObj, Ring>();

/** 手書き線の外形（ローカル座標）。perfect-freehand で計算 */
export function strokeOutline(o: StrokeObj): Ring {
  const hit = strokeCache.get(o);
  if (hit) return hit;
  const pen = o.pen;
  const pts = o.points.map(([x, y, p]) => [x, y, pen.usePressure ? p : 0.5]);
  const raw = getStroke(pts, {
    size: pen.size,
    thinning: pen.usePressure ? pen.thinning : 0,
    smoothing: pen.smoothing,
    streamline: pen.streamline,
    simulatePressure: false,
    start: { taper: pen.taperStart > 0 ? pen.taperStart : false, cap: true },
    end: { taper: pen.taperEnd > 0 ? pen.taperEnd : false, cap: true },
    last: true,
  });
  const ring: Ring = raw.map(([x, y]) => ({ x, y }));
  strokeCache.set(o, ring);
  return ring;
}

const flatCache = new WeakMap<PathObj, Vec[]>();
export function pathFlat(o: PathObj): Vec[] {
  const hit = flatCache.get(o);
  if (hit) return hit;
  const pts = flattenPath(o.nodes, o.closed, 1);
  flatCache.set(o, pts);
  return pts;
}

/** 1 オブジェクトの「塗り領域」を正規化済み図形にする（ローカル座標、向き揃え済み） */
const objShapeCache = new WeakMap<Obj, Shape[]>();
export function objLocalShapes(o: StrokeObj | PathObj): Shape[] {
  const hit = objShapeCache.get(o);
  if (hit) return hit;
  let res: Shape[] = [];
  if (o.type === 'stroke') {
    const ring = strokeOutline(o);
    res = ring.length >= 3 ? unionNonZero([ring]) : [];
  } else {
    const groups: Shape[][] = [];
    const flat = pathFlat(o);
    if (o.closed && o.fill && flat.length >= 3) groups.push(unionNonZero([flat]));
    if (o.strokeWidth > 0 && flat.length >= 1) groups.push(offsetPolyline(flat, o.strokeWidth, o.closed));
    res = groups.length === 1 ? groups[0] : unionShapes(groups);
  }
  objShapeCache.set(o, res);
  return res;
}

export function transformRing(r: Ring, m: Mat): Ring {
  return r.map((p) => apply(m, p.x, p.y));
}
export function transformShapes(shapes: Shape[], m: Mat): Shape[] {
  return shapes.map((s) => ({ outer: transformRing(s.outer, m), holes: s.holes.map((h) => transformRing(h, m)) }));
}

/** 平坦化したオブジェクト列（グループ展開、変換適用済み） */
export function flattenObjects(objs: Obj[], parent: Mat = I): { obj: StrokeObj | PathObj; mat: Mat }[] {
  const out: { obj: StrokeObj | PathObj; mat: Mat }[] = [];
  for (const o of objs) {
    if (o.hidden) continue;
    const m = mul(parent, o.transform);
    if (o.type === 'group') out.push(...flattenObjects(o.children, m));
    else if (o.type === 'stroke' || o.type === 'path') out.push({ obj: o, mat: m });
  }
  return out;
}

/** オブジェクト列を一つの単色輪郭に合成（部分消しゴムは順番どおりに削る） */
export function composeInk(objs: Obj[]): Shape[] {
  let acc: Shape[] = [];
  let pending: Shape[][] = [];
  const flush = () => {
    if (pending.length) {
      acc = unionShapes([acc, ...pending]);
      pending = [];
    }
  };
  for (const { obj, mat } of flattenObjects(objs)) {
    const shapes = transformShapes(objLocalShapes(obj), mat);
    if (obj.type === 'stroke' && obj.erase) {
      flush();
      acc = differenceShapes(acc, shapes);
    } else {
      pending.push(shapes);
    }
  }
  flush();
  return acc;
}

/** 字形メトリクスを適用する行列（編集 em 座標 → 送り幅原点の em 座標） */
export function glyphPlacement(g: Glyph, bboxX?: { min: number; max: number }): { mat: Mat; advance: number } {
  const m = g.metrics;
  let mat = mul(translate(m.offsetX, m.offsetY), about(scaleM(m.scale), EM / 2, BASELINE));
  let advance = m.advance;
  if (m.autoAdvance) {
    if (bboxX && isFinite(bboxX.min)) {
      const minX = bboxX.min * m.scale + (1 - m.scale) * (EM / 2) + m.offsetX;
      const maxX = bboxX.max * m.scale + (1 - m.scale) * (EM / 2) + m.offsetX;
      mat = mul(translate(m.sideBearing - minX, 0), mat);
      advance = Math.max(1, Math.round(maxX - minX + m.sideBearing * 2));
    } else {
      advance = Math.max(1, Math.round(m.advance));
    }
  }
  return { mat, advance: Math.round(advance) };
}

export interface GlyphOutline {
  /** 送り幅原点・Y 下向き・ベースライン=BASELINE の em 座標 */
  shapes: Shape[];
  advance: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  empty: boolean;
}

const glyphCache = new WeakMap<Glyph, GlyphOutline>();

export function glyphOutline(g: Glyph): GlyphOutline {
  const hit = glyphCache.get(g);
  if (hit) return hit;
  const ink = composeInk(g.objects);
  const raw = ringsBBox(shapesToRings(ink));
  const { mat, advance } = glyphPlacement(g, raw ? { min: raw.minX, max: raw.maxX } : undefined);
  const shapes = transformShapes(ink, mat);
  const bbox = ringsBBox(shapesToRings(shapes));
  const res: GlyphOutline = { shapes, advance, bbox, empty: shapes.length === 0 };
  glyphCache.set(g, res);
  return res;
}

export function ringsBBox(rings: Ring[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function shapesToPath2D(shapes: Shape[]): Path2D {
  const p = new Path2D();
  for (const r of shapesToRings(shapes)) {
    if (r.length < 3) continue;
    p.moveTo(r[0].x, r[0].y);
    for (let i = 1; i < r.length; i++) p.lineTo(r[i].x, r[i].y);
    p.closePath();
  }
  return p;
}

export function ringToPath2D(r: Ring): Path2D {
  const p = new Path2D();
  if (r.length < 2) return p;
  p.moveTo(r[0].x, r[0].y);
  for (let i = 1; i < r.length; i++) p.lineTo(r[i].x, r[i].y);
  p.closePath();
  return p;
}

export function shapesToSvgD(shapes: Shape[], prec = 2): string {
  const f = (v: number) => +v.toFixed(prec);
  let d = '';
  for (const r of shapesToRings(shapes)) {
    if (r.length < 3) continue;
    d += `M${f(r[0].x)} ${f(r[0].y)}`;
    for (let i = 1; i < r.length; i++) d += `L${f(r[i].x)} ${f(r[i].y)}`;
    d += 'Z';
  }
  return d;
}

export function ringToSvgD(r: Ring, prec = 2): string {
  if (r.length < 3) return '';
  const f = (v: number) => +v.toFixed(prec);
  let d = `M${f(r[0].x)} ${f(r[0].y)}`;
  for (let i = 1; i < r.length; i++) d += `L${f(r[i].x)} ${f(r[i].y)}`;
  return d + 'Z';
}
