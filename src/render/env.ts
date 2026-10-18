import type { Glyph, Logo } from '../model/types';

/** 代用表示に使うフォント（端末にインストール済みのものを使う。フォントファイルは同梱しない） */
export const FALLBACK_FONT =
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP","Yu Gothic","Meiryo",system-ui,sans-serif';

export interface RenderEnv {
  glyphs: Record<string, Glyph>;
  logos: Logo[];
  /** 代用文字の幅（フォントサイズ 1000 のときの幅） */
  measure: (ch: string) => number;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

export function browserMeasure(ch: string): number {
  const hit = widthCache.get(ch);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) {
    try {
      const c = document.createElement('canvas');
      measureCtx = c.getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  let w: number;
  if (measureCtx) {
    measureCtx.font = `1000px ${FALLBACK_FONT}`;
    w = measureCtx.measureText(ch).width;
  } else {
    w = fallbackWidth(ch);
  }
  widthCache.set(ch, w);
  return w;
}

export function fallbackWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x2000 ? 1000 : 600;
}

export function makeEnv(glyphs: Record<string, Glyph>, logos: Logo[], measure = browserMeasure): RenderEnv {
  return { glyphs, logos, measure };
}
