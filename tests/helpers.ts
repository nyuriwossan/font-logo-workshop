import type { StrokeObj, PathObj, Obj, Project } from '../src/model/types';
import { defaultPen, newProject, newGlyph } from '../src/model/defaults';
import { makeShapeNodes } from '../src/geom/path';

let n = 0;
export function stroke(points: [number, number][], size = 60, extra: Partial<StrokeObj> = {}): StrokeObj {
  // 点を細かく補間（実際の手書き入力に近づける）
  const pts: [number, number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
    for (let k = 0; k < steps; k++) pts.push([x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps, 0.5]);
  }
  pts.push([...points[points.length - 1], 0.5]);
  return { id: `s${++n}`, type: 'stroke', transform: [1, 0, 0, 1, 0, 0], points: pts, pen: { ...defaultPen(), size, usePressure: false }, ...extra };
}

export function shape(kind: 'rect' | 'ellipse' | 'line', a: [number, number], b: [number, number], fill = true, strokeWidth = 0): PathObj {
  const { nodes, closed } = makeShapeNodes(kind, { x: a[0], y: a[1] }, { x: b[0], y: b[1] });
  return { id: `p${++n}`, type: 'path', transform: [1, 0, 0, 1, 0, 0], nodes, closed, fill: closed && fill, strokeWidth, shape: kind };
}

/** 「A」「B」を作ったプロジェクト */
export function projectAB(): Project {
  const p = newProject('テスト');
  const A = newGlyph(65);
  A.objects = [
    stroke([
      [120, 860],
      [300, 180],
    ]),
    stroke([
      [300, 180],
      [480, 860],
    ]),
    stroke([
      [190, 600],
      [410, 600],
    ]),
  ];
  const B = newGlyph(66);
  B.objects = [
    shape('rect', [120, 180], [200, 860]),
    shape('ellipse', [140, 180], [470, 520], false, 70),
    shape('ellipse', [140, 500], [500, 860], false, 70),
  ];
  p.glyphs['65'] = A;
  p.glyphs['66'] = B;
  return p;
}

export function objIds(objs: Obj[]): string[] {
  return objs.map((o) => o.id);
}
