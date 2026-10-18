import { useEffect, useRef } from 'react';
import { Copy, Trash, ImagePlus, Spline, RotateCcw, Image as ImageIcon, Plus } from 'lucide-react';
import { useStore, setUi, commit, commitDoc, beginGesture, endGesture, setRoute, docOf, toast } from '../store/store';
import { Slider, Toggle, Segmented, ColorField, NumberField, FlipHIcon, FlipVIcon } from './controls';
import {
  selectedObjs,
  selectionBox,
  envOf,
  flipH,
  flipV,
  duplicateSelection,
  deleteSelection,
  convertStrokesToCurves,
  transformSelection,
} from '../editor/actions';
import { activeEditor } from '../editor/controller';
import type { Obj, Style, TextObj, Glyph, Mat, Logo, Composite, Part } from '../model/types';
import { defaultStyle, defaultMetrics, INK, newGlyph } from '../model/defaults';
import { translate, about, scale as scaleM, rotate, mul } from '../geom/matrix';
import { layoutText } from '../render/textLayout';
import { renderStyled } from '../render/canvas';
import { importImageAsset } from './imageImport';
import { isCustomChar } from '../render/textLayout';
import { uid } from '../model/ids';
import { objectsBox, boxValid } from '../geom/bounds';
import { charOf, unicodeLabel, setOfChar, KANJI_SET_ID } from '../model/charsets';

const slide = { onStart: beginGesture, onEnd: endGesture };

export function PropsPanel() {
  const route = useStore((s) => s.route);
  const selection = useStore((s) => s.ui.selection);
  useStore((s) => s.data);
  const sel = selectedObjs();
  if (selection.length === 0 || sel.length === 0) {
    if (route.screen === 'glyph') return <GlyphProps cp={route.cp} />;
    if (route.screen === 'logo') return <LogoProps id={route.id} />;
    if (route.screen === 'composite') return <CompositeProps id={route.id} />;
    return <PartProps id={route.id} />;
  }
  return <SelectionProps sel={sel} />;
}

function updateSelected(fn: (o: Obj) => void) {
  const ids = new Set(useStore.getState().ui.selection);
  commitDoc((objs) => {
    for (const o of objs) if (ids.has(o.id)) fn(o);
  });
}

// ===== 選択中のオブジェクト =====

function SelectionProps({ sel }: { sel: Obj[] }) {
  const route = useStore((s) => s.route);
  const ui = useStore((s) => s.ui);
  const box = selectionBox();
  const single = sel.length === 1 ? sel[0] : null;
  const styled = route.screen === 'logo' || route.screen === 'composite' || (route.screen === 'part' && sel.some((o) => o.style));
  const rot = single ? Math.round((Math.atan2(single.transform[1], single.transform[0]) * 180) / Math.PI) : 0;

  return (
    <div>
      <div className="section">
        <h4>
          {sel.length} 個を選択中{single?.locked ? '（ロック中）' : ''}
        </h4>
        {box && (
          <div className="row wrap" style={{ gap: 10, marginBottom: 10 }}>
            <NumberField label="X" value={Math.round(box.minX)} onChange={(v) => transformSelection(() => translate(v - box.minX, 0))} />
            <NumberField label="Y" value={Math.round(box.minY)} onChange={(v) => transformSelection(() => translate(0, v - box.minY))} />
            <NumberField
              label="幅"
              value={Math.round(box.maxX - box.minX)}
              min={1}
              onChange={(v) => {
                const w = box.maxX - box.minX || 1;
                const k = v / w;
                transformSelection(() => about(scaleM(k, ui.keepRatio ? k : 1), box.minX, box.minY));
              }}
            />
            <NumberField
              label="高さ"
              value={Math.round(box.maxY - box.minY)}
              min={1}
              onChange={(v) => {
                const h = box.maxY - box.minY || 1;
                const k = v / h;
                transformSelection(() => about(scaleM(ui.keepRatio ? k : 1, k), box.minX, box.minY));
              }}
            />
          </div>
        )}
        {single && (
          <div className="row" style={{ marginBottom: 10 }}>
            <NumberField label="回転" suffix="°" value={rot} onChange={(v) => transformSelection((cx, cy) => about(rotate(((v - rot) * Math.PI) / 180), cx, cy))} />
          </div>
        )}
        <div className="row wrap">
          <button className="btn sm" onClick={flipH}>
            <FlipHIcon size={16} />
            左右反転
          </button>
          <button className="btn sm" onClick={flipV}>
            <FlipVIcon size={16} />
            上下反転
          </button>
          <button className="btn sm" onClick={() => duplicateSelection()}>
            <Copy size={16} />
            複製
          </button>
          <button className="btn sm danger" onClick={deleteSelection}>
            <Trash size={16} />
            削除
          </button>
        </div>
      </div>

      {single?.type === 'stroke' && !single.erase && <StrokeProps o={single} />}
      {sel.length > 1 && sel.every((o) => o.type === 'stroke' && !o.erase) && <MultiStrokeProps sel={sel} />}
      {single?.type === 'path' && <PathProps o={single} />}
      {single?.type === 'text' && <TextProps o={single} />}
      {single?.type === 'logoRef' && <LogoRefProps o={single} />}
      {styled && single?.type !== 'logoRef' && <StyleProps sel={sel} />}
      {styled && single?.type === 'logoRef' && <StyleProps sel={sel} effectsOnly />}
    </div>
  );
}

function StrokeProps({ o }: { o: Extract<Obj, { type: 'stroke' }> }) {
  const set = (p: Partial<typeof o.pen>) =>
    updateSelected((x) => {
      if (x.type === 'stroke') x.pen = { ...x.pen, ...p };
    });
  return (
    <div className="section">
      <h4>手書き線</h4>
      <Slider label="太さ" value={o.pen.size} min={2} max={200} onChange={(v) => set({ size: v })} {...slide} />
      <Toggle label="記録した筆圧を使う" checked={o.pen.usePressure} onChange={(v) => set({ usePressure: v })} />
      <Slider label="筆圧による強弱" value={o.pen.thinning} min={0} max={0.95} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ thinning: v })} {...slide} />
      <Slider label="線の滑らかさ" value={o.pen.smoothing} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ smoothing: v })} {...slide} />
      <Slider label="入りの細さ" value={o.pen.taperStart} min={0} max={300} step={5} onChange={(v) => set({ taperStart: v })} {...slide} />
      <Slider label="抜きの細さ" value={o.pen.taperEnd} min={0} max={300} step={5} onChange={(v) => set({ taperEnd: v })} {...slide} />
      <button className="btn sm block" onClick={convertStrokesToCurves}>
        <Spline size={16} />
        曲線に変換（制御点で編集）
      </button>
      <p className="note">手書きの元データ（点と筆圧）は保存されているので、後から何度でも太さや滑らかさを変えられます。</p>
    </div>
  );
}

function MultiStrokeProps({ sel }: { sel: Obj[] }) {
  const first = sel[0] as Extract<Obj, { type: 'stroke' }>;
  return (
    <div className="section">
      <h4>手書き線（まとめて）</h4>
      <Slider
        label="太さ"
        value={first.pen.size}
        min={2}
        max={200}
        onChange={(v) =>
          updateSelected((x) => {
            if (x.type === 'stroke') x.pen = { ...x.pen, size: v };
          })
        }
        {...slide}
      />
      <button className="btn sm block" onClick={convertStrokesToCurves}>
        <Spline size={16} />
        曲線に変換
      </button>
    </div>
  );
}

function PathProps({ o }: { o: Extract<Obj, { type: 'path' }> }) {
  const tool = useStore((s) => s.ui.tool);
  const nodeSel = useStore((s) => s.ui.nodeSel);
  const set = (fn: (x: Extract<Obj, { type: 'path' }>) => void) =>
    updateSelected((x) => {
      if (x.type === 'path') fn(x);
    });
  return (
    <div className="section">
      <h4>図形・曲線</h4>
      {o.nodes.length > 2 && <Toggle label="閉じた形にする" checked={o.closed} onChange={(v) => set((x) => (x.closed = v))} />}
      {o.closed && <Toggle label="中を塗る" checked={o.fill} onChange={(v) => set((x) => (x.fill = v))} />}
      <Slider label="線の太さ（0 で線なし）" value={o.strokeWidth} min={0} max={200} onChange={(v) => set((x) => (x.strokeWidth = v))} {...slide} />
      {!o.fill && o.strokeWidth === 0 && <p className="note warn">塗りも線もないため、表示・出力されません。</p>}
      {tool !== 'node' ? (
        <button className="btn sm block" onClick={() => setUi({ tool: 'node', nodeSel: null })}>
          制御点を編集
        </button>
      ) : (
        <button className="btn sm block" disabled={nodeSel === null || o.nodes.length <= 2} onClick={() => activeEditor?.deleteNode()}>
          選択した点を削除
        </button>
      )}
    </div>
  );
}

function TextProps({ o }: { o: TextObj }) {
  const data = useStore((s) => s.data!);
  const charEdit = useStore((s) => s.ui.charEdit);
  const env = envOf(data);
  const set = (fn: (x: TextObj) => void) =>
    updateSelected((x) => {
      if (x.type === 'text') fn(x);
    });
  const chars = Array.from(o.text)
    .map((ch, index) => ({ ch, index }))
    .filter((c) => c.ch.trim());
  const customCount = chars.filter((c) => isCustomChar(c.ch, env)).length;
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (o.text === 'タイトル') ta.current?.select();
  }, [o.id]);
  const adjIndex = charEdit?.id === o.id ? charEdit.index : null;
  const adj = adjIndex !== null ? o.charAdj[String(adjIndex)] ?? { dx: 0, dy: 0, rot: 0, scale: 1 } : null;
  const setAdj = (p: Partial<{ dx: number; dy: number; rot: number; scale: number }>) =>
    set((x) => {
      if (adjIndex === null) return;
      const cur = x.charAdj[String(adjIndex)] ?? { dx: 0, dy: 0, rot: 0, scale: 1 };
      x.charAdj[String(adjIndex)] = { ...cur, ...p };
    });
  return (
    <div className="section">
      <h4>文字</h4>
      <div className="field">
        <textarea
          ref={ta}
          className="input"
          value={o.text}
          rows={2}
          onFocus={beginGesture}
          onBlur={endGesture}
          onChange={(e) => {
            const v = e.target.value;
            set((x) => {
              x.text = v;
              // 文字が減ったら、範囲外の個別調整を消す
              const n = Array.from(v).length;
              for (const k of Object.keys(x.charAdj)) if (Number(k) >= n) delete x.charAdj[k];
            });
          }}
        />
      </div>
      <Slider label="文字の大きさ" value={o.fontSize} min={8} max={1200} onChange={(v) => set((x) => (x.fontSize = v))} {...slide} />
      <Slider label="文字間" value={o.letterSpacing} min={-300} max={600} onChange={(v) => set((x) => (x.letterSpacing = v))} {...slide} />
      <Slider label="行間" value={o.lineHeight} min={0.5} max={3} step={0.05} format={(v) => `${v.toFixed(2)} 倍`} onChange={(v) => set((x) => (x.lineHeight = v))} {...slide} />
      <Segmented
        value={o.vertical ? 'v' : 'h'}
        onChange={(v) => set((x) => (x.vertical = v === 'v'))}
        options={[
          { value: 'h', label: '横書き' },
          { value: 'v', label: '縦書き' },
        ]}
      />
      <div style={{ marginTop: 12 }}>
        <span className="field-label">使われている文字（{customCount} / {chars.length} 文字が自作）</span>
        <div className="legend">
          <span>
            <i style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }} />
            自作の字形
          </span>
          <span>
            <i style={{ border: '1px dashed var(--accent-2)' }} />
            代用表示（端末のフォント）
          </span>
        </div>
        <div className="chips">
          {chars.map(({ ch, index }) => {
            const custom = isCustomChar(ch, env);
            return (
              <button
                key={index}
                className={'chip ' + (custom ? 'custom' : 'fallback') + (adjIndex === index ? ' on' : '')}
                title={custom ? `${ch}：自作の字形` : `${ch}：代用表示中。タップで個別調整`}
                onClick={() => setUi({ charEdit: { id: o.id, index } })}
              >
                {ch}
              </button>
            );
          })}
        </div>
        {chars.some((c) => !isCustomChar(c.ch, env)) && (
          <p className="note">
            代用文字は画面上で点線の枠で区別されます（出力には含みません）。PNG・JPEG ではそのまま画像になり、SVG ではその文字だけラスター画像として埋め込まれます。フォント（OTF）には入りません。
          </p>
        )}
      </div>
      {adjIndex !== null && adj && (
        <div className="section">
          <h4>
            「{Array.from(o.text)[adjIndex]}」だけを調整
            {!isCustomChar(Array.from(o.text)[adjIndex] ?? '', env) && (
              <button
                className="btn sm"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  const ch = Array.from(o.text)[adjIndex];
                  if (!ch) return;
                  const cp = ch.codePointAt(0)!;
                  // 文字セットに無い文字（漢字など）は「漢字・追加」に登録する
                  if (setOfChar(ch) === KANJI_SET_ID && !useStore.getState().data!.project.customChars.includes(ch))
                    commit((d) => {
                      d.project.customChars.push(ch);
                    });
                  setRoute({ screen: 'glyph', cp });
                  toast(`「${ch}」を作ると、このロゴの代用文字が自動で差し替わります`);
                }}
              >
                この文字を作る
              </button>
            )}
          </h4>
          <Slider label="横の位置" value={adj.dx} min={-o.fontSize} max={o.fontSize} onChange={(v) => setAdj({ dx: v })} {...slide} />
          <Slider label="縦の位置" value={adj.dy} min={-o.fontSize} max={o.fontSize} onChange={(v) => setAdj({ dy: v })} {...slide} />
          <Slider label="回転" value={adj.rot} min={-180} max={180} unit="°" onChange={(v) => setAdj({ rot: v })} {...slide} />
          <Slider label="大きさ" value={adj.scale} min={0.2} max={3} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setAdj({ scale: v })} {...slide} />
          <div className="row">
            <button
              className="btn sm"
              onClick={() =>
                set((x) => {
                  delete x.charAdj[String(adjIndex)];
                })
              }
            >
              <RotateCcw size={14} />
              この文字を元に戻す
            </button>
            <button className="btn sm ghost" onClick={() => setUi({ charEdit: null })}>
              閉じる
            </button>
          </div>
          <p className="note">キャンバス上でも、文字をドラッグして位置を動かせます。</p>
        </div>
      )}
      {adjIndex === null && (
        <p className="note">文字を個別に動かすには、上の文字をタップするか、キャンバスの文字をダブルタップします。</p>
      )}
    </div>
  );
}

function LogoRefProps({ o }: { o: Extract<Obj, { type: 'logoRef' }> }) {
  const logos = useStore((s) => s.data!.project.logos);
  return (
    <div className="section">
      <h4>配置したロゴ</h4>
      <select
        className="input"
        value={o.logoId}
        onChange={(e) =>
          updateSelected((x) => {
            if (x.type === 'logoRef') x.logoId = e.target.value;
          })
        }
      >
        {logos.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
        {!logos.some((l) => l.id === o.logoId) && <option value={o.logoId}>（削除されたロゴ）</option>}
      </select>
      <p className="note">ロゴの中身を直すと、ここにも反映されます。</p>
      <button className="btn sm" onClick={() => setRoute({ screen: 'logo', id: o.logoId })}>
        このロゴを編集
      </button>
    </div>
  );
}

// ===== 装飾 =====

function StyleProps({ sel, effectsOnly }: { sel: Obj[]; effectsOnly?: boolean }) {
  const st: Style = sel[0].style ?? defaultStyle();
  const set = (fn: (s: Style) => void) =>
    updateSelected((x) => {
      const s = (x.style ? x.style : defaultStyle()) as Style;
      fn(s);
      x.style = s;
    });
  return (
    <div className="section">
      <h4>装飾{sel.length > 1 ? `（${sel.length} 個まとめて）` : ''}</h4>
      {!effectsOnly && (
        <>
          <Segmented
            value={st.fill.kind}
            onChange={(v) =>
              set((s) => {
                const base = s.fill.kind === 'solid' ? s.fill.color : s.fill.from;
                s.fill = v === 'solid' ? { kind: 'solid', color: base } : { kind: 'linear', from: base, to: '#8e7ce0', angle: 90 };
              })
            }
            options={[
              { value: 'solid', label: '単色' },
              { value: 'linear', label: 'グラデーション' },
            ]}
          />
          <div style={{ height: 10 }} />
          {st.fill.kind === 'solid' ? (
            <ColorField label="色" alpha value={st.fill.color} onChange={(v) => set((s) => (s.fill = { kind: 'solid', color: v }))} />
          ) : (
            <>
              <ColorField label="開始色" value={st.fill.from} onChange={(v) => set((s) => s.fill.kind === 'linear' && (s.fill.from = v))} />
              <ColorField label="終了色" value={st.fill.to} onChange={(v) => set((s) => s.fill.kind === 'linear' && (s.fill.to = v))} />
              <Slider label="向き" value={st.fill.angle} min={0} max={360} unit="°" onChange={(v) => set((s) => s.fill.kind === 'linear' && (s.fill.angle = v))} {...slide} />
            </>
          )}
        </>
      )}
      <Toggle label={effectsOnly ? 'ロゴ全体を縁取る' : '縁取り'} checked={st.outline.on} onChange={(v) => set((s) => (s.outline.on = v))} />
      {st.outline.on && (
        <>
          <ColorField value={st.outline.color} onChange={(v) => set((s) => (s.outline.color = v))} />
          <Slider label="縁取りの太さ" value={st.outline.width} min={1} max={80} onChange={(v) => set((s) => (s.outline.width = v))} {...slide} />
        </>
      )}
      <Toggle label="影" checked={st.shadow.on} onChange={(v) => set((s) => (s.shadow.on = v))} />
      {st.shadow.on && (
        <>
          <ColorField value={st.shadow.color} alpha onChange={(v) => set((s) => (s.shadow.color = v))} />
          <Slider label="ぼかし" value={st.shadow.blur} min={0} max={80} onChange={(v) => set((s) => (s.shadow.blur = v))} {...slide} />
          <Slider label="横のずれ" value={st.shadow.dx} min={-80} max={80} onChange={(v) => set((s) => (s.shadow.dx = v))} {...slide} />
          <Slider label="縦のずれ" value={st.shadow.dy} min={-80} max={80} onChange={(v) => set((s) => (s.shadow.dy = v))} {...slide} />
        </>
      )}
      <Slider label="不透明度" value={Math.round(st.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => set((s) => (s.opacity = v / 100))} {...slide} />
    </div>
  );
}

// ===== 何も選択していないとき =====

function GlyphProps({ cp }: { cp: number }) {
  const glyph = useStore((s) => s.data!.project.glyphs[String(cp)]);
  const g: Glyph = glyph ?? newGlyph(cp);
  const m = g.metrics;
  const set = (p: Partial<Glyph['metrics']>) =>
    commit((d) => {
      const key = String(cp);
      if (!d.project.glyphs[key]) d.project.glyphs[key] = newGlyph(cp);
      d.project.glyphs[key].metrics = { ...d.project.glyphs[key].metrics, ...p };
    });
  return (
    <div>
      <div className="section">
        <h4>
          「{charOf(cp)}」の字形調整 <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{unicodeLabel(cp)}</span>
        </h4>
        <SpacingPreview cp={cp} />
        <Slider label="字形の大きさ" value={m.scale} min={0.3} max={1.8} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ scale: v })} {...slide} />
        <Slider label="左右の位置" value={m.offsetX} min={-400} max={400} onChange={(v) => set({ offsetX: v })} {...slide} />
        <Slider label="上下の位置（基準線からのずれ）" value={m.offsetY} min={-400} max={400} onChange={(v) => set({ offsetY: v })} {...slide} />
        <Segmented
          value={m.autoAdvance ? 'auto' : 'fixed'}
          onChange={(v) => set({ autoAdvance: v === 'auto' })}
          options={[
            { value: 'fixed', label: '送り幅を固定' },
            { value: 'auto', label: '字形に合わせる' },
          ]}
        />
        <div style={{ height: 10 }} />
        {m.autoAdvance ? (
          <Slider label="左右の余白" value={m.sideBearing} min={0} max={300} onChange={(v) => set({ sideBearing: v })} {...slide} />
        ) : (
          <Slider label="文字送り幅" value={m.advance} min={100} max={2000} step={10} onChange={(v) => set({ advance: v })} {...slide} />
        )}
        <div className="row wrap">
          <button className="btn sm" onClick={() => set(defaultMetrics(cp))}>
            <RotateCcw size={14} />
            初期値に戻す
          </button>
        </div>
        <p className="note">
          青い線が基準線（ベースライン）です。和文は送り幅 1000 の固定、欧文は「字形に合わせる」がおすすめです。これらの調整はフォントとロゴの両方に反映されます。
        </p>
      </div>
      <div className="section">
        <h4>この文字</h4>
        <div className="row wrap">
          <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('flw:export'))}>
            <ImageIcon size={16} />
            画像で保存
          </button>
          <button
            className="btn sm danger"
            disabled={!glyph || glyph.objects.length === 0}
            onClick={() => {
              if (!confirm(`「${charOf(cp)}」の線をすべて消しますか？（取り消しできます）`)) return;
              commitDocClear(cp);
            }}
          >
            <Trash size={16} />
            すべて消す
          </button>
        </div>
      </div>
    </div>
  );
}

function commitDocClear(cp: number) {
  commit((d) => {
    const g = d.project.glyphs[String(cp)];
    if (g) g.objects = [];
  });
}

function SpacingPreview({ cp }: { cp: number }) {
  const data = useStore((s) => s.data!);
  const ref = useRef<HTMLCanvasElement>(null);
  const ch = charOf(cp);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 260;
    const H = 72;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const env = envOf(data);
    const t: TextObj = {
      id: 'preview',
      type: 'text',
      transform: [1, 0, 0, 1, 0, 0],
      text: ch + ch + ch,
      fontSize: 48,
      letterSpacing: 0,
      lineHeight: 1,
      vertical: false,
      charAdj: {},
      style: defaultStyle(INK),
    };
    const l = layoutText(t, env);
    const k = Math.min(1, (W - 20) / Math.max(1, l.bbox.w));
    const view: Mat = [dpr * k, 0, 0, dpr * k, dpr * (W / 2 - (l.bbox.w * k) / 2), dpr * (H / 2 - 24 * k)];
    // 基準線
    ctx.strokeStyle = 'rgba(70,110,200,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const by = view[5] + 48 * 0.88 * view[3];
    ctx.moveTo(0, by);
    ctx.lineTo(c.width, by);
    ctx.stroke();
    renderStyled(ctx, [t], view, env, { markFallback: false });
  }, [data.project.glyphs, ch, data]);
  return <canvas ref={ref} className="preview-strip" style={{ marginBottom: 10 }} aria-label="文字送りのプレビュー" />;
}

function LogoProps({ id }: { id: string }) {
  const logo = useStore((s) => s.data!.project.logos.find((l) => l.id === id));
  if (!logo) return null;
  const set = (fn: (l: Logo) => void) =>
    commit((d) => {
      const l = d.project.logos.find((x) => x.id === id);
      if (l) fn(l as Logo);
    });
  const presets: [string, number, number][] = [
    ['横長 16:9', 1600, 900],
    ['正方形', 1200, 1200],
    ['縦長 4:5', 1080, 1350],
    ['帯（タイトル）', 2000, 600],
  ];
  return (
    <div>
      <div className="section">
        <h4>ロゴの設定</h4>
        <div className="field">
          <label>名前</label>
          <input className="input" value={logo.name} onChange={(e) => set((l) => (l.name = e.target.value))} />
        </div>
        <span className="field-label">キャンバスの大きさ</span>
        <div className="row wrap" style={{ margin: '6px 0 10px' }}>
          {presets.map(([n, w, h]) => (
            <button key={n} className="btn sm" onClick={() => set((l) => ((l.width = w), (l.height = h)))}>
              {n}
            </button>
          ))}
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <NumberField label="幅" value={logo.width} min={16} max={8000} onChange={(v) => set((l) => (l.width = Math.round(v)))} />
          <NumberField label="高さ" value={logo.height} min={16} max={8000} onChange={(v) => set((l) => (l.height = Math.round(v)))} />
        </div>
        <p className="note">市松模様は透明を表します（出力には含みません）。書き出し時に「内容の範囲だけ」を選ぶと、余白を詰めた透過画像にできます。</p>
      </div>
      <div className="section">
        <h4>はじめ方</h4>
        <p className="note" style={{ marginTop: 0 }}>
          左のツールで「文字」を選び、キャンバスをタップしてタイトルを入れます。パーツ棚の飾りを挿入したり、ペンや図形で装飾を描き足したりできます。
        </p>
      </div>
    </div>
  );
}

function CompositeProps({ id }: { id: string }) {
  const comp = useStore((s) => s.data!.project.composites.find((c) => c.id === id));
  const logos = useStore((s) => s.data!.project.logos);
  const data = useStore((s) => s.data!);
  if (!comp) return null;
  const set = (fn: (c: Composite) => void) =>
    commit((d) => {
      const c = d.project.composites.find((x) => x.id === id);
      if (c) fn(c as Composite);
    });
  const addLogo = (logoId: string) => {
    const env = envOf(data);
    const logo = logos.find((l) => l.id === logoId);
    if (!logo) return;
    const b = objectsBox(logo.objects, env);
    const bw = boxValid(b) ? b.maxX - b.minX : logo.width;
    const bh = boxValid(b) ? b.maxY - b.minY : logo.height;
    const cx = boxValid(b) ? (b.minX + b.maxX) / 2 : logo.width / 2;
    const cy = boxValid(b) ? (b.minY + b.maxY) / 2 : logo.height / 2;
    const k = Math.min((comp.width * 0.6) / Math.max(1, bw), (comp.height * 0.6) / Math.max(1, bh));
    const T = mul(translate(comp.width / 2, comp.height / 2), mul(scaleM(k), translate(-cx, -cy)));
    const o: Obj = { id: uid(), type: 'logoRef', logoId, transform: T, style: { ...defaultStyle(), outline: { on: false, color: '#ffffff', width: 8 } } };
    commitDoc((objs) => {
      objs.push(o);
    });
    setUi({ selection: [o.id], tool: 'select' });
  };
  return (
    <div>
      <div className="section">
        <h4>ロゴを配置</h4>
        {logos.length === 0 && <p className="note">先に「ロゴ」でロゴを作ってください。</p>}
        <div className="list">
          {logos.map((l) => (
            <div key={l.id} className="item">
              <button className="name" onClick={() => addLogo(l.id)}>
                {l.name}
                <div className="sub">{l.objects.length} 要素</div>
              </button>
              <button className="btn sm" onClick={() => addLogo(l.id)}>
                <Plus size={14} />
                配置
              </button>
            </div>
          ))}
        </div>
        <p className="note">文字ツールで、画像の上に直接文字を置くこともできます。</p>
      </div>
      <div className="section">
        <h4>合成の設定</h4>
        <div className="field">
          <label>名前</label>
          <input className="input" value={comp.name} onChange={(e) => set((c) => (c.name = e.target.value))} />
        </div>
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <button
            className="btn sm"
            onClick={async () => {
              const a = await importImageAsset();
              if (!a) return;
              set((c) => {
                c.assetId = a.id;
                c.width = a.width;
                c.height = a.height;
              });
            }}
          >
            <ImagePlus size={16} />
            {comp.assetId ? '背景画像を変更' : '背景画像を読み込む'}
          </button>
          {comp.assetId && (
            <button className="btn sm" onClick={() => set((c) => (c.assetId = null))}>
              背景画像を外す
            </button>
          )}
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <NumberField label="幅" value={comp.width} min={16} max={12000} onChange={(v) => set((c) => (c.width = Math.round(v)))} />
          <NumberField label="高さ" value={comp.height} min={16} max={12000} onChange={(v) => set((c) => (c.height = Math.round(v)))} />
        </div>
        <p className="note">背景画像の元のサイズが基準です。画像は端末内（ブラウザの保存領域）にだけ保存され、外部に送信されません。</p>
      </div>
    </div>
  );
}

function PartProps({ id }: { id: string }) {
  const part = useStore((s) => s.data!.parts.find((p) => p.id === id));
  const doc = useStore((s) => docOf(s.data, s.route));
  if (!part) return null;
  const set = (fn: (p: Part) => void) =>
    commit((d) => {
      const p = d.parts.find((x) => x.id === id);
      if (p) fn(p as Part);
    });
  return (
    <div className="section">
      <h4>パーツの設定</h4>
      <div className="field">
        <label>名前</label>
        <input className="input" value={part.name} onChange={(e) => set((p) => (p.name = e.target.value))} />
      </div>
      <div className="field">
        <label>カテゴリ</label>
        <input className="input" value={part.category} onChange={(e) => set((p) => (p.category = e.target.value))} />
      </div>
      <p className="note">中央の十字が挿入の基準点です。{doc?.objects.length ?? 0} 個の要素があります。</p>
    </div>
  );
}

