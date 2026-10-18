import type { Mat, TextObj } from '../model/types';
import { EM } from '../model/defaults';
import { glyphOutline, type GlyphOutline } from '../geom/outline';
import { mul, translate, scale as scaleM, rotate, about, apply } from '../geom/matrix';
import type { RenderEnv } from './env';

export interface LaidChar {
  /** text 文字列（Array.from 後）のインデックス */
  index: number;
  ch: string;
  /** 自作字形（なければ代用表示） */
  outline: GlyphOutline | null;
  /** 文字ローカル（em 座標・Y 下向き）→ テキストローカル */
  mat: Mat;
  /** 調整前のセル（テキストローカル） */
  cell: { x: number; y: number; w: number; h: number };
  /** em 単位での送り幅 */
  advanceEm: number;
}

export interface TextLayout {
  chars: LaidChar[];
  bbox: { x: number; y: number; w: number; h: number };
}

const ROTATE_IN_VERTICAL = new Set(Array.from('ー〜～…‥－-—―_()（）「」『』【】〔〕［］[]{}｛｝<>〈〉《》=＝→←'));
const SHIFT_IN_VERTICAL = new Set(Array.from('、。，．,.'));

const layoutCache = new WeakMap<TextObj, { env: RenderEnv; glyphs: unknown; layout: TextLayout }>();

export function isCustomChar(ch: string, env: RenderEnv): boolean {
  const g = env.glyphs[String(ch.codePointAt(0))];
  return !!g && !glyphOutline(g).empty;
}

export function layoutText(t: TextObj, env: RenderEnv): TextLayout {
  const hit = layoutCache.get(t);
  if (hit && hit.env === env && hit.glyphs === env.glyphs) return hit.layout;
  const layout = computeLayout(t, env);
  layoutCache.set(t, { env, glyphs: env.glyphs, layout });
  return layout;
}

function computeLayout(t: TextObj, env: RenderEnv): TextLayout {
  const s = t.fontSize / EM;
  const chars: LaidChar[] = [];
  const all = Array.from(t.text);
  const lineStep = t.fontSize * Math.max(0.3, t.lineHeight);
  let line = 0;
  let pen = 0;
  // 縦書きは列数が必要
  const lineCount = all.filter((c) => c === '\n').length + 1;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  all.forEach((ch, index) => {
    if (ch === '\n') {
      line++;
      pen = 0;
      return;
    }
    const g = env.glyphs[String(ch.codePointAt(0))];
    const ol = g ? glyphOutline(g) : null;
    const outline = ol && !ol.empty ? ol : null;
    let advanceEm: number;
    if (outline) advanceEm = outline.advance;
    else if (ch === ' ') advanceEm = 300;
    else if (ch === '　') advanceEm = 1000;
    else advanceEm = env.measure(ch);

    let cell: { x: number; y: number; w: number; h: number };
    let base: Mat;
    if (!t.vertical) {
      cell = { x: pen, y: line * lineStep, w: advanceEm * s, h: t.fontSize };
      base = mul(translate(cell.x, cell.y), scaleM(s));
      pen += advanceEm * s + t.letterSpacing;
    } else {
      const colW = lineStep;
      const colCenter = (lineCount - 1 - line) * colW + t.fontSize / 2;
      cell = { x: colCenter - t.fontSize / 2, y: pen, w: t.fontSize, h: t.fontSize };
      // em ボックスの中央に字形の送り幅の中央を合わせる
      let m: Mat = mul(translate(colCenter - (advanceEm * s) / 2, cell.y), scaleM(s));
      if (ROTATE_IN_VERTICAL.has(ch)) {
        // 字形の中心で 90° 回転
        m = mul(translate(colCenter, cell.y + t.fontSize / 2), mul(rotate(Math.PI / 2), mul(scaleM(s), translate(-advanceEm / 2, -EM / 2))));
      } else if (SHIFT_IN_VERTICAL.has(ch)) {
        m = mul(translate(t.fontSize * 0.55, -t.fontSize * 0.55), m);
      }
      base = m;
      pen += t.fontSize + t.letterSpacing;
    }
    const adj = t.charAdj[String(index)];
    let mat = base;
    if (adj) {
      const cx = cell.x + cell.w / 2;
      const cy = cell.y + cell.h / 2;
      const a = mul(translate(adj.dx, adj.dy), about(mul(rotate((adj.rot * Math.PI) / 180), scaleM(adj.scale || 1)), cx, cy));
      mat = mul(a, base);
    }
    // 調整後のセル角で bbox を広げる
    const inv = mul(mat, scaleM(1 / s));
    const corners = [apply(inv, 0, 0), apply(inv, advanceEm * s, 0), apply(inv, 0, t.fontSize), apply(inv, advanceEm * s, t.fontSize)];
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    chars.push({ index, ch, outline, mat, cell, advanceEm });
  });
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = t.fontSize;
    maxY = t.fontSize;
  }
  return { chars, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}
