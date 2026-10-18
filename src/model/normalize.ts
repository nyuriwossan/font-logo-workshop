import type { Obj, Project, Part, Style, Mat, PathNode, Glyph, Logo, Composite, CharAdjust, Paint } from './types';
import { defaultPen, defaultStyle, defaultMetrics, newProject } from './defaults';
import { uid } from './ids';

// 読み込み・復元時の検証。壊れた部分は捨て、読める部分は残す（全体を失わない）

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function mat(v: unknown): Mat {
  if (Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v as Mat;
  return [1, 0, 0, 1, 0, 0];
}

function paint(v: unknown, d: Paint): Paint {
  if (!isObj(v)) return d;
  if (v.kind === 'linear') return { kind: 'linear', from: str(v.from, '#2b3550'), to: str(v.to, '#7a6ee0'), angle: num(v.angle, 90) };
  return { kind: 'solid', color: str(v.color, d.kind === 'solid' ? d.color : '#2b3550') };
}

function style(v: unknown): Style | undefined {
  if (!isObj(v)) return undefined;
  const d = defaultStyle();
  return {
    fill: paint(v.fill, d.fill),
    outline: isObj(v.outline)
      ? { on: bool(v.outline.on, false), color: str(v.outline.color, d.outline.color), width: num(v.outline.width, d.outline.width) }
      : d.outline,
    shadow: isObj(v.shadow)
      ? {
          on: bool(v.shadow.on, false),
          color: str(v.shadow.color, d.shadow.color),
          blur: num(v.shadow.blur, d.shadow.blur),
          dx: num(v.shadow.dx, d.shadow.dx),
          dy: num(v.shadow.dy, d.shadow.dy),
        }
      : d.shadow,
    opacity: Math.max(0, Math.min(1, num(v.opacity, 1))),
  };
}

function vec(v: unknown) {
  return isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x as number, y: v.y as number } : undefined;
}

export function normalizeObj(v: unknown, depth = 0): Obj | null {
  if (!isObj(v) || depth > 20) return null;
  const base = {
    id: str(v.id, uid()),
    transform: mat(v.transform),
    style: style(v.style),
    name: typeof v.name === 'string' ? v.name : undefined,
    hidden: v.hidden === true ? true : undefined,
    locked: v.locked === true ? true : undefined,
  };
  if (!base.style) delete base.style;
  if (!base.name) delete base.name;
  if (!base.hidden) delete base.hidden;
  if (!base.locked) delete base.locked;
  switch (v.type) {
    case 'stroke': {
      if (!Array.isArray(v.points)) return null;
      const points = v.points
        .filter((p: unknown) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map((p: number[]) => [p[0], p[1], num(p[2], 0.5)] as [number, number, number]);
      if (points.length === 0) return null;
      const dp = defaultPen();
      const pen = isObj(v.pen) ? v.pen : {};
      return {
        ...base,
        type: 'stroke',
        points,
        pen: {
          size: num(pen.size, dp.size),
          thinning: num(pen.thinning, dp.thinning),
          smoothing: num(pen.smoothing, dp.smoothing),
          streamline: num(pen.streamline, dp.streamline),
          taperStart: num(pen.taperStart, 0),
          taperEnd: num(pen.taperEnd, 0),
          usePressure: bool(pen.usePressure, true),
        },
        ...(v.erase === true ? { erase: true } : {}),
      };
    }
    case 'path': {
      if (!Array.isArray(v.nodes)) return null;
      const nodes: PathNode[] = [];
      for (const n of v.nodes) {
        if (!isObj(n) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const node: PathNode = { x: n.x, y: n.y };
        const hin = vec(n.hin);
        const hout = vec(n.hout);
        if (hin) node.hin = hin;
        if (hout) node.hout = hout;
        nodes.push(node);
      }
      if (nodes.length === 0) return null;
      const shape = ['line', 'curve', 'rect', 'ellipse', 'polygon'].includes(v.shape) ? v.shape : undefined;
      return {
        ...base,
        type: 'path',
        nodes,
        closed: bool(v.closed, false),
        fill: bool(v.fill, false),
        strokeWidth: Math.max(0, num(v.strokeWidth, 0)),
        ...(shape ? { shape } : {}),
      };
    }
    case 'group': {
      const children = Array.isArray(v.children) ? v.children.map((c: unknown) => normalizeObj(c, depth + 1)).filter(Boolean) : [];
      if (children.length === 0) return null;
      return { ...base, type: 'group', children: children as Obj[] };
    }
    case 'text': {
      const charAdj: Record<string, CharAdjust> = {};
      if (isObj(v.charAdj))
        for (const [k, a] of Object.entries(v.charAdj)) {
          if (!isObj(a)) continue;
          charAdj[k] = { dx: num(a.dx, 0), dy: num(a.dy, 0), rot: num(a.rot, 0), scale: num(a.scale, 1) || 1 };
        }
      return {
        ...base,
        type: 'text',
        text: str(v.text, ''),
        fontSize: Math.max(1, num(v.fontSize, 160)),
        letterSpacing: num(v.letterSpacing, 0),
        lineHeight: num(v.lineHeight, 1.2),
        vertical: bool(v.vertical, false),
        charAdj,
      };
    }
    case 'logoRef':
      if (typeof v.logoId !== 'string') return null;
      return { ...base, type: 'logoRef', logoId: v.logoId };
    default:
      return null;
  }
}

function objs(v: unknown): Obj[] {
  return Array.isArray(v) ? (v.map((o) => normalizeObj(o)).filter(Boolean) as Obj[]) : [];
}

export function normalizeProject(v: unknown): Project {
  if (!isObj(v)) throw new Error('プロジェクトのデータ形式が正しくありません');
  const d = newProject();
  const glyphs: Record<string, Glyph> = {};
  if (isObj(v.glyphs))
    for (const [k, g] of Object.entries(v.glyphs)) {
      const cp = Number(k);
      if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || !isObj(g)) continue;
      const dm = defaultMetrics(cp);
      const m = isObj(g.metrics) ? g.metrics : {};
      glyphs[String(cp)] = {
        cp,
        objects: objs(g.objects),
        metrics: {
          scale: num(m.scale, 1) || 1,
          offsetX: num(m.offsetX, 0),
          offsetY: num(m.offsetY, 0),
          advance: Math.max(0, num(m.advance, dm.advance)),
          autoAdvance: bool(m.autoAdvance, dm.autoAdvance),
          sideBearing: num(m.sideBearing, dm.sideBearing),
        },
        updatedAt: num(g.updatedAt, Date.now()),
      };
    }
  const logos: Logo[] = Array.isArray(v.logos)
    ? v.logos.filter(isObj).map((l) => ({
        id: str(l.id, uid('logo')),
        name: str(l.name, 'ロゴ'),
        width: Math.max(16, num(l.width, 1600)),
        height: Math.max(16, num(l.height, 900)),
        objects: objs(l.objects),
        updatedAt: num(l.updatedAt, Date.now()),
      }))
    : [];
  const composites: Composite[] = Array.isArray(v.composites)
    ? v.composites.filter(isObj).map((c) => ({
        id: str(c.id, uid('cmp')),
        name: str(c.name, '合成'),
        assetId: typeof c.assetId === 'string' ? c.assetId : null,
        width: Math.max(16, num(c.width, 1600)),
        height: Math.max(16, num(c.height, 1200)),
        objects: objs(c.objects),
        updatedAt: num(c.updatedAt, Date.now()),
      }))
    : [];
  const f = isObj(v.font) ? v.font : {};
  return {
    id: str(v.id, uid('prj')),
    name: str(v.name, d.name),
    schema: 1,
    createdAt: num(v.createdAt, Date.now()),
    updatedAt: num(v.updatedAt, Date.now()),
    font: {
      displayName: str(f.displayName, d.font.displayName),
      familyName: str(f.familyName, d.font.familyName),
      styleName: str(f.styleName, 'Regular'),
      designer: str(f.designer, ''),
    },
    glyphs,
    customChars: Array.isArray(v.customChars) ? v.customChars.filter((c: unknown) => typeof c === 'string' && Array.from(c as string).length === 1) : [],
    logos,
    composites,
  };
}

export function normalizePart(v: unknown): Part | null {
  if (!isObj(v)) return null;
  const objects = objs(v.objects);
  if (objects.length === 0) return null;
  return {
    id: str(v.id, uid('part')),
    name: str(v.name, 'パーツ'),
    category: str(v.category, '未分類'),
    objects,
    ...(isObj(v.origin) && Number.isFinite(v.origin.x) && Number.isFinite(v.origin.y) && ['glyph', 'logo', 'composite', 'part'].includes(v.origin.kind)
      ? { origin: { x: v.origin.x, y: v.origin.y, kind: v.origin.kind } }
      : {}),
    createdAt: num(v.createdAt, Date.now()),
    updatedAt: num(v.updatedAt, Date.now()),
  };
}

/** オブジェクトを深くコピーし、ID を振り直す（貼り付けたパーツを元データから独立させる） */
export function cloneWithNewIds(list: Obj[]): Obj[] {
  return list.map((o) => {
    const c = structuredClone(o) as Obj;
    const reid = (x: Obj) => {
      x.id = uid();
      if (x.type === 'group') x.children.forEach(reid);
    };
    reid(c);
    return c;
  });
}
