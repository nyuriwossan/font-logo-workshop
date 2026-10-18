import type { Obj, Part, Mat, PathObj, StrokeObj, Glyph, Logo, Route } from '../model/types';
import { useStore, commitDoc, commit, setUi, toast, docOf, type Data } from '../store/store';
import { objBox, objectsBox, boxValid, type BBox } from '../geom/bounds';
import { mul, translate, about, scale as scaleM, invert, I } from '../geom/matrix';
import { cloneWithNewIds } from '../model/normalize';
import { uid } from '../model/ids';
import { makeEnv, type RenderEnv } from '../render/env';
import { polylineToNodes } from '../geom/path';
import { apply } from '../geom/matrix';

let envCache: { glyphs: Record<string, Glyph>; logos: Logo[]; env: RenderEnv } | null = null;
export function envOf(data: Data): RenderEnv {
  const { glyphs, logos } = data.project;
  if (envCache && envCache.glyphs === glyphs && envCache.logos === logos) return envCache.env;
  const env = makeEnv(glyphs, logos);
  envCache = { glyphs, logos, env };
  return env;
}

export function currentDoc() {
  const s = useStore.getState();
  return docOf(s.data, s.route);
}

export function selectedObjs(): Obj[] {
  const s = useStore.getState();
  const doc = docOf(s.data, s.route);
  if (!doc) return [];
  const ids = new Set(s.ui.selection);
  return doc.objects.filter((o) => ids.has(o.id));
}

export function selectionBox(): BBox | null {
  const s = useStore.getState();
  if (!s.data) return null;
  const b = objectsBox(selectedObjs(), envOf(s.data));
  return boxValid(b) ? b : null;
}

export function select(ids: string[]) {
  setUi({ selection: ids, charEdit: null });
}

export function deleteSelection() {
  const ids = new Set(useStore.getState().ui.selection);
  if (!ids.size) return;
  commitDoc((objs) => {
    for (let i = objs.length - 1; i >= 0; i--) if (ids.has(objs[i].id)) objs.splice(i, 1);
  });
  select([]);
}

export function duplicateSelection(offset = 40) {
  const sel = selectedObjs();
  if (!sel.length) return;
  const copies = cloneWithNewIds(sel).map((o) => ({ ...o, transform: mul(translate(offset, offset), o.transform) }) as Obj);
  commitDoc((objs) => {
    objs.push(...copies);
  });
  select(copies.map((c) => c.id));
}

/** 選択範囲の中心を基準に変換を適用 */
export function transformSelection(fn: (cx: number, cy: number, box: BBox) => Mat) {
  const box = selectionBox();
  if (!box) return;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const m = fn(cx, cy, box);
  const ids = new Set(useStore.getState().ui.selection);
  commitDoc((objs) => {
    for (const o of objs) if (ids.has(o.id)) o.transform = mul(m, o.transform);
  });
}

export const flipH = () => transformSelection((cx, cy) => about(scaleM(-1, 1), cx, cy));
export const flipV = () => transformSelection((cx, cy) => about(scaleM(1, -1), cx, cy));

export function moveSelection(dx: number, dy: number) {
  transformSelection(() => translate(dx, dy));
}

export function groupSelection() {
  const s = useStore.getState();
  const ids = new Set(s.ui.selection);
  if (ids.size < 2) return;
  const gid = uid();
  commitDoc((objs) => {
    const picked: Obj[] = [];
    let at = -1;
    for (let i = 0; i < objs.length; i++)
      if (ids.has(objs[i].id)) {
        picked.push(objs[i]);
        at = i;
      }
    const insertAt = at - picked.length + 1;
    for (let i = objs.length - 1; i >= 0; i--) if (ids.has(objs[i].id)) objs.splice(i, 1);
    objs.splice(Math.max(0, insertAt), 0, { id: gid, type: 'group', transform: [...I] as Mat, children: picked });
  });
  select([gid]);
}

export function ungroupSelection() {
  const s = useStore.getState();
  const ids = new Set(s.ui.selection);
  const newIds: string[] = [];
  commitDoc((objs) => {
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (!ids.has(o.id) || o.type !== 'group') continue;
      const kids = o.children.map((c) => ({ ...c, transform: mul(o.transform, c.transform), style: c.style ?? o.style }) as Obj);
      kids.forEach((k) => {
        if (!k.style) delete k.style;
        newIds.push(k.id);
      });
      objs.splice(i, 1, ...kids);
    }
  });
  if (newIds.length) select(newIds);
}

export function reorderSelection(dir: 'up' | 'down' | 'top' | 'bottom') {
  const ids = new Set(useStore.getState().ui.selection);
  commitDoc((objs) => {
    const picked = objs.filter((o) => ids.has(o.id));
    if (!picked.length) return;
    if (dir === 'top' || dir === 'bottom') {
      const rest = objs.filter((o) => !ids.has(o.id));
      const arr = dir === 'top' ? [...rest, ...picked] : [...picked, ...rest];
      objs.splice(0, objs.length, ...arr);
      return;
    }
    if (dir === 'up') {
      for (let i = objs.length - 2; i >= 0; i--)
        if (ids.has(objs[i].id) && !ids.has(objs[i + 1].id)) [objs[i], objs[i + 1]] = [objs[i + 1], objs[i]];
    } else {
      for (let i = 1; i < objs.length; i++) if (ids.has(objs[i].id) && !ids.has(objs[i - 1].id)) [objs[i], objs[i - 1]] = [objs[i - 1], objs[i]];
    }
  });
}

export function moveObject(id: string, dir: 'up' | 'down') {
  commitDoc((objs) => {
    const i = objs.findIndex((o) => o.id === id);
    const j = dir === 'up' ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= objs.length) return;
    [objs[i], objs[j]] = [objs[j], objs[i]];
  });
}

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** 1 つ選択時は文字枠（アートボード）に、複数選択時は選択範囲に揃える */
export function alignSelection(kind: AlignKind) {
  const s = useStore.getState();
  if (!s.data) return;
  const doc = docOf(s.data, s.route);
  if (!doc) return;
  const env = envOf(s.data);
  const sel = selectedObjs();
  if (!sel.length) return;
  const ref: BBox =
    sel.length === 1
      ? { minX: doc.frame.x, minY: doc.frame.y, maxX: doc.frame.x + doc.frame.w, maxY: doc.frame.y + doc.frame.h }
      : objectsBox(sel, env);
  const moves = new Map<string, [number, number]>();
  for (const o of sel) {
    const b = objBox(o, env);
    if (!boxValid(b)) continue;
    let dx = 0,
      dy = 0;
    if (kind === 'left') dx = ref.minX - b.minX;
    if (kind === 'right') dx = ref.maxX - b.maxX;
    if (kind === 'hcenter') dx = (ref.minX + ref.maxX) / 2 - (b.minX + b.maxX) / 2;
    if (kind === 'top') dy = ref.minY - b.minY;
    if (kind === 'bottom') dy = ref.maxY - b.maxY;
    if (kind === 'vcenter') dy = (ref.minY + ref.maxY) / 2 - (b.minY + b.maxY) / 2;
    moves.set(o.id, [dx, dy]);
  }
  commitDoc((objs) => {
    for (const o of objs) {
      const mv = moves.get(o.id);
      if (mv) o.transform = mul(translate(mv[0], mv[1]), o.transform);
    }
  });
}

/** 選択中の手書き線を、制御点で編集できる曲線に変換 */
export function convertStrokesToCurves() {
  const ids = new Set(useStore.getState().ui.selection);
  const newIds: string[] = [];
  commitDoc((objs) => {
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!ids.has(o.id) || o.type !== 'stroke' || o.erase) continue;
      const pts = (o as StrokeObj).points.map(([x, y]) => ({ x, y }));
      const nodes = polylineToNodes(pts, Math.max(2, o.pen.size * 0.08));
      const p: PathObj = {
        id: uid(),
        type: 'path',
        transform: o.transform,
        nodes,
        closed: false,
        fill: false,
        strokeWidth: o.pen.size,
        shape: 'curve',
        ...(o.style ? { style: o.style } : {}),
      };
      objs[i] = p;
      newIds.push(p.id);
    }
  });
  if (newIds.length) {
    select(newIds);
    toast('曲線に変換しました。「制御点」ツールで形を直せます');
  }
}

// ===== パーツ =====

export function registerPart(name: string, category: string) {
  const s = useStore.getState();
  const sel = selectedObjs();
  const box = selectionBox();
  if (!sel.length || !box || !s.data) return null;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const objects = cloneWithNewIds(sel).map((o) => ({ ...o, transform: mul(translate(-cx, -cy), o.transform) }) as Obj);
  const part: Part = {
    id: uid('part'),
    name: name.trim() || 'パーツ',
    category: category.trim() || '未分類',
    objects,
    origin: { x: cx, y: cy, kind: s.route.screen },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  commit((d) => {
    d.parts.push(part as any);
  });
  toast(`パーツ「${part.name}」を登録しました`);
  return part;
}

/** パーツを現在の編集対象へ挿入（深いコピー＝元パーツから独立） */
export function insertPart(part: Part, at?: { x: number; y: number }) {
  const s = useStore.getState();
  const doc = docOf(s.data, s.route);
  if (!doc) return;
  let pos = at;
  if (!pos) {
    // 同じ種類の画面（文字→文字、ロゴ→ロゴ）なら登録した位置に、それ以外は中央に置く
    if (part.origin && part.origin.kind === s.route.screen) pos = { x: part.origin.x, y: part.origin.y };
    else pos = { x: doc.frame.x + doc.frame.w / 2, y: doc.frame.y + doc.frame.h / 2 };
  }
  const copies = cloneWithNewIds(part.objects).map((o) => ({ ...o, transform: mul(translate(pos!.x, pos!.y), o.transform) }) as Obj);
  commitDoc((objs) => {
    objs.push(...copies);
  });
  setUi({ selection: copies.map((c) => c.id), tool: 'select', charEdit: null });
}

export function screenRouteLabel(r: Route) {
  return r.screen;
}

export function docPointToLocal(o: Obj, p: { x: number; y: number }) {
  return apply(invert(o.transform), p.x, p.y);
}
