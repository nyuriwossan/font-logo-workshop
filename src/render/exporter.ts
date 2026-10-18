import type { Frame, Obj, Project } from '../model/types';
import { renderInk, renderStyled } from './canvas';
import { buildSvg } from './svg';
import type { RenderEnv } from './env';
import { composeInk, ringsBBox } from '../geom/outline';
import { shapesToRings } from '../geom/clip';
import { objectsBox, boxValid } from '../geom/bounds';
import { getAsset } from '../store/db';
import { loadImage } from './images';
import { blobToDataUrl } from '../store/backup';

export type ExportSource = { kind: 'glyph'; cp: number } | { kind: 'logo'; id: string } | { kind: 'composite'; id: string };

/** iPad Safari の Canvas 上限（約 1,670 万ピクセル）に合わせる */
export const MAX_PIXELS = 16_777_216;
export const MAX_SIDE = 8192;

export interface ExportOptions {
  range: 'frame' | 'content';
  padding: number;
  /** 出力倍率（フレーム 1 単位あたりのピクセル） */
  scale: number;
  background: string | null;
  /** 字形の色 */
  ink: string;
  /** 合成：背景画像を含める */
  includeBg: boolean;
}

export interface Resolved {
  objects: Obj[];
  frame: Frame;
  glyph: boolean;
  bgAssetId: string | null;
  name: string;
}

export function resolveSource(project: Project, src: ExportSource): Resolved | null {
  if (src.kind === 'glyph') {
    const g = project.glyphs[String(src.cp)];
    return { objects: g?.objects ?? [], frame: { x: 0, y: 0, w: 1000, h: 1000 }, glyph: true, bgAssetId: null, name: `glyph-U${src.cp.toString(16).toUpperCase().padStart(4, '0')}` };
  }
  if (src.kind === 'logo') {
    const l = project.logos.find((x) => x.id === src.id);
    return l ? { objects: l.objects, frame: { x: 0, y: 0, w: l.width, h: l.height }, glyph: false, bgAssetId: null, name: 'logo' } : null;
  }
  const c = project.composites.find((x) => x.id === src.id);
  return c ? { objects: c.objects, frame: { x: 0, y: 0, w: c.width, h: c.height }, glyph: false, bgAssetId: c.assetId, name: 'composite' } : null;
}

/** 出力範囲（ドキュメント座標） */
export function exportFrame(r: Resolved, env: RenderEnv, opt: Pick<ExportOptions, 'range' | 'padding' | 'includeBg'>): Frame | null {
  if (opt.range === 'frame' || (r.bgAssetId && opt.includeBg)) return r.frame;
  let box;
  if (r.glyph) {
    const b = ringsBBox(shapesToRings(composeInk(r.objects)));
    box = b ? { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : null;
  } else {
    const b = objectsBox(r.objects, env);
    box = boxValid(b) ? b : null;
  }
  if (!box) return null;
  const p = opt.padding;
  return { x: box.minX - p, y: box.minY - p, w: box.maxX - box.minX + p * 2, h: box.maxY - box.minY + p * 2 };
}

export function pixelSize(frame: Frame, scale: number) {
  let s = scale;
  let w = Math.max(1, Math.round(frame.w * s));
  let h = Math.max(1, Math.round(frame.h * s));
  let clamped = false;
  if (w * h > MAX_PIXELS || w > MAX_SIDE || h > MAX_SIDE) {
    const k = Math.min(Math.sqrt(MAX_PIXELS / (w * h)), MAX_SIDE / w, MAX_SIDE / h);
    s = s * k * 0.999;
    w = Math.max(1, Math.floor(frame.w * s));
    h = Math.max(1, Math.floor(frame.h * s));
    clamped = true;
  }
  return { w, h, scale: s, clamped };
}

export async function renderRaster(r: Resolved, env: RenderEnv, opt: ExportOptions, frame: Frame, maxPreview?: number) {
  let { w, h, scale, clamped } = pixelSize(frame, opt.scale);
  if (maxPreview && Math.max(w, h) > maxPreview) {
    const k = maxPreview / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    scale *= k;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を作れませんでした（端末のメモリ不足の可能性があります）');
  const view: [number, number, number, number, number, number] = [scale, 0, 0, scale, -frame.x * scale, -frame.y * scale];
  if (opt.background) {
    ctx.fillStyle = opt.background;
    ctx.fillRect(0, 0, w, h);
  }
  if (r.bgAssetId && opt.includeBg) {
    const img = await loadImage(r.bgAssetId);
    if (img) {
      ctx.setTransform(...view);
      ctx.drawImage(img, 0, 0, r.frame.w, r.frame.h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
  if (r.glyph) renderInk(ctx, r.objects, view, opt.ink);
  else renderStyled(ctx, r.objects, view, env, {});
  return { canvas, w, h, clamped };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) => {
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像の書き出しに失敗しました'))), type, quality);
  });
}

export async function exportSvg(r: Resolved, env: RenderEnv, opt: ExportOptions, frame: Frame) {
  const { w, h } = pixelSize(frame, opt.scale);
  let bgImage: { href: string; width: number; height: number } | null = null;
  if (r.bgAssetId && opt.includeBg) {
    const a = await getAsset(r.bgAssetId);
    if (a) bgImage = { href: await blobToDataUrl(a.blob), width: r.frame.w, height: r.frame.h };
  }
  const res = buildSvg({
    objects: r.objects,
    env,
    frame,
    width: w,
    height: h,
    background: opt.background,
    bgImage,
    ink: r.glyph ? opt.ink : undefined,
    rasterScale: (w / frame.w) * 2,
  });
  return { blob: new Blob([res.svg], { type: 'image/svg+xml' }), rasterChars: res.rasterChars, width: w, height: h, hasBg: res.hasBackgroundImage };
}

/**
 * ファイル名は半角英数字にする（ブラウザによっては日本語のファイル名が無視され、拡張子まで失われるため）
 */
export function safeFileName(name: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const base = (name || 'image').replace(/[^A-Za-z0-9+_-]/g, '').slice(0, 40) || 'image';
  return `${base}-${stamp}`;
}

/** ダウンロード（iPad Safari ではファイル App に保存されます） */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFile(blob: Blob, filename: string): boolean {
  try {
    const f = new File([blob], filename, { type: blob.type });
    return !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

/** 共有シート（写真に保存などに使える） */
export async function shareBlob(blob: Blob, filename: string) {
  const f = new File([blob], filename, { type: blob.type });
  await navigator.share({ files: [f], title: filename });
}
