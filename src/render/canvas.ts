import type { Mat, Obj, Paint, Style, TextObj, StrokeObj, PathObj, LogoRefObj } from '../model/types';
import { strokeOutline, ringToPath2D, shapesToPath2D } from '../geom/outline';
import { pathToPath2D } from '../geom/path';
import { mul, invert, matScale, apply } from '../geom/matrix';
import { localBox, type BBox } from '../geom/bounds';
import { layoutText } from './textLayout';
import { FALLBACK_FONT, type RenderEnv } from './env';
import { defaultStyle, BASELINE } from '../model/defaults';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const setT = (ctx: Ctx, m: Mat) => ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);

const strokePathCache = new WeakMap<StrokeObj, Path2D>();
function strokePath(o: StrokeObj): Path2D {
  let p = strokePathCache.get(o);
  if (!p) {
    p = ringToPath2D(strokeOutline(o));
    strokePathCache.set(o, p);
  }
  return p;
}
const pathPathCache = new WeakMap<PathObj, Path2D>();
function pathPath(o: PathObj): Path2D {
  let p = pathPathCache.get(o);
  if (!p) {
    p = pathToPath2D(o.nodes, o.closed);
    pathPathCache.set(o, p);
  }
  return p;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    } catch {
      /* fallthrough */
    }
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

// ============ 単色（字形）描画 ============

const inkLayers = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
function inkLayerFor(W: number, H: number) {
  const key = `${W}x${H}`;
  let c = inkLayers.get(key);
  if (!c) {
    if (inkLayers.size > 6) inkLayers.clear();
    c = makeCanvas(W, H);
    inkLayers.set(key, c);
  }
  return c;
}

/** 字形編集用：単色で順番に描画。部分消しゴムは下の線だけを削る */
export function renderInk(ctx: Ctx, objs: Obj[], view: Mat, color: string) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const hasErase = containsErase(objs);
  let target: Ctx = ctx;
  const inkLayer = hasErase ? inkLayerFor(W, H) : null;
  if (inkLayer) {
    target = inkLayer.getContext('2d') as Ctx;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, W, H);
  }
  target.save();
  target.fillStyle = color;
  target.strokeStyle = color;
  drawInkList(target, objs, view);
  target.restore();
  if (inkLayer) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(inkLayer as CanvasImageSource, 0, 0);
    ctx.restore();
  }
}

function containsErase(objs: Obj[]): boolean {
  return objs.some((o) => (o.type === 'stroke' && o.erase) || (o.type === 'group' && containsErase(o.children)));
}

function drawInkList(ctx: Ctx, objs: Obj[], parent: Mat) {
  for (const o of objs) {
    if (o.hidden) continue;
    const m = mul(parent, o.transform);
    if (o.type === 'group') {
      drawInkList(ctx, o.children, m);
      continue;
    }
    setT(ctx, m);
    if (o.type === 'stroke') {
      ctx.globalCompositeOperation = o.erase ? 'destination-out' : 'source-over';
      ctx.fill(strokePath(o));
      ctx.globalCompositeOperation = 'source-over';
    } else if (o.type === 'path') {
      const p = pathPath(o);
      if (o.closed && o.fill) ctx.fill(p);
      if (o.strokeWidth > 0) {
        ctx.lineWidth = o.strokeWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(p);
      }
    }
  }
}

/** 部分消しゴム線を「消し跡」として見える化（編集時のみ） */
export function renderEraseHints(ctx: Ctx, objs: Obj[], view: Mat, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  const walk = (list: Obj[], parent: Mat) => {
    for (const o of list) {
      if (o.hidden) continue;
      const m = mul(parent, o.transform);
      if (o.type === 'group') walk(o.children, m);
      else if (o.type === 'stroke' && o.erase) {
        setT(ctx, m);
        ctx.fill(strokePath(o));
      }
    }
  };
  walk(objs, view);
  ctx.restore();
}

// ============ 装飾つき（ロゴ・合成）描画 ============

export interface StyledOpts {
  /** 編集画面のみ：代用文字に目印を付ける */
  markFallback?: boolean;
  /** 背景画像など */
  images?: Map<string, CanvasImageSource>;
  /** 代用文字（ラスター）の描画を省く（SVG の内部用） */
  skipFallback?: boolean;
  /** 代用文字だけを描く（SVG の内部用） */
  onlyFallbackIndex?: number;
}

function paintStyle(ctx: Ctx, paint: Paint, box: BBox, localToCurrent: Mat): string | CanvasGradient {
  if (paint.kind === 'solid') return paint.color;
  // オブジェクト座標でのグラデーション端点 → 現在の描画座標へ
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const a = (paint.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const hw = (box.maxX - box.minX) / 2;
  const hh = (box.maxY - box.minY) / 2;
  const half = Math.abs(dx) * hw + Math.abs(dy) * hh || 1;
  const p0 = apply(localToCurrent, cx - dx * half, cy - dy * half);
  const p1 = apply(localToCurrent, cx + dx * half, cy + dy * half);
  const g = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
  g.addColorStop(0, paint.from);
  g.addColorStop(1, paint.to);
  return g;
}

export function gradientEndpoints(paint: Paint & { kind: 'linear' }, box: BBox) {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const a = (paint.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const hw = (box.maxX - box.minX) / 2;
  const hh = (box.maxY - box.minY) / 2;
  const half = Math.abs(dx) * hw + Math.abs(dy) * hh || 1;
  return { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half };
}

export function effectiveStyle(o: Obj, inherited?: Style): Style {
  return o.style ?? inherited ?? defaultStyle();
}

/** 装飾つきでオブジェクト列を描画 */
export function renderStyled(ctx: Ctx, objs: Obj[], view: Mat, env: RenderEnv, opts: StyledOpts = {}, inherited?: Style, depth = 0) {
  for (const o of objs) {
    if (o.hidden) continue;
    if (o.type === 'stroke' && o.erase) continue;
    drawStyledObj(ctx, o, mul(view, o.transform), env, opts, effectiveStyle(o, inherited), depth);
  }
}

let fxLayers: (HTMLCanvasElement | OffscreenCanvas)[] = [];
function getLayer(depth: number, W: number, H: number) {
  let c = fxLayers[depth];
  if (!c || c.width !== W || c.height !== H) {
    c = makeCanvas(W, H);
    fxLayers[depth] = c;
  }
  const x = c.getContext('2d') as Ctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, W, H);
  return { c, x };
}

function drawStyledObj(ctx: Ctx, o: Obj, m: Mat, env: RenderEnv, opts: StyledOpts, style: Style, depth: number) {
  const needLayer = style.shadow.on || style.opacity < 1 || (o.type === 'logoRef' && style.outline.on);
  if (needLayer && depth < 4) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const { c, x } = getLayer(depth + 1, W, H);
    const inner: Style = { ...style, shadow: { ...style.shadow, on: false }, opacity: 1 };
    drawStyledContent(x, o, m, env, opts, inner, depth + 1);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const k = matScale(m);
    if (o.type === 'logoRef' && style.outline.on) stampOutline(ctx, c, style.outline.width * k, style.outline.color);
    ctx.globalAlpha *= style.opacity;
    if (style.shadow.on) {
      ctx.shadowColor = style.shadow.color;
      ctx.shadowBlur = style.shadow.blur * k;
      ctx.shadowOffsetX = style.shadow.dx * k;
      ctx.shadowOffsetY = style.shadow.dy * k;
    }
    ctx.drawImage(c as CanvasImageSource, 0, 0);
    ctx.restore();
    return;
  }
  drawStyledContent(ctx, o, m, env, opts, style, depth);
}

/** ラスター画像の外側に縁取りを付ける（ロゴ全体の縁取り用） */
function stampOutline(ctx: Ctx, src: HTMLCanvasElement | OffscreenCanvas, r: number, color: string) {
  if (r <= 0) return;
  const W = src.width;
  const H = src.height;
  const tmp = makeCanvas(W, H);
  const t = tmp.getContext('2d') as Ctx;
  const steps = Math.max(12, Math.min(48, Math.round(r * 1.5)));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    t.drawImage(src as CanvasImageSource, Math.cos(a) * r, Math.sin(a) * r);
  }
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = color;
  t.fillRect(0, 0, W, H);
  ctx.drawImage(tmp as CanvasImageSource, 0, 0);
}

function drawStyledContent(ctx: Ctx, o: Obj, m: Mat, env: RenderEnv, opts: StyledOpts, style: Style, depth: number) {
  switch (o.type) {
    case 'group':
      for (const c of o.children) {
        if (c.hidden || (c.type === 'stroke' && c.erase)) continue;
        drawStyledObj(ctx, c, mul(m, c.transform), env, opts, effectiveStyle(c, style), depth);
      }
      return;
    case 'logoRef':
      drawLogoRef(ctx, o, m, env, opts, depth);
      return;
    case 'text':
      drawText(ctx, o, m, env, opts, style);
      return;
    case 'stroke':
    case 'path': {
      const box = localBox(o, env);
      ctx.save();
      setT(ctx, m);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const fill = paintStyle(ctx, style.fill, box, [1, 0, 0, 1, 0, 0]);
      const ow = style.outline.on ? style.outline.width : 0;
      if (o.type === 'stroke') {
        const p = strokePath(o);
        if (ow > 0) {
          ctx.strokeStyle = style.outline.color;
          ctx.lineWidth = ow * 2;
          ctx.stroke(p);
        }
        ctx.fillStyle = fill;
        ctx.fill(p);
      } else {
        const p = pathPath(o);
        const filled = o.closed && o.fill;
        if (ow > 0) {
          ctx.strokeStyle = style.outline.color;
          if (filled) {
            ctx.lineWidth = ow * 2;
            ctx.stroke(p);
          }
          if (o.strokeWidth > 0) {
            ctx.lineWidth = o.strokeWidth + ow * 2;
            ctx.stroke(p);
          }
        }
        if (filled) {
          ctx.fillStyle = fill;
          ctx.fill(p);
        }
        if (o.strokeWidth > 0) {
          ctx.strokeStyle = fill;
          ctx.lineWidth = o.strokeWidth;
          ctx.stroke(p);
        }
      }
      ctx.restore();
      return;
    }
  }
}

const charPathCache = new WeakMap<object, Path2D>();
function outlinePath(key: object, make: () => Path2D) {
  let p = charPathCache.get(key);
  if (!p) {
    p = make();
    charPathCache.set(key, p);
  }
  return p;
}

function drawText(ctx: Ctx, o: TextObj, m: Mat, env: RenderEnv, opts: StyledOpts, style: Style) {
  const layout = layoutText(o, env);
  const box = localBox(o, env);
  const ow = style.outline.on ? style.outline.width : 0;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `1000px ${FALLBACK_FONT}`;
  const pass = (kind: 'outline' | 'fill') => {
    for (const c of layout.chars) {
      const isFallback = !c.outline;
      if (isFallback && opts.skipFallback) continue;
      if (opts.onlyFallbackIndex !== undefined && c.index !== opts.onlyFallbackIndex) continue;
      const cm = mul(m, c.mat);
      setT(ctx, cm);
      const k = matScale(c.mat); // テキストローカル単位 → 文字 em 単位
      if (kind === 'outline') {
        ctx.strokeStyle = style.outline.color;
        ctx.lineWidth = (ow * 2) / k;
        if (c.outline) ctx.stroke(outlinePath(c.outline, () => shapesToPath2D(c.outline!.shapes)));
        else if (c.ch.trim()) ctx.strokeText(c.ch, 0, BASELINE);
      } else {
        const fill = paintStyle(ctx, style.fill, box, invert(c.mat));
        ctx.fillStyle = fill;
        if (c.outline) ctx.fill(outlinePath(c.outline, () => shapesToPath2D(c.outline!.shapes)));
        else if (c.ch.trim()) ctx.fillText(c.ch, 0, BASELINE);
      }
    }
  };
  if (ow > 0) pass('outline');
  pass('fill');
  if (opts.markFallback) {
    ctx.setLineDash([]);
    for (const c of layout.chars) {
      if (c.outline || !c.ch.trim()) continue;
      setT(ctx, mul(m, c.mat));
      ctx.fillStyle = 'rgba(140, 120, 220, 0.14)';
      ctx.fillRect(0, 40, c.advanceEm, 960);
      ctx.strokeStyle = 'rgba(120, 100, 210, 0.9)';
      ctx.lineWidth = 2 / Math.max(1e-6, matScale(mul(m, c.mat)));
      ctx.setLineDash([12 / Math.max(1e-6, matScale(mul(m, c.mat))), 8 / Math.max(1e-6, matScale(mul(m, c.mat)))]);
      ctx.strokeRect(0, 40, c.advanceEm, 960);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

function drawLogoRef(ctx: Ctx, o: LogoRefObj, m: Mat, env: RenderEnv, opts: StyledOpts, depth: number) {
  const logo = env.logos.find((l) => l.id === o.logoId);
  if (!logo || depth > 6) return;
  renderStyled(ctx, logo.objects, m, env, opts, undefined, depth + 1);
}

/** 編集表示用の市松模様 */
export function drawChecker(ctx: Ctx, view: Mat, w: number, h: number, size = 16) {
  ctx.save();
  setT(ctx, view);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 画面座標でタイルを描く
  const p0 = apply(view, 0, 0);
  const p1 = apply(view, w, h);
  ctx.beginPath();
  ctx.rect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  ctx.clip();
  ctx.fillStyle = '#e6e9ef';
  for (let y = Math.floor(p0.y); y < p1.y; y += size)
    for (let x = Math.floor(p0.x) + (Math.floor((y - p0.y) / size) % 2) * size; x < p1.x; x += size * 2) ctx.fillRect(x, y, size, size);
  ctx.restore();
}
