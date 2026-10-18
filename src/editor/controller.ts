import { getStroke } from 'perfect-freehand';
import type { Mat, PathNode, PathObj, StrokeObj, StrokePoint, TextObj, Vec, Route } from '../model/types';
import {
  useStore,
  docOf,
  commitDoc,
  beginGesture,
  endGesture,
  cancelGesture,
  setUi,
  undo,
  redo,
  type DocInfo,
} from '../store/store';
import { apply, invert, mul, about, scale as scaleM, rotate, matScale } from '../geom/matrix';
import { hitTopmost, hitAll, localBox, objBox, boxValid, objectsBox, type BBox } from '../geom/bounds';
import { makeShapeNodes, segments } from '../geom/path';
import { renderInk, renderStyled, drawChecker } from '../render/canvas';
import { FALLBACK_FONT } from '../render/env';
import { getImage, onImageLoaded } from '../render/images';
import { layoutText } from '../render/textLayout';
import { envOf, selectedObjs, deleteSelection, duplicateSelection, groupSelection, ungroupSelection, moveSelection } from './actions';
import { BASELINE, X_HEIGHT, CAP_HEIGHT, INK, defaultStyle, EM } from '../model/defaults';
import { uid } from '../model/ids';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';

interface SelFrame {
  /** 選択枠ローカル → ドキュメント */
  B: Mat;
  box: BBox;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | { kind: 'pinch'; d0: number; cx0: number; cy0: number; s0: number; tx0: number; ty0: number; moved: boolean; t0: number }
  | { kind: 'stroke'; points: StrokePoint[]; erase: boolean; pressure: boolean }
  | { kind: 'objErase' }
  | { kind: 'shape'; a: Vec; b: Vec }
  | { kind: 'move'; start: Vec; last: Vec; moved: boolean; tapId: string | null }
  | { kind: 'scale'; handle: Handle; frame: SelFrame; starts: Map<string, Mat>; anchor: Vec; h0: Vec }
  | { kind: 'rotate'; frame: SelFrame; starts: Map<string, Mat>; c: Vec; a0: number }
  | { kind: 'marquee'; a: Vec; b: Vec }
  | { kind: 'node'; objId: string; index: number; part: 'node' | 'hin' | 'hout'; startNodes: PathNode[]; start: Vec }
  | { kind: 'curveDrag'; node: number }
  | { kind: 'charMove'; textId: string; index: number; start: Vec; base: { dx: number; dy: number } };

const HANDLE_R = 13;

export let activeEditor: EditorController | null = null;

export class EditorController {
  private ctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  s = 1;
  tx = 0;
  ty = 0;
  private gesture: Gesture = { kind: 'none' };
  private pointers = new Map<number, { type: string; x: number; y: number }>();
  private activeId: number | null = null;
  private mainQueued = false;
  private overlayQueued = false;
  private unsub: (() => void)[] = [];
  private lastRouteKey = '';
  private downAt = { t: 0, x: 0, y: 0 };
  private lastTap = { t: 0, x: 0, y: 0 };
  private hover: Vec | null = null;
  private spaceHeld = false;
  curve: PathNode[] | null = null;
  private ro: ResizeObserver;

  constructor(
    private host: HTMLElement,
    private main: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
  ) {
    this.ctx = main.getContext('2d', { alpha: false })!;
    this.octx = overlay.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const o = overlay;
    o.addEventListener('pointerdown', this.onDown);
    o.addEventListener('pointermove', this.onMove);
    o.addEventListener('pointerup', this.onUp);
    o.addEventListener('pointercancel', this.onCancel);
    o.addEventListener('pointerleave', () => {
      this.hover = null;
      this.scheduleOverlay();
    });
    o.addEventListener('wheel', this.onWheel, { passive: false });
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari のジェスチャ（ページ拡大）を抑止
    const prevent = (e: Event) => e.preventDefault();
    o.addEventListener('gesturestart', prevent as EventListener);
    o.addEventListener('gesturechange', prevent as EventListener);
    o.addEventListener('touchstart', prevent, { passive: false });
    o.addEventListener('touchmove', prevent, { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    this.unsub.push(
      useStore.subscribe((s, p) => {
        const key = routeKey(s.route);
        if (key !== this.lastRouteKey) {
          this.finishCurve();
          this.lastRouteKey = key;
          this.fit();
        }
        if (s.ui.tool !== p.ui.tool && p.ui.tool === 'curve') this.finishCurve();
        if (s.data !== p.data || s.route !== p.route || s.ui !== p.ui) {
          this.scheduleMain();
          this.scheduleOverlay();
        }
      }),
      onImageLoaded(() => this.scheduleMain()),
    );
    this.lastRouteKey = routeKey(useStore.getState().route);
    this.fit();
    activeEditor = this;
    if (typeof location !== 'undefined' && location.search.includes('e2e')) (window as any).__flwView = this;
  }

  destroy() {
    this.ro.disconnect();
    this.unsub.forEach((f) => f());
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    if (activeEditor === this) activeEditor = null;
  }

  // ===== 座標 =====

  private get view(): Mat {
    const k = this.dpr;
    return [this.s * k, 0, 0, this.s * k, this.tx * k, this.ty * k];
  }
  private get viewCss(): Mat {
    return [this.s, 0, 0, this.s, this.tx, this.ty];
  }
  toDoc(x: number, y: number): Vec {
    return { x: (x - this.tx) / this.s, y: (y - this.ty) / this.s };
  }
  toScreen(p: Vec): Vec {
    return { x: p.x * this.s + this.tx, y: p.y * this.s + this.ty };
  }

  private doc(): DocInfo | null {
    const st = useStore.getState();
    return docOf(st.data, st.route);
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const first = this.cssW === 0;
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    for (const c of [this.main, this.overlay]) {
      c.width = Math.round(this.cssW * this.dpr);
      c.height = Math.round(this.cssH * this.dpr);
      c.style.width = this.cssW + 'px';
      c.style.height = this.cssH + 'px';
    }
    if (first) this.fit();
    this.scheduleMain();
    this.scheduleOverlay();
  }

  fit() {
    const d = this.doc();
    if (!d || this.cssW < 2) return;
    const f = d.frame;
    const pad = Math.min(60, this.cssW * 0.08);
    const s = Math.min((this.cssW - pad * 2) / f.w, (this.cssH - pad * 2) / f.h);
    this.s = Math.max(0.02, s);
    this.tx = (this.cssW - f.w * this.s) / 2 - f.x * this.s;
    this.ty = (this.cssH - f.h * this.s) / 2 - f.y * this.s;
    this.scheduleMain();
    this.scheduleOverlay();
  }

  zoomBy(k: number, cx = this.cssW / 2, cy = this.cssH / 2) {
    const ns = Math.max(0.02, Math.min(60, this.s * k));
    const kk = ns / this.s;
    this.tx = cx - (cx - this.tx) * kk;
    this.ty = cy - (cy - this.ty) * kk;
    this.s = ns;
    this.scheduleMain();
    this.scheduleOverlay();
  }

  /** 画面中央のドキュメント座標 */
  viewCenter(): Vec {
    return this.toDoc(this.cssW / 2, this.cssH / 2);
  }

  // ===== 描画 =====

  scheduleMain() {
    if (this.mainQueued) return;
    this.mainQueued = true;
    requestAnimationFrame(() => {
      this.mainQueued = false;
      this.drawMain();
    });
  }
  scheduleOverlay() {
    if (this.overlayQueued) return;
    this.overlayQueued = true;
    requestAnimationFrame(() => {
      this.overlayQueued = false;
      this.drawOverlay();
    });
  }

  drawMain() {
    const st = useStore.getState();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e9edf3';
    ctx.fillRect(0, 0, this.main.width, this.main.height);
    const d = this.doc();
    if (!d || !st.data) return;
    const v = this.view;
    const f = d.frame;
    const env = envOf(st.data);
    if (d.kind === 'glyph' || d.kind === 'part') {
      ctx.setTransform(...v);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(f.x, f.y, f.w, f.h);
      this.drawGuides(ctx, d, st.route);
      const styled = d.kind === 'part' && d.objects.some((o) => !!o.style);
      if (styled) renderStyled(ctx, d.objects, v, env, {});
      else renderInk(ctx, d.objects, v, INK);
    } else if (d.kind === 'logo') {
      drawChecker(ctx, v, f.w, f.h, 14 * this.dpr);
      this.drawArtboardEdge(ctx, f);
      renderStyled(ctx, d.objects, v, env, { markFallback: st.ui.showFallbackMarks });
    } else {
      const c = st.data.project.composites.find((x) => st.route.screen === 'composite' && x.id === st.route.id);
      const img = getImage(c?.assetId);
      if (img) {
        ctx.setTransform(...v);
        ctx.drawImage(img, 0, 0, f.w, f.h);
      } else drawChecker(ctx, v, f.w, f.h, 14 * this.dpr);
      this.drawArtboardEdge(ctx, f);
      renderStyled(ctx, d.objects, v, env, { markFallback: st.ui.showFallbackMarks });
    }
  }

  private drawArtboardEdge(ctx: CanvasRenderingContext2D, f: { x: number; y: number; w: number; h: number }) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const a = apply(this.view, f.x, f.y);
    const b = apply(this.view, f.x + f.w, f.y + f.h);
    ctx.strokeStyle = 'rgba(70, 85, 120, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    ctx.restore();
  }

  private drawGuides(ctx: CanvasRenderingContext2D, d: DocInfo, route: Route) {
    const st = useStore.getState();
    const f = d.frame;
    const px = 1 / (this.s * this.dpr);
    ctx.save();
    if (st.ui.showGrid) {
      const step = st.ui.gridStep;
      ctx.strokeStyle = '#eef1f6';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = f.x; x <= f.x + f.w + 0.01; x += step) {
        ctx.moveTo(x, f.y);
        ctx.lineTo(x, f.y + f.h);
      }
      for (let y = f.y; y <= f.y + f.h + 0.01; y += step) {
        ctx.moveTo(f.x, y);
        ctx.lineTo(f.x + f.w, y);
      }
      ctx.stroke();
    }
    if (d.kind === 'glyph' && route.screen === 'glyph') {
      // お手本（編集データ・出力には含めない）
      if (st.ui.showTemplate) {
        const ch = String.fromCodePoint(route.cp);
        ctx.font = `1000px ${FALLBACK_FONT}`;
        ctx.textBaseline = 'alphabetic';
        const w = ctx.measureText(ch).width;
        ctx.fillStyle = 'rgba(120, 132, 168, 0.16)';
        ctx.fillText(ch, (EM - w) / 2, BASELINE);
      }
      const line = (y: number, color: string, dash: number[] = []) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2 * px;
        ctx.setLineDash(dash.map((x) => x * px));
        ctx.beginPath();
        ctx.moveTo(f.x, y);
        ctx.lineTo(f.x + f.w, y);
        ctx.stroke();
      };
      line(BASELINE, 'rgba(70, 110, 200, 0.75)');
      line(BASELINE - X_HEIGHT, 'rgba(150, 130, 220, 0.45)', [6, 5]);
      line(BASELINE - CAP_HEIGHT, 'rgba(150, 130, 220, 0.45)', [6, 5]);
      line(EM / 2, 'rgba(90, 100, 130, 0.18)', [3, 5]);
      ctx.setLineDash([3 * px, 5 * px]);
      ctx.beginPath();
      ctx.moveTo(EM / 2, f.y);
      ctx.lineTo(EM / 2, f.y + f.h);
      ctx.stroke();
      // 固定送り幅の位置
      const g = st.data?.project.glyphs[String(route.cp)];
      if (g && !g.metrics.autoAdvance && Math.abs(g.metrics.advance - EM) > 1) {
        ctx.setLineDash([8 * px, 6 * px]);
        ctx.strokeStyle = 'rgba(200, 120, 90, 0.6)';
        ctx.beginPath();
        ctx.moveTo(g.metrics.advance, f.y);
        ctx.lineTo(g.metrics.advance, f.y + f.h);
        ctx.stroke();
      }
    }
    if (d.kind === 'part') {
      // パーツの挿入基準点
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(224, 96, 126, 0.6)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.moveTo(-40, 0);
      ctx.lineTo(40, 0);
      ctx.moveTo(0, -40);
      ctx.lineTo(0, 40);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(70, 85, 120, 0.35)';
    ctx.lineWidth = px;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    ctx.restore();
  }

  drawOverlay() {
    const st = useStore.getState();
    const o = this.octx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!st.data) return;
    o.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const env = envOf(st.data);
    const g = this.gesture;
    const ui = st.ui;
    const vc = this.viewCss;

    // 描きかけの線
    if (g.kind === 'stroke' && g.points.length) {
      const pen = g.erase ? { ...ui.pen, size: ui.eraserSize } : ui.pen;
      const usePressure = !g.erase && g.pressure && pen.usePressure;
      const raw = getStroke(
        g.points.map(([x, y, p]) => [x, y, usePressure ? p : 0.5]),
        {
          size: pen.size,
          thinning: usePressure ? pen.thinning : 0,
          smoothing: pen.smoothing,
          streamline: pen.streamline,
          simulatePressure: false,
          start: { taper: !g.erase && pen.taperStart > 0 ? pen.taperStart : false, cap: true },
          end: { taper: !g.erase && pen.taperEnd > 0 ? pen.taperEnd : false, cap: true },
          last: false,
        },
      );
      o.save();
      o.setTransform(...mul([this.dpr, 0, 0, this.dpr, 0, 0], vc));
      o.beginPath();
      raw.forEach(([x, y], i) => (i ? o.lineTo(x, y) : o.moveTo(x, y)));
      o.closePath();
      const d = this.doc();
      o.fillStyle = g.erase ? 'rgba(240, 120, 120, 0.35)' : d?.kind === 'logo' ? ui.decoColor : INK;
      o.fill();
      o.restore();
    }

    // 消しゴムのカーソル
    if (ui.tool === 'eraser' && this.hover) {
      const p = this.toScreen(this.hover);
      o.strokeStyle = 'rgba(80, 90, 120, 0.7)';
      o.lineWidth = 1;
      o.beginPath();
      o.arc(p.x, p.y, Math.max(4, (ui.eraserSize / 2) * this.s), 0, Math.PI * 2);
      o.stroke();
    }

    // 図形プレビュー
    if (g.kind === 'shape') {
      const kind = ui.tool as 'line' | 'rect' | 'ellipse' | 'polygon';
      const { nodes, closed } = makeShapeNodes(kind, g.a, g.b, ui.polygonSides);
      this.strokeNodes(o, nodes, closed, vc, '#5b6fd6');
    }

    // 曲線ツールの描きかけ
    if (this.curve && this.curve.length) {
      this.strokeNodes(o, this.curve, false, vc, '#5b6fd6');
      const last = this.curve[this.curve.length - 1];
      if (this.hover && g.kind !== 'curveDrag') {
        const a = this.toScreen(last);
        const b = this.toScreen(this.hover);
        o.setLineDash([5, 5]);
        o.strokeStyle = 'rgba(91, 111, 214, 0.6)';
        o.beginPath();
        o.moveTo(a.x, a.y);
        o.lineTo(b.x, b.y);
        o.stroke();
        o.setLineDash([]);
      }
      this.curve.forEach((n, i) => this.drawNodeMarks(o, n, i === 0 ? '#e0607e' : '#5b6fd6', [1, 0, 0, 1, 0, 0]));
    }

    // 選択枠
    const sel = selectedObjs();
    if (sel.length && ui.tool !== 'node') {
      const fr = this.selFrame();
      if (fr) this.drawSelFrame(o, fr, sel.length === 1 && !!sel[0].locked);
    }
    // 制御点
    if (ui.tool === 'node' && sel.length === 1 && sel[0].type === 'path') {
      const p = sel[0];
      this.strokeNodes(o, p.nodes, p.closed, mul(vc, p.transform), 'rgba(91,111,214,0.8)');
      p.nodes.forEach((n, i) => this.drawNodeMarks(o, n, i === ui.nodeSel ? '#e0607e' : '#5b6fd6', p.transform));
    } else if (ui.tool === 'node' && sel.length === 1 && sel[0].type === 'stroke') {
      const fr = this.selFrame();
      if (fr) this.drawSelFrame(o, fr, true);
    }

    // 文字単位編集
    if (ui.charEdit) {
      const t = this.doc()?.objects.find((x) => x.id === ui.charEdit!.id);
      if (t && t.type === 'text') {
        const l = layoutText(t, env);
        for (const c of l.chars) {
          const m = mul(vc, mul(t.transform, c.mat));
          const pts = [apply(m, 0, 0), apply(m, c.advanceEm, 0), apply(m, c.advanceEm, EM), apply(m, 0, EM)];
          o.beginPath();
          pts.forEach((p, i) => (i ? o.lineTo(p.x, p.y) : o.moveTo(p.x, p.y)));
          o.closePath();
          const selc = c.index === ui.charEdit.index;
          o.strokeStyle = selc ? '#e0607e' : 'rgba(91,111,214,0.55)';
          o.lineWidth = selc ? 2 : 1;
          o.setLineDash(selc ? [] : [4, 4]);
          o.stroke();
          o.setLineDash([]);
        }
      }
    }

    // 範囲選択
    if (g.kind === 'marquee') {
      const a = this.toScreen(g.a);
      const b = this.toScreen(g.b);
      o.fillStyle = 'rgba(91, 111, 214, 0.08)';
      o.strokeStyle = 'rgba(91, 111, 214, 0.8)';
      o.setLineDash([5, 4]);
      o.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      o.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      o.setLineDash([]);
    }
  }

  private strokeNodes(o: CanvasRenderingContext2D, nodes: PathNode[], closed: boolean, m: Mat, color: string) {
    if (!nodes.length) return;
    o.save();
    o.strokeStyle = color;
    o.lineWidth = 1.5;
    o.beginPath();
    const p0 = apply(m, nodes[0].x, nodes[0].y);
    o.moveTo(p0.x, p0.y);
    for (const [, c1, c2, p3, isLine] of segments(nodes, closed)) {
      const a = apply(m, c1.x, c1.y);
      const b = apply(m, c2.x, c2.y);
      const c = apply(m, p3.x, p3.y);
      if (isLine) o.lineTo(c.x, c.y);
      else o.bezierCurveTo(a.x, a.y, b.x, b.y, c.x, c.y);
    }
    if (closed) o.closePath();
    o.stroke();
    o.restore();
  }

  private drawNodeMarks(o: CanvasRenderingContext2D, n: PathNode, color: string, objT: Mat) {
    const m = mul(this.viewCss, objT);
    const p = apply(m, n.x, n.y);
    o.save();
    for (const h of [n.hin, n.hout]) {
      if (!h) continue;
      const q = apply(m, h.x, h.y);
      o.strokeStyle = 'rgba(91,111,214,0.6)';
      o.lineWidth = 1;
      o.beginPath();
      o.moveTo(p.x, p.y);
      o.lineTo(q.x, q.y);
      o.stroke();
      o.fillStyle = '#fff';
      o.strokeStyle = color;
      o.beginPath();
      o.arc(q.x, q.y, 5.5, 0, Math.PI * 2);
      o.fill();
      o.stroke();
    }
    o.fillStyle = color;
    o.strokeStyle = '#fff';
    o.lineWidth = 2;
    o.beginPath();
    o.rect(p.x - 6.5, p.y - 6.5, 13, 13);
    o.fill();
    o.stroke();
    o.restore();
  }

  selFrame(): SelFrame | null {
    const st = useStore.getState();
    if (!st.data) return null;
    const env = envOf(st.data);
    const sel = selectedObjs();
    if (!sel.length) return null;
    if (sel.length === 1) {
      const b = localBox(sel[0], env);
      if (!boxValid(b)) return null;
      return { B: sel[0].transform, box: b };
    }
    const b = objectsBox(sel, env);
    if (!boxValid(b)) return null;
    return { B: [1, 0, 0, 1, 0, 0], box: b };
  }

  private handlePoints(fr: SelFrame): Record<Handle, Vec> {
    const m = mul(this.viewCss, fr.B);
    const { minX, minY, maxX, maxY } = fr.box;
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    const pts: Record<Handle, Vec> = {
      nw: apply(m, minX, minY),
      n: apply(m, mx, minY),
      ne: apply(m, maxX, minY),
      e: apply(m, maxX, my),
      se: apply(m, maxX, maxY),
      s: apply(m, mx, maxY),
      sw: apply(m, minX, maxY),
      w: apply(m, minX, my),
      rot: { x: 0, y: 0 },
    };
    // 回転ハンドルは上辺の外側
    const top = pts.n;
    const c = apply(m, mx, my);
    const dx = top.x - c.x;
    const dy = top.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    pts.rot = { x: top.x + (dx / len) * 34, y: top.y + (dy / len) * 34 };
    return pts;
  }

  private drawSelFrame(o: CanvasRenderingContext2D, fr: SelFrame, noHandles: boolean) {
    const h = this.handlePoints(fr);
    o.save();
    o.strokeStyle = '#5b6fd6';
    o.lineWidth = 1.5;
    o.beginPath();
    [h.nw, h.ne, h.se, h.sw].forEach((p, i) => (i ? o.lineTo(p.x, p.y) : o.moveTo(p.x, p.y)));
    o.closePath();
    o.stroke();
    if (!noHandles) {
      o.beginPath();
      o.moveTo(h.n.x, h.n.y);
      o.lineTo(h.rot.x, h.rot.y);
      o.stroke();
      for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot'] as Handle[]) {
        const p = h[k];
        o.fillStyle = k === 'rot' ? '#8e7ce0' : '#ffffff';
        o.strokeStyle = '#5b6fd6';
        o.lineWidth = 2;
        o.beginPath();
        if (k === 'rot') o.arc(p.x, p.y, 8, 0, Math.PI * 2);
        else o.rect(p.x - 6, p.y - 6, 12, 12);
        o.fill();
        o.stroke();
      }
    }
    o.restore();
  }

  // ===== 入力 =====

  private isPanInput(e: PointerEvent): boolean {
    const ui = useStore.getState().ui;
    if (ui.tool === 'hand' || this.spaceHeld) return true;
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) return true;
    if (e.pointerType === 'touch' && ui.penDetected && !ui.fingerDraws) return true;
    return false;
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    const st = useStore.getState();
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.pointerType === 'pen' && !st.ui.penDetected) setUi({ penDetected: true });
    this.pointers.set(e.pointerId, { type: e.pointerType, x, y });
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      /* 一部ブラウザで失敗しても続行 */
    }

    // ペンが触れたら指の操作は中止（手のひら誤タッチ対策）
    if (e.pointerType === 'pen') {
      if (this.gesture.kind === 'pan' || this.gesture.kind === 'pinch') this.gesture = { kind: 'none' };
      for (const [id, p] of this.pointers) if (p.type === 'touch') this.pointers.delete(id);
    } else if (e.pointerType === 'touch') {
      const penActive = this.activeId !== null && this.pointers.get(this.activeId)?.type === 'pen';
      if (penActive) {
        this.pointers.delete(e.pointerId);
        return;
      }
      const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (touches.length >= 2) {
        // 2 本指：描画中なら取り消してピンチへ
        this.abortActive();
        const [a, b] = touches;
        this.gesture = {
          kind: 'pinch',
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          cx0: (a.x + b.x) / 2,
          cy0: (a.y + b.y) / 2,
          s0: this.s,
          tx0: this.tx,
          ty0: this.ty,
          moved: false,
          t0: performance.now(),
        };
        this.activeId = null;
        return;
      }
    }
    if (this.activeId !== null) return;
    this.activeId = e.pointerId;
    this.downAt = { t: performance.now(), x, y };

    if (this.isPanInput(e)) {
      this.gesture = { kind: 'pan', sx: x, sy: y, tx: this.tx, ty: this.ty };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.toolDown(e, this.toDoc(x, y), x, y);
  };

  private abortActive() {
    const g = this.gesture;
    if (g.kind === 'stroke' || g.kind === 'shape' || g.kind === 'marquee') this.gesture = { kind: 'none' };
    else if (g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate' || g.kind === 'node' || g.kind === 'charMove' || g.kind === 'objErase') {
      cancelGesture();
      this.gesture = { kind: 'none' };
    }
    this.scheduleOverlay();
  }

  private snap(p: Vec): Vec {
    const ui = useStore.getState().ui;
    if (!ui.snap) return p;
    const s = ui.gridStep;
    return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
  }

  private pressureOf(e: PointerEvent) {
    if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
    return 0.5;
  }

  private toolDown(e: PointerEvent, p: Vec, sx: number, sy: number) {
    const st = useStore.getState();
    const d = this.doc();
    if (!d || !st.data) return;
    const ui = st.ui;
    const env = envOf(st.data);
    const tol = (e.pointerType === 'touch' ? 14 : 8) / this.s;
    switch (ui.tool) {
      case 'pen':
        this.gesture = { kind: 'stroke', points: [[p.x, p.y, this.pressureOf(e)]], erase: false, pressure: e.pointerType === 'pen' };
        this.scheduleOverlay();
        return;
      case 'eraser':
        if (ui.eraserMode === 'partial' && (d.kind === 'glyph' || d.kind === 'part')) {
          this.gesture = { kind: 'stroke', points: [[p.x, p.y, 0.5]], erase: true, pressure: false };
        } else {
          beginGesture();
          this.gesture = { kind: 'objErase' };
          this.eraseAt(p);
        }
        return;
      case 'line':
      case 'rect':
      case 'ellipse':
      case 'polygon': {
        const a = this.snap(p);
        this.gesture = { kind: 'shape', a, b: a };
        return;
      }
      case 'curve':
        this.curveDown(p, sx, sy);
        return;
      case 'text':
        if (d.kind === 'logo' || d.kind === 'composite') {
          this.createText(p);
          return;
        }
        break;
      case 'node':
        if (this.nodeDown(p, sx, sy, tol)) return;
        break;
    }
    // 選択ツール（およびノードツールで何も掴まなかった場合）
    const fr = this.selFrame();
    const sel = selectedObjs();
    if (fr && ui.tool === 'select' && !(sel.length === 1 && sel[0].locked)) {
      const h = this.handlePoints(fr);
      const r = e.pointerType === 'touch' ? 22 : HANDLE_R;
      for (const k of ['rot', 'nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as Handle[]) {
        if (Math.hypot(h[k].x - sx, h[k].y - sy) <= r) {
          this.startHandle(k, fr, p);
          return;
        }
      }
    }
    // 文字単位編集
    if (ui.charEdit && ui.tool === 'select') {
      const t = d.objects.find((x) => x.id === ui.charEdit!.id);
      if (t && t.type === 'text') {
        const idx = this.charAt(t, p);
        if (idx !== null) {
          const adj = t.charAdj[String(idx)] ?? { dx: 0, dy: 0, rot: 0, scale: 1 };
          setUi({ charEdit: { id: t.id, index: idx } });
          beginGesture();
          this.gesture = { kind: 'charMove', textId: t.id, index: idx, start: p, base: { dx: adj.dx, dy: adj.dy } };
          return;
        }
      }
      setUi({ charEdit: null });
    }
    const hit = hitTopmost(d.objects, p, tol, env);
    if (hit) {
      let selection = ui.selection;
      if (ui.multiSelect || e.shiftKey) {
        selection = selection.includes(hit.id) ? selection.filter((i) => i !== hit.id) : [...selection, hit.id];
      } else if (!selection.includes(hit.id)) selection = [hit.id];
      setUi({ selection, nodeSel: null, ...(ui.tool === 'node' ? {} : {}) });
      if (ui.tool === 'node') return;
      beginGesture();
      this.gesture = { kind: 'move', start: p, last: p, moved: false, tapId: hit.id };
      return;
    }
    if (!ui.multiSelect && !e.shiftKey) setUi({ selection: [], nodeSel: null });
    this.gesture = { kind: 'marquee', a: p, b: p };
  }

  private charAt(t: TextObj, p: Vec): number | null {
    const st = useStore.getState();
    if (!st.data) return null;
    const l = layoutText(t, envOf(st.data));
    for (let i = l.chars.length - 1; i >= 0; i--) {
      const c = l.chars[i];
      const lp = apply(invert(mul(t.transform, c.mat)), p.x, p.y);
      if (lp.x >= 0 && lp.x <= Math.max(c.advanceEm, 200) && lp.y >= 0 && lp.y <= EM) return c.index;
    }
    return null;
  }

  private startHandle(h: Handle, fr: SelFrame, p: Vec) {
    const sel = selectedObjs();
    const starts = new Map(sel.map((o) => [o.id, o.transform] as [string, Mat]));
    beginGesture();
    const { minX, minY, maxX, maxY } = fr.box;
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    if (h === 'rot') {
      const c = apply(fr.B, mx, my);
      this.gesture = { kind: 'rotate', frame: fr, starts, c, a0: Math.atan2(p.y - c.y, p.x - c.x) };
      return;
    }
    const pos: Record<string, Vec> = {
      nw: { x: minX, y: minY },
      n: { x: mx, y: minY },
      ne: { x: maxX, y: minY },
      e: { x: maxX, y: my },
      se: { x: maxX, y: maxY },
      s: { x: mx, y: maxY },
      sw: { x: minX, y: maxY },
      w: { x: minX, y: my },
    };
    const opp: Record<string, string> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
    this.gesture = { kind: 'scale', handle: h, frame: fr, starts, anchor: pos[opp[h]], h0: pos[h] };
  }

  private onMove = (e: PointerEvent) => {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) {
      ptr.x = x;
      ptr.y = y;
    }
    const g = this.gesture;
    if (g.kind === 'pinch') {
      const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (touches.length < 2) return;
      const [a, b] = touches;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const ns = Math.max(0.02, Math.min(60, (g.s0 * dist) / g.d0));
      const k = ns / g.s0;
      this.s = ns;
      this.tx = cx - (g.cx0 - g.tx0) * k;
      this.ty = cy - (g.cy0 - g.ty0) * k;
      if (Math.abs(dist - g.d0) > 10 || Math.hypot(cx - g.cx0, cy - g.cy0) > 10) g.moved = true;
      this.scheduleMain();
      this.scheduleOverlay();
      return;
    }
    if (e.pointerId !== this.activeId) {
      if (e.pointerType !== 'touch') {
        this.hover = this.toDoc(x, y);
        if (useStore.getState().ui.tool === 'eraser' || this.curve) this.scheduleOverlay();
      }
      return;
    }
    const p = this.toDoc(x, y);
    this.hover = p;
    switch (g.kind) {
      case 'pan':
        this.tx = g.tx + (x - g.sx);
        this.ty = g.ty + (y - g.sy);
        this.scheduleMain();
        this.scheduleOverlay();
        return;
      case 'stroke': {
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const list = evs.length ? evs : [e];
        for (const ev of list) {
          const q = this.toDoc(ev.clientX - rect.left, ev.clientY - rect.top);
          const last = g.points[g.points.length - 1];
          if (Math.hypot(q.x - last[0], q.y - last[1]) < 0.6 / this.s) continue;
          g.points.push([q.x, q.y, g.erase ? 0.5 : this.pressureOf(ev)]);
        }
        this.scheduleOverlay();
        return;
      }
      case 'objErase':
        this.eraseAt(p);
        this.scheduleOverlay();
        return;
      case 'shape':
        g.b = this.snap(p);
        this.scheduleOverlay();
        return;
      case 'marquee':
        g.b = p;
        this.scheduleOverlay();
        return;
      case 'move': {
        let dx = p.x - g.start.x;
        let dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * this.s < 4) return;
        g.moved = true;
        const ui = useStore.getState().ui;
        if (ui.snap) {
          dx = Math.round(dx / ui.gridStep) * ui.gridStep;
          dy = Math.round(dy / ui.gridStep) * ui.gridStep;
        }
        const ddx = dx - (g.last.x - g.start.x);
        const ddy = dy - (g.last.y - g.start.y);
        if (ddx || ddy) {
          moveSelection(ddx, ddy);
          g.last = { x: g.start.x + dx, y: g.start.y + dy };
        }
        return;
      }
      case 'scale':
        this.applyScale(g, p);
        return;
      case 'rotate': {
        let a = Math.atan2(p.y - g.c.y, p.x - g.c.x) - g.a0;
        const deg = (a * 180) / Math.PI;
        const snapDeg = Math.round(deg / 15) * 15;
        if (Math.abs(deg - snapDeg) < 3) a = (snapDeg * Math.PI) / 180;
        const delta = about(rotate(a), g.c.x, g.c.y);
        commitDoc((objs) => {
          for (const o of objs) {
            const s0 = g.starts.get(o.id);
            if (s0) o.transform = mul(delta, s0);
          }
        });
        return;
      }
      case 'node':
        this.nodeMove(g, p);
        return;
      case 'curveDrag': {
        if (!this.curve) return;
        const n = this.curve[g.node];
        const q = this.snap(p);
        if (Math.hypot(q.x - n.x, q.y - n.y) * this.s < 4) {
          delete n.hout;
          delete n.hin;
        } else {
          n.hout = { x: q.x, y: q.y };
          n.hin = { x: 2 * n.x - q.x, y: 2 * n.y - q.y };
          if (g.node === 0) delete n.hin;
        }
        this.scheduleOverlay();
        return;
      }
      case 'charMove': {
        const t = this.doc()?.objects.find((o) => o.id === g.textId);
        if (!t) return;
        const inv = invert([t.transform[0], t.transform[1], t.transform[2], t.transform[3], 0, 0]);
        const dl = apply(inv, p.x - g.start.x, p.y - g.start.y);
        commitDoc((objs) => {
          const o = objs.find((x) => x.id === g.textId);
          if (!o || o.type !== 'text') return;
          const cur = o.charAdj[String(g.index)] ?? { dx: 0, dy: 0, rot: 0, scale: 1 };
          o.charAdj[String(g.index)] = { ...cur, dx: Math.round(g.base.dx + dl.x), dy: Math.round(g.base.dy + dl.y) };
        });
        return;
      }
    }
  };

  private applyScale(g: Extract<Gesture, { kind: 'scale' }>, p: Vec) {
    const ui = useStore.getState().ui;
    const Binv = invert(g.frame.B);
    const lp = apply(Binv, p.x, p.y);
    const a = g.anchor;
    const h0 = g.h0;
    let sx = Math.abs(h0.x - a.x) < 1e-6 ? 1 : (lp.x - a.x) / (h0.x - a.x);
    let sy = Math.abs(h0.y - a.y) < 1e-6 ? 1 : (lp.y - a.y) / (h0.y - a.y);
    const corner = g.handle.length === 2;
    if (g.handle === 'n' || g.handle === 's') sx = 1;
    if (g.handle === 'e' || g.handle === 'w') sy = 1;
    if (corner && ui.keepRatio) {
      const vx = h0.x - a.x;
      const vy = h0.y - a.y;
      const k = ((lp.x - a.x) * vx + (lp.y - a.y) * vy) / (vx * vx + vy * vy || 1);
      sx = sy = k;
    }
    const clamp = (v: number) => (Math.abs(v) < 0.02 ? (v < 0 ? -0.02 : 0.02) : v);
    sx = clamp(sx);
    sy = clamp(sy);
    const delta = mul(g.frame.B, mul(about(scaleM(sx, sy), a.x, a.y), Binv));
    commitDoc((objs) => {
      for (const o of objs) {
        const s0 = g.starts.get(o.id);
        if (s0) o.transform = mul(delta, s0);
      }
    });
  }

  private onUp = (e: PointerEvent) => {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const g = this.gesture;
    const wasPointer = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (g.kind === 'pinch') {
      const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (touches.length < 2) {
        // 2 本指タップ = 取り消し
        if (!g.moved && performance.now() - g.t0 < 300 && wasPointer?.type === 'touch') undo();
        this.gesture = { kind: 'none' };
        this.pointers.clear();
      }
      return;
    }
    if (e.pointerId !== this.activeId) return;
    this.activeId = null;
    const p = this.toDoc(x, y);
    const isTap = performance.now() - this.downAt.t < 300 && Math.hypot(x - this.downAt.x, y - this.downAt.y) < 8;
    const isDouble = isTap && performance.now() - this.lastTap.t < 380 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 24;
    if (isTap) this.lastTap = { t: performance.now(), x, y };
    this.gesture = { kind: 'none' };
    switch (g.kind) {
      case 'stroke':
        this.commitStroke(g);
        break;
      case 'objErase':
        endGesture();
        break;
      case 'shape':
        this.commitShape(g.a, this.snap(p));
        break;
      case 'marquee':
        this.finishMarquee(g.a, g.b);
        break;
      case 'move':
        endGesture();
        if (isDouble && g.tapId) this.onDoubleTapObj(g.tapId);
        break;
      case 'scale':
      case 'rotate':
      case 'node':
      case 'charMove':
        endGesture();
        if (g.kind === 'node' && isDouble) this.toggleNodeSmooth(g.objId, g.index);
        break;
      case 'curveDrag':
        if (isDouble && this.curve && g.node === this.curve.length - 1 && this.curve.length > 2) {
          // 同じ位置のダブルタップで確定
          this.curve.pop();
          this.finishCurve();
        }
        break;
    }
    this.scheduleOverlay();
  };

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (e.pointerId === this.activeId || this.gesture.kind === 'pinch') {
      this.activeId = null;
      if (this.gesture.kind === 'stroke') {
        // 途中で中断されても、描いた線は残す
        this.commitStroke(this.gesture);
      } else this.abortActive();
      this.gesture = { kind: 'none' };
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.overlay.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    } else {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this.scheduleMain();
      this.scheduleOverlay();
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && k === 'd') {
      e.preventDefault();
      duplicateSelection();
    } else if (mod && k === 'g') {
      e.preventDefault();
      if (e.shiftKey) ungroupSelection();
      else groupSelection();
    } else if (k === 'delete' || k === 'backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (k === 'escape') {
      if (this.curve) this.finishCurve();
      else setUi({ selection: [], charEdit: null, nodeSel: null });
    } else if (k === 'enter') {
      if (this.curve) this.finishCurve();
    } else if (k === ' ') {
      this.spaceHeld = true;
    } else if (k.startsWith('arrow') && useStore.getState().ui.selection.length) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 5;
      moveSelection(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    } else if (!mod) {
      const map: Record<string, string> = { v: 'select', p: 'pen', e: 'eraser', h: 'hand', l: 'line', c: 'curve', o: 'ellipse', r: 'rect', a: 'node', t: 'text' };
      if (map[k]) setUi({ tool: map[k] as any });
      if (k === '0') this.fit();
      if (k === '=' || k === '+') this.zoomBy(1.25);
      if (k === '-') this.zoomBy(0.8);
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') this.spaceHeld = false;
  };

  // ===== 各ツールの確定処理 =====

  private commitStroke(g: Extract<Gesture, { kind: 'stroke' }>) {
    const st = useStore.getState();
    const d = this.doc();
    if (!d || g.points.length === 0) return;
    const ui = st.ui;
    const pen = g.erase
      ? { ...ui.pen, size: ui.eraserSize, thinning: 0, taperStart: 0, taperEnd: 0, usePressure: false }
      : { ...ui.pen, usePressure: ui.pen.usePressure && g.pressure };
    const obj: StrokeObj = {
      id: uid(),
      type: 'stroke',
      transform: [1, 0, 0, 1, 0, 0],
      points: g.points.map(([x, y, p]) => [round2(x), round2(y), Math.round(p * 1000) / 1000]),
      pen,
      ...(g.erase ? { erase: true } : {}),
      ...(d.kind === 'logo' || d.kind === 'composite' ? { style: defaultStyle(ui.decoColor) } : {}),
    };
    commitDoc((objs) => {
      objs.push(obj);
    });
  }

  private commitShape(a: Vec, b: Vec) {
    const st = useStore.getState();
    const d = this.doc();
    if (!d) return;
    if (Math.hypot(b.x - a.x, b.y - a.y) * this.s < 4) return;
    const ui = st.ui;
    const kind = ui.tool as 'line' | 'rect' | 'ellipse' | 'polygon';
    const { nodes, closed } = makeShapeNodes(kind, a, b, ui.polygonSides);
    const fill = closed && ui.shapeFill;
    const obj: PathObj = {
      id: uid(),
      type: 'path',
      transform: [1, 0, 0, 1, 0, 0],
      nodes,
      closed,
      fill,
      strokeWidth: fill ? 0 : ui.shapeStroke,
      shape: kind,
      ...(d.kind === 'logo' || d.kind === 'composite' ? { style: defaultStyle(ui.decoColor) } : {}),
    };
    commitDoc((objs) => {
      objs.push(obj);
    });
  }

  private finishMarquee(a: Vec, b: Vec) {
    const st = useStore.getState();
    const d = this.doc();
    if (!d || !st.data) return;
    if (Math.hypot(b.x - a.x, b.y - a.y) * this.s < 6) return;
    const env = envOf(st.data);
    const r = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    const ids = d.objects
      .filter((o) => !o.locked && !o.hidden && !(o.type === 'stroke' && o.erase))
      .filter((o) => {
        const bb = objBox(o, env);
        return boxValid(bb) && bb.minX < r.maxX && bb.maxX > r.minX && bb.minY < r.maxY && bb.maxY > r.minY;
      })
      .map((o) => o.id);
    const ui = st.ui;
    setUi({ selection: ui.multiSelect ? Array.from(new Set([...ui.selection, ...ids])) : ids });
  }

  private eraseAt(p: Vec) {
    const st = useStore.getState();
    const d = this.doc();
    if (!d || !st.data) return;
    const hits = hitAll(d.objects, p, Math.max(st.ui.eraserSize / 2, 6 / this.s), envOf(st.data));
    if (!hits.length) return;
    const ids = new Set(hits.map((h) => h.id));
    commitDoc((objs) => {
      for (let i = objs.length - 1; i >= 0; i--) if (ids.has(objs[i].id)) objs.splice(i, 1);
    });
    setUi({ selection: st.ui.selection.filter((i) => !ids.has(i)) });
  }

  private createText(p: Vec) {
    const st = useStore.getState();
    const d = this.doc();
    if (!d) return;
    const size = Math.round(Math.max(40, Math.min(d.frame.w, d.frame.h) * 0.16));
    const t: TextObj = {
      id: uid(),
      type: 'text',
      transform: [1, 0, 0, 1, Math.round(p.x), Math.round(p.y - size / 2)],
      text: 'タイトル',
      fontSize: size,
      letterSpacing: 0,
      lineHeight: 1.2,
      vertical: false,
      charAdj: {},
      style: defaultStyle(st.ui.decoColor),
    };
    commitDoc((objs) => {
      objs.push(t);
    });
    setUi({ selection: [t.id], tool: 'select', rightTab: 'props', rightOpen: true });
  }

  private onDoubleTapObj(id: string) {
    const d = this.doc();
    const o = d?.objects.find((x) => x.id === id);
    if (!o) return;
    if (o.type === 'text') setUi({ charEdit: { id, index: null }, rightTab: 'props' });
    else if (o.type === 'path') setUi({ tool: 'node', selection: [id], nodeSel: null });
  }

  // ===== 曲線ツール =====

  private curveDown(p: Vec, sx: number, sy: number) {
    const q = this.snap(p);
    if (this.curve && this.curve.length > 2) {
      const first = this.toScreen(this.curve[0]);
      if (Math.hypot(first.x - sx, first.y - sy) < 16) {
        this.finishCurve(true);
        return;
      }
    }
    if (!this.curve) this.curve = [];
    this.curve.push({ x: q.x, y: q.y });
    setUi({ curvePending: this.curve.length });
    this.gesture = { kind: 'curveDrag', node: this.curve.length - 1 };
    this.scheduleOverlay();
  }

  finishCurve(close = false) {
    const nodes = this.curve;
    this.curve = null;
    if (useStore.getState().ui.curvePending) setUi({ curvePending: 0 });
    if (!nodes || nodes.length < 2) {
      this.scheduleOverlay();
      return;
    }
    const st = useStore.getState();
    const d = this.doc();
    if (!d) return;
    if (!close) {
      const last = nodes[nodes.length - 1];
      delete last.hout;
    }
    const fill = close && st.ui.shapeFill;
    const obj: PathObj = {
      id: uid(),
      type: 'path',
      transform: [1, 0, 0, 1, 0, 0],
      nodes: nodes.map((n) => ({ ...n })),
      closed: close,
      fill,
      strokeWidth: fill ? 0 : st.ui.shapeStroke,
      shape: 'curve',
      ...(d.kind === 'logo' || d.kind === 'composite' ? { style: defaultStyle(st.ui.decoColor) } : {}),
    };
    commitDoc((objs) => {
      objs.push(obj);
    });
    this.scheduleOverlay();
  }

  // ===== 制御点ツール =====

  private nodeDown(p: Vec, sx: number, sy: number, tol: number): boolean {
    const sel = selectedObjs();
    if (sel.length !== 1 || sel[0].type !== 'path') return false;
    const o = sel[0];
    const m = mul(this.viewCss, o.transform);
    const r = 14;
    // ハンドル → 点 の順に探す
    for (let i = 0; i < o.nodes.length; i++) {
      const n = o.nodes[i];
      for (const part of ['hin', 'hout'] as const) {
        const h = n[part];
        if (!h) continue;
        const q = apply(m, h.x, h.y);
        if (Math.hypot(q.x - sx, q.y - sy) < r) {
          beginGesture();
          this.gesture = { kind: 'node', objId: o.id, index: i, part, startNodes: o.nodes, start: p };
          setUi({ nodeSel: i });
          return true;
        }
      }
    }
    for (let i = 0; i < o.nodes.length; i++) {
      const q = apply(m, o.nodes[i].x, o.nodes[i].y);
      if (Math.hypot(q.x - sx, q.y - sy) < r) {
        beginGesture();
        this.gesture = { kind: 'node', objId: o.id, index: i, part: 'node', startNodes: o.nodes, start: p };
        setUi({ nodeSel: i });
        return true;
      }
    }
    // 線上をタップしたら点を追加
    const lp = apply(invert(o.transform), p.x, p.y);
    const ins = this.findInsert(o, lp, tol / matScale(o.transform));
    if (ins) {
      commitDoc((objs) => {
        const t = objs.find((x) => x.id === o.id);
        if (t && t.type === 'path') t.nodes = ins.nodes;
      });
      setUi({ nodeSel: ins.index });
      return true;
    }
    return false;
  }

  private findInsert(o: PathObj, lp: Vec, tol: number): { nodes: PathNode[]; index: number } | null {
    const segs = segments(o.nodes, o.closed);
    let best = { d: Infinity, seg: -1, t: 0 };
    segs.forEach(([p0, p1, p2, p3], si) => {
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const u = 1 - t;
        const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
        const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
        const d = Math.hypot(x - lp.x, y - lp.y);
        if (d < best.d) best = { d, seg: si, t };
      }
    });
    if (best.seg < 0 || best.d > tol + o.strokeWidth / 2 || best.t < 0.02 || best.t > 0.98) return null;
    const [p0, p1, p2, p3, isLine] = segs[best.seg];
    const t = best.t;
    const L = (a: Vec, b: Vec) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const nodes = o.nodes.map((n) => ({ ...n }));
    const ia = best.seg;
    const ib = (best.seg + 1) % nodes.length;
    let newNode: PathNode;
    if (isLine) newNode = L(p0, p3);
    else {
      const a = L(p0, p1);
      const b = L(p1, p2);
      const c = L(p2, p3);
      const d = L(a, b);
      const e = L(b, c);
      const f = L(d, e);
      nodes[ia].hout = a;
      nodes[ib].hin = c;
      newNode = { x: f.x, y: f.y, hin: d, hout: e };
    }
    nodes.splice(ia + 1, 0, newNode);
    return { nodes, index: ia + 1 };
  }

  private nodeMove(g: Extract<Gesture, { kind: 'node' }>, p: Vec) {
    const sel = this.doc()?.objects.find((o) => o.id === g.objId);
    if (!sel || sel.type !== 'path') return;
    const inv = invert(sel.transform);
    const q = this.snap(p);
    const lp = apply(inv, q.x, q.y);
    const l0 = apply(inv, g.start.x, g.start.y);
    const dx = lp.x - l0.x;
    const dy = lp.y - l0.y;
    const n0 = g.startNodes[g.index];
    const nn: PathNode = { ...n0 };
    if (g.part === 'node') {
      const ui = useStore.getState().ui;
      const tx = ui.snap ? lp.x - n0.x : dx;
      const ty = ui.snap ? lp.y - n0.y : dy;
      nn.x = n0.x + tx;
      nn.y = n0.y + ty;
      if (n0.hin) nn.hin = { x: n0.hin.x + tx, y: n0.hin.y + ty };
      if (n0.hout) nn.hout = { x: n0.hout.x + tx, y: n0.hout.y + ty };
    } else {
      const other = g.part === 'hin' ? 'hout' : 'hin';
      const h0 = n0[g.part]!;
      const h = { x: h0.x + dx, y: h0.y + dy };
      nn[g.part] = h;
      const o0 = n0[other];
      if (o0) {
        // 滑らかな点（ハンドルが一直線）ならもう片方も追従
        const a1 = Math.atan2(h0.y - n0.y, h0.x - n0.x);
        const a2 = Math.atan2(o0.y - n0.y, o0.x - n0.x);
        let diff = Math.abs(a1 - a2) % (2 * Math.PI);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (Math.abs(diff - Math.PI) < 0.08) {
          const len = Math.hypot(o0.x - n0.x, o0.y - n0.y);
          const a = Math.atan2(h.y - n0.y, h.x - n0.x) + Math.PI;
          nn[other] = { x: n0.x + Math.cos(a) * len, y: n0.y + Math.sin(a) * len };
        }
      }
    }
    commitDoc((objs) => {
      const t = objs.find((x) => x.id === g.objId);
      if (!t || t.type !== 'path') return;
      const nodes = g.startNodes.map((n) => ({ ...n }));
      nodes[g.index] = nn;
      t.nodes = nodes;
    });
  }

  private toggleNodeSmooth(objId: string, index: number) {
    commitDoc((objs) => {
      const t = objs.find((x) => x.id === objId);
      if (!t || t.type !== 'path') return;
      const n = t.nodes[index];
      if (n.hin || n.hout) {
        delete n.hin;
        delete n.hout;
        return;
      }
      const len = t.nodes.length;
      const prev = t.nodes[(index - 1 + len) % len];
      const next = t.nodes[(index + 1) % len];
      const hasPrev = index > 0 || t.closed;
      const hasNext = index < len - 1 || t.closed;
      const a = hasPrev ? prev : n;
      const b = hasNext ? next : n;
      const tx = (b.x - a.x) / 6;
      const ty = (b.y - a.y) / 6;
      if (hasPrev) n.hin = { x: n.x - tx, y: n.y - ty };
      if (hasNext) n.hout = { x: n.x + tx, y: n.y + ty };
    });
  }

  /** 選択中の点を削除 */
  deleteNode() {
    const ui = useStore.getState().ui;
    const sel = selectedObjs();
    if (sel.length !== 1 || sel[0].type !== 'path' || ui.nodeSel === null) return;
    const idx = ui.nodeSel;
    const id = sel[0].id;
    const count = sel[0].nodes.length;
    if (count <= 2) return;
    commitDoc((objs) => {
      const t = objs.find((x) => x.id === id);
      if (t && t.type === 'path') t.nodes.splice(idx, 1);
    });
    setUi({ nodeSel: null });
  }
}

function routeKey(r: Route) {
  return r.screen === 'glyph' ? `g${r.cp}` : `${r.screen}:${r.id}`;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

