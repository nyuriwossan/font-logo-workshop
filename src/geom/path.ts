import type { PathNode, PathObj, Vec, ShapeKind } from '../model/types';

/** ベジェ制御点（ハンドルが無ければノード位置） */
function segment(a: PathNode, b: PathNode): [Vec, Vec, Vec, Vec, boolean] {
  const p0 = { x: a.x, y: a.y };
  const p3 = { x: b.x, y: b.y };
  const p1 = a.hout ?? p0;
  const p2 = b.hin ?? p3;
  const isLine = !a.hout && !b.hin;
  return [p0, p1, p2, p3, isLine];
}

export function segments(nodes: PathNode[], closed: boolean) {
  const out: [Vec, Vec, Vec, Vec, boolean][] = [];
  for (let i = 0; i < nodes.length - 1; i++) out.push(segment(nodes[i], nodes[i + 1]));
  if (closed && nodes.length > 2) out.push(segment(nodes[nodes.length - 1], nodes[0]));
  return out;
}

function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** パスを折れ線化（ローカル座標）。閉じたパスは最初の点を末尾に繰り返さない */
export function flattenPath(nodes: PathNode[], closed: boolean, tolerance = 2): Vec[] {
  if (nodes.length === 0) return [];
  const pts: Vec[] = [{ x: nodes[0].x, y: nodes[0].y }];
  for (const [p0, p1, p2, p3, isLine] of segments(nodes, closed)) {
    if (isLine) {
      pts.push(p3);
      continue;
    }
    const approx = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
    const n = Math.max(2, Math.min(96, Math.ceil(approx / (tolerance * 4))));
    for (let i = 1; i <= n; i++) pts.push(cubicAt(p0, p1, p2, p3, i / n));
  }
  if (closed && pts.length > 1) {
    const last = pts[pts.length - 1];
    if (dist(last, pts[0]) < 1e-6) pts.pop();
  }
  return pts;
}

/** SVG の d 属性（ローカル座標） */
export function pathToSvgD(nodes: PathNode[], closed: boolean, prec = 2): string {
  if (nodes.length === 0) return '';
  const f = (v: number) => +v.toFixed(prec);
  let d = `M${f(nodes[0].x)} ${f(nodes[0].y)}`;
  for (const [, p1, p2, p3, isLine] of segments(nodes, closed)) {
    d += isLine ? `L${f(p3.x)} ${f(p3.y)}` : `C${f(p1.x)} ${f(p1.y)} ${f(p2.x)} ${f(p2.y)} ${f(p3.x)} ${f(p3.y)}`;
  }
  if (closed) d += 'Z';
  return d;
}

export function pathToPath2D(nodes: PathNode[], closed: boolean): Path2D {
  const p = new Path2D();
  if (nodes.length === 0) return p;
  p.moveTo(nodes[0].x, nodes[0].y);
  for (const [, p1, p2, p3, isLine] of segments(nodes, closed)) {
    if (isLine) p.lineTo(p3.x, p3.y);
    else p.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  }
  if (closed) p.closePath();
  return p;
}

const K = 0.5522847498;

/** 図形ツール用のノード生成（ドラッグ範囲 a→b） */
export function makeShapeNodes(kind: ShapeKind, a: Vec, b: Vec, sides = 5): { nodes: PathNode[]; closed: boolean } {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  switch (kind) {
    case 'line':
    case 'curve':
      return { nodes: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], closed: false };
    case 'rect':
      return {
        nodes: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
        closed: true,
      };
    case 'ellipse': {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = (x1 - x0) / 2;
      const ry = (y1 - y0) / 2;
      return {
        nodes: [
          { x: cx, y: cy - ry, hin: { x: cx - rx * K, y: cy - ry }, hout: { x: cx + rx * K, y: cy - ry } },
          { x: cx + rx, y: cy, hin: { x: cx + rx, y: cy - ry * K }, hout: { x: cx + rx, y: cy + ry * K } },
          { x: cx, y: cy + ry, hin: { x: cx + rx * K, y: cy + ry }, hout: { x: cx - rx * K, y: cy + ry } },
          { x: cx - rx, y: cy, hin: { x: cx - rx, y: cy + ry * K }, hout: { x: cx - rx, y: cy - ry * K } },
        ],
        closed: true,
      };
    }
    case 'polygon': {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = (x1 - x0) / 2;
      const ry = (y1 - y0) / 2;
      const n = Math.max(3, Math.min(24, Math.round(sides)));
      const nodes: PathNode[] = [];
      for (let i = 0; i < n; i++) {
        const t = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        nodes.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
      }
      return { nodes, closed: true };
    }
  }
}

/** 折れ線（手書き線の中心線など）を Catmull-Rom 経由で編集しやすいベジェノードに変換 */
export function polylineToNodes(pts: Vec[], tolerance = 4): PathNode[] {
  const simp = simplifyRDP(pts, tolerance);
  if (simp.length < 2) return simp.map((p) => ({ x: p.x, y: p.y }));
  const nodes: PathNode[] = simp.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < simp.length; i++) {
    const prev = simp[Math.max(0, i - 1)];
    const next = simp[Math.min(simp.length - 1, i + 1)];
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    if (i > 0) nodes[i].hin = { x: simp[i].x - tx, y: simp[i].y - ty };
    if (i < simp.length - 1) nodes[i].hout = { x: simp[i].x + tx, y: simp[i].y + ty };
  }
  return nodes;
}

export function simplifyRDP(pts: Vec[], eps: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const a = pts[s];
    const b = pts[e];
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], a, b);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pathShapeLabel(o: PathObj): string {
  switch (o.shape) {
    case 'line':
      return '直線';
    case 'rect':
      return '四角形';
    case 'ellipse':
      return '円';
    case 'polygon':
      return '多角形';
    default:
      return '曲線';
  }
}
