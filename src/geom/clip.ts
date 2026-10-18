import * as CL from 'clipper-lib';
// CommonJS モジュールのため、バンドラによって default に入る場合がある
const ClipperLib: typeof CL = ((CL as any).default ?? CL) as typeof CL;
import type { Vec } from '../model/types';

/** 輪郭（閉じた多角形）。始点を末尾に繰り返さない */
export type Ring = Vec[];

/** 外側輪郭と穴 */
export interface Shape {
  outer: Ring;
  holes: Ring[];
}

const S = 100; // 0.01 単位の精度で整数化

type CPath = { X: number; Y: number }[];

function toC(r: Ring): CPath {
  const out: CPath = new Array(r.length);
  for (let i = 0; i < r.length; i++) out[i] = { X: Math.round(r[i].x * S), Y: Math.round(r[i].y * S) };
  return out;
}
function fromC(p: CPath): Ring {
  const out: Ring = new Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = { x: p[i].X / S, y: p[i].Y / S };
  return out;
}

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x - r[i].x) * (r[j].y + r[i].y);
  return a / 2;
}

function treeToShapes(tree: any): Shape[] {
  const shapes: Shape[] = [];
  const visit = (node: any) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) continue;
      const outer = fromC(child.Contour());
      const holes: Ring[] = [];
      for (const h of child.Childs()) {
        holes.push(fromC(h.Contour()));
        visit(h); // 穴の中の島
      }
      if (outer.length >= 3) shapes.push({ outer, holes: holes.filter((h) => h.length >= 3) });
    }
  };
  visit(tree);
  return shapes;
}

function clean(paths: CPath[]): CPath[] {
  return paths.filter((p) => p.length >= 3);
}

/** 非ゼロ規則で輪郭群を合体（自己交差・重なりを解消） */
export function unionNonZero(rings: Ring[]): Shape[] {
  const subj = clean(rings.map(toC));
  if (subj.length === 0) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return treeToShapes(tree);
}

export function shapesToRings(shapes: Shape[]): Ring[] {
  const out: Ring[] = [];
  for (const s of shapes) {
    out.push(s.outer);
    out.push(...s.holes);
  }
  return out;
}

/** 正規化済み（向きの揃った）図形同士の合体 */
export function unionShapes(groups: Shape[][]): Shape[] {
  const c = new ClipperLib.Clipper();
  let any = false;
  for (const g of groups) {
    const paths = clean(shapesToRings(g).map(toC));
    if (paths.length) {
      c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
      any = true;
    }
  }
  if (!any) return [];
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return treeToShapes(tree);
}

export function differenceShapes(subject: Shape[], clip: Shape[]): Shape[] {
  if (subject.length === 0) return [];
  if (clip.length === 0) return subject;
  const c = new ClipperLib.Clipper();
  c.AddPaths(clean(shapesToRings(subject).map(toC)), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clean(shapesToRings(clip).map(toC)), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return treeToShapes(tree);
}

/** 折れ線を幅 width の丸端・丸結合の輪郭にする */
export function offsetPolyline(pts: Vec[], width: number, closed: boolean): Shape[] {
  if (pts.length === 0 || width <= 0) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.15 * S);
  const path = toC(pts);
  if (path.length === 1) path.push({ X: path[0].X + 1, Y: path[0].Y });
  co.AddPath(
    path,
    ClipperLib.JoinType.jtRound,
    closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound,
  );
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, (width / 2) * S);
  return treeToShapes(tree);
}

/** 輪郭の頂点を間引く（フォントの容量削減） */
export function simplifyRing(r: Ring, eps = 0.35): Ring {
  if (r.length < 8) return r;
  const out: Ring = [];
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const prev = out.length ? out[out.length - 1] : r[n - 1];
    const cur = r[i];
    const next = r[(i + 1) % n];
    // prev→next の直線からの距離が小さい点は省く
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    const d = len < 1e-9 ? Math.hypot(cur.x - prev.x, cur.y - prev.y) : Math.abs((cur.x - prev.x) * dy - (cur.y - prev.y) * dx) / len;
    if (d > eps) out.push(cur);
  }
  return out.length >= 3 ? out : r;
}
