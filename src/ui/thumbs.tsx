import { useEffect, useRef } from 'react';
import type { Glyph, Obj } from '../model/types';
import { glyphOutline, shapesToPath2D } from '../geom/outline';
import { objectsBox, boxValid } from '../geom/bounds';
import { renderInk, renderStyled } from '../render/canvas';
import type { RenderEnv } from '../render/env';
import { INK } from '../model/defaults';

const pathCache = new WeakMap<object, Path2D>();

export function GlyphThumb({ glyph, size = 52 }: { glyph: Glyph; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    const ol = glyphOutline(glyph);
    if (ol.empty) return;
    let p = pathCache.get(ol);
    if (!p) {
      p = shapesToPath2D(ol.shapes);
      pathCache.set(ol, p);
    }
    // 送り幅の中央と em の中央を合わせる
    const k = (size * dpr) / 1150;
    ctx.setTransform(k, 0, 0, k, (size * dpr) / 2 - (ol.advance / 2) * k, 75 * k);
    ctx.fillStyle = INK;
    ctx.fill(p);
  }, [glyph, size]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}

export function ObjectsThumb({ objects, env, size = 84, ink }: { objects: Obj[]; env: RenderEnv; size?: number; ink?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = size * dpr;
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const b = objectsBox(objects, env);
    if (!boxValid(b)) return;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const k = (S * 0.82) / Math.max(w, h);
    const view: [number, number, number, number, number, number] = [k, 0, 0, k, S / 2 - ((b.minX + b.maxX) / 2) * k, S / 2 - ((b.minY + b.maxY) / 2) * k];
    const styled = !ink && objects.some((o) => !!o.style);
    if (styled) renderStyled(ctx, objects, view, env, {});
    else renderInk(ctx, objects, view, INK);
  }, [objects, env, size, ink]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%' }} />;
}
