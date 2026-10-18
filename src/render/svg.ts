import type { Mat, Obj, Style, TextObj, Frame } from '../model/types';
import { strokeOutline, ringToSvgD, shapesToSvgD, transformShapes, composeInk } from '../geom/outline';
import { pathToSvgD } from '../geom/path';
import { mul, matScale, scale as scaleM, translate, isIdentity } from '../geom/matrix';
import { localBox, transformBox, boxValid } from '../geom/bounds';
import { layoutText } from './textLayout';
import type { RenderEnv } from './env';
import { effectiveStyle, gradientEndpoints, makeCanvas, renderStyled } from './canvas';

export interface SvgInput {
  objects: Obj[];
  env: RenderEnv;
  frame: Frame;
  /** 出力ピクセル幅・高さ */
  width: number;
  height: number;
  background: string | null;
  bgImage?: { href: string; width: number; height: number } | null;
  /** 単色（字形）モード */
  ink?: string;
  /** 代用文字ラスターの解像度倍率（出力 1px あたり） */
  rasterScale?: number;
}

export interface SvgResult {
  svg: string;
  /** ラスター画像として埋め込んだ代用文字の数 */
  rasterChars: number;
  hasBackgroundImage: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => +v.toFixed(3);
const matAttr = (m: Mat) => (isIdentity(m) ? '' : ` transform="matrix(${m.map(n).join(' ')})"`);

export function svgColor(c: string): { color: string; opacity: number } {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (m) return { color: '#' + m[1].toLowerCase(), opacity: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  return { color: c, opacity: 1 };
}
function colorAttr(attr: 'fill' | 'stroke', c: string) {
  const { color, opacity } = svgColor(c);
  return ` ${attr}="${color}"` + (opacity < 1 ? ` ${attr}-opacity="${n(opacity)}"` : '');
}

class Builder {
  defs: string[] = [];
  body: string[] = [];
  id = 0;
  rasterChars = 0;
  constructor(
    public env: RenderEnv,
    public rasterScale: number,
  ) {}
  nextId(p: string) {
    return `${p}${++this.id}`;
  }
}

/** 塗りの属性（グラデーションは defs に追加） */
function fillAttr(b: Builder, style: Style, box: { minX: number; minY: number; maxX: number; maxY: number }) {
  if (style.fill.kind === 'solid') return colorAttr('fill', style.fill.color);
  const id = b.nextId('g');
  const e = gradientEndpoints(style.fill, box);
  const f = svgColor(style.fill.from);
  const t = svgColor(style.fill.to);
  b.defs.push(
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(e.x1)}" y1="${n(e.y1)}" x2="${n(e.x2)}" y2="${n(e.y2)}">` +
      `<stop offset="0" stop-color="${f.color}" stop-opacity="${n(f.opacity)}"/>` +
      `<stop offset="1" stop-color="${t.color}" stop-opacity="${n(t.opacity)}"/></linearGradient>`,
  );
  return ` fill="url(#${id})"`;
}

/** cum: 親までの累積変換（出力ピクセル換算は rasterScale を掛ける） */
function emitObj(b: Builder, o: Obj, cum: Mat, style: Style, depth: number): string {
  if (o.hidden) return '';
  if (o.type === 'stroke' && o.erase) return '';
  const m = mul(cum, o.transform);
  const k = matScale(m);
  const content = emitContent(b, o, style, depth, k, m);
  if (!content) return '';
  const inner = `<g${matAttr(o.transform)}>${content}</g>`;
  const needFx = style.shadow.on || style.opacity < 1 || (o.type === 'logoRef' && style.outline.on);
  if (!needFx) return inner;
  // 影は Canvas と同じく「親座標系の軸」で、オブジェクトの拡大率に比例させる
  const sk = matScale(o.transform);
  let filter = '';
  if (style.shadow.on || (o.type === 'logoRef' && style.outline.on)) {
    const id = b.nextId('f');
    let prims = '';
    let last = 'SourceGraphic';
    if (o.type === 'logoRef' && style.outline.on) {
      const oc = svgColor(style.outline.color);
      prims +=
        `<feMorphology in="SourceAlpha" operator="dilate" radius="${n(style.outline.width * sk)}" result="d"/>` +
        `<feFlood flood-color="${oc.color}" flood-opacity="${n(oc.opacity)}"/>` +
        `<feComposite in2="d" operator="in" result="ol"/>` +
        `<feMerge result="wo"><feMergeNode in="ol"/><feMergeNode in="SourceGraphic"/></feMerge>`;
      last = 'wo';
    }
    if (style.shadow.on) {
      const sc = svgColor(style.shadow.color);
      prims += `<feDropShadow in="${last}" dx="${n(style.shadow.dx * sk)}" dy="${n(style.shadow.dy * sk)}" stdDeviation="${n((style.shadow.blur * sk) / 2)}" flood-color="${sc.color}" flood-opacity="${n(sc.opacity)}"/>`;
    }
    b.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${prims}</filter>`);
    filter = ` filter="url(#${id})"`;
  }
  const op = style.opacity < 1 ? ` opacity="${n(style.opacity)}"` : '';
  return `<g${filter}${op}>${inner}</g>`;
}

function emitContent(b: Builder, o: Obj, style: Style, depth: number, k: number, m: Mat): string {
  const ow = style.outline.on ? style.outline.width : 0;
  const ocol = style.outline.color;
  switch (o.type) {
    case 'group':
      return o.children.map((c) => emitObj(b, c, m, effectiveStyle(c, style), depth)).join('');
    case 'logoRef': {
      const logo = b.env.logos.find((l) => l.id === o.logoId);
      if (!logo || depth > 6) return '';
      return logo.objects.map((c) => emitObj(b, c, m, effectiveStyle(c), depth + 1)).join('');
    }
    case 'stroke': {
      const d = ringToSvgD(strokeOutline(o));
      if (!d) return '';
      const fill = fillAttr(b, style, localBox(o, b.env));
      const outline = ow > 0 ? `<path d="${d}" fill="none"${colorAttr('stroke', ocol)} stroke-width="${n(ow * 2)}" stroke-linejoin="round"/>` : '';
      return `${outline}<path d="${d}"${fill}/>`;
    }
    case 'path': {
      const d = pathToSvgD(o.nodes, o.closed);
      if (!d) return '';
      const filled = o.closed && o.fill;
      const box = localBox(o, b.env);
      const fill = fillAttr(b, style, box);
      const paint = fill.replace(' fill=', ' stroke=').replace(' fill-opacity=', ' stroke-opacity=');
      let s = '';
      if (ow > 0) {
        if (filled) s += `<path d="${d}" fill="none"${colorAttr('stroke', ocol)} stroke-width="${n(ow * 2)}" stroke-linejoin="round"/>`;
        if (o.strokeWidth > 0)
          s += `<path d="${d}" fill="none"${colorAttr('stroke', ocol)} stroke-width="${n(o.strokeWidth + ow * 2)}" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      if (filled) s += `<path d="${d}"${fill}/>`;
      if (o.strokeWidth > 0) s += `<path d="${d}" fill="none"${paint} stroke-width="${n(o.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round"/>`;
      return s;
    }
    case 'text':
      return emitText(b, o, style, k);
  }
}

function emitText(b: Builder, o: TextObj, style: Style, k: number): string {
  const layout = layoutText(o, b.env);
  const box = localBox(o, b.env);
  const ow = style.outline.on ? style.outline.width : 0;
  let custom = '';
  for (const c of layout.chars) if (c.outline) custom += shapesToSvgD(transformShapes(c.outline.shapes, c.mat));
  let s = '';
  if (custom && ow > 0)
    s += `<path d="${custom}" fill="none"${colorAttr('stroke', style.outline.color)} stroke-width="${n(ow * 2)}" stroke-linejoin="round"/>`;
  if (custom) s += `<path d="${custom}"${fillAttr(b, style, box)}/>`;
  // 代用文字：見た目を保つためラスター画像で埋め込む（完全なベクターではない）
  for (const c of layout.chars) {
    if (c.outline || !c.ch.trim()) continue;
    const cb = transformBox({ minX: 0, minY: 0, maxX: c.advanceEm, maxY: 1000 }, c.mat);
    if (!boxValid(cb)) continue;
    const pad = ow + o.fontSize * 0.15;
    const bx = cb.minX - pad;
    const by = cb.minY - pad;
    const bw = cb.maxX - cb.minX + pad * 2;
    const bh = cb.maxY - cb.minY + pad * 2;
    const r = Math.min(b.rasterScale * k, 2048 / Math.max(bw, bh));
    const cw = Math.max(1, Math.ceil(bw * r));
    const ch = Math.max(1, Math.ceil(bh * r));
    const cv = makeCanvas(cw, ch);
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    const single: TextObj = { ...o, transform: [1, 0, 0, 1, 0, 0], style: { ...style, shadow: { ...style.shadow, on: false }, opacity: 1 } };
    // single は o と同じ text なので同じレイアウトになる
    renderStyled(ctx, [single], mul(scaleM(r), translate(-bx, -by)), b.env, { onlyFallbackIndex: c.index });
    const href = canvasToDataUrl(cv);
    if (!href) continue;
    b.rasterChars++;
    s += `<image data-fallback-char="${esc(c.ch)}" x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" preserveAspectRatio="none" href="${href}"/>`;
  }
  return s;
}

function canvasToDataUrl(cv: HTMLCanvasElement | OffscreenCanvas): string | null {
  if (typeof HTMLCanvasElement !== 'undefined' && cv instanceof HTMLCanvasElement) return cv.toDataURL('image/png');
  // OffscreenCanvas は同期で dataURL を作れないので、通常の canvas に写す
  try {
    const c = document.createElement('canvas');
    c.width = cv.width;
    c.height = cv.height;
    c.getContext('2d')!.drawImage(cv as CanvasImageSource, 0, 0);
    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}

export function buildSvg(input: SvgInput): SvgResult {
  const b = new Builder(input.env, input.rasterScale ?? input.width / Math.max(1, input.frame.w) * 2);
  const { frame } = input;
  let content = '';
  if (input.background) {
    const bc = svgColor(input.background);
    content += `<rect x="${n(frame.x)}" y="${n(frame.y)}" width="${n(frame.w)}" height="${n(frame.h)}" fill="${bc.color}"${bc.opacity < 1 ? ` fill-opacity="${n(bc.opacity)}"` : ''}/>`;
  }
  if (input.bgImage) {
    content += `<image x="0" y="0" width="${n(input.bgImage.width)}" height="${n(input.bgImage.height)}" preserveAspectRatio="none" href="${input.bgImage.href}"/>`;
  }
  if (input.ink) {
    // 字形：単色の合成輪郭として出力（フォントと同じ形）
    const ink = composeInk(input.objects);
    const d = shapesToSvgD(ink);
    if (d) content += `<path d="${d}"${colorAttr('fill', input.ink)}/>`;
  } else {
    content += input.objects.map((o) => emitObj(b, o, [1, 0, 0, 1, 0, 0], effectiveStyle(o), 0)).join('');
  }
  const notes: string[] = [];
  if (b.rasterChars > 0) notes.push(`代用文字 ${b.rasterChars} 文字はラスター画像（PNG）として埋め込まれています。完全なベクターではありません。`);
  if (input.bgImage) notes.push('背景画像はラスター画像として埋め込まれています。');
  const desc = notes.length ? `<desc>${esc(notes.join(' '))}</desc>` : '';
  const comment = notes.length ? `<!-- ${esc(notes.join(' '))} -->\n` : '';
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n${comment}` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(input.width)}" height="${Math.round(input.height)}" viewBox="${n(frame.x)} ${n(frame.y)} ${n(frame.w)} ${n(frame.h)}">` +
    desc +
    (b.defs.length ? `<defs>${b.defs.join('')}</defs>` : '') +
    content +
    `</svg>\n`;
  return { svg, rasterChars: b.rasterChars, hasBackgroundImage: !!input.bgImage };
}
