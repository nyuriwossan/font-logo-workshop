import { useMemo, useState } from 'react';
import { X, Eye, EyeOff, Lock, LockOpen, ArrowUp, ArrowDown, Pencil, Copy, Trash, Plus, PenLine, Spline, Circle, Square, Pentagon, Minus, Type, Image as ImageIcon, Shapes } from 'lucide-react';
import { useStore, setUi, commit, setRoute, docOf, editDocDraft } from '../store/store';
import { Slider, Toggle, Segmented, ColorField } from './controls';
import { ResizeHandle } from './LeftPanel';
import { insertPart, envOf, select, moveObject } from '../editor/actions';
import { ObjectsThumb } from './thumbs';
import { PropsPanel } from './PropsPanel';
import type { Obj, Part } from '../model/types';
import { pathShapeLabel } from '../geom/path';
import { uid } from '../model/ids';
import { cloneWithNewIds } from '../model/normalize';

export function RightPanel() {
  const ui = useStore((s) => s.ui);
  const route = useStore((s) => s.route);
  return (
    <aside className="side right" style={{ width: ui.rightW }}>
      <div className="side-head" style={{ gap: 6 }}>
        <Segmented
          small
          value={ui.rightTab}
          onChange={(v) => setUi({ rightTab: v })}
          options={[
            { value: 'tool', label: 'ツール' },
            { value: 'props', label: '調整' },
            { value: 'parts', label: 'パーツ' },
            { value: 'layers', label: 'レイヤー' },
          ]}
        />
        <div className="spacer" />
        <button className="ibtn sm" onClick={() => setUi({ rightOpen: false })} aria-label="パネルを閉じる" title="パネルを閉じる">
          <X size={18} />
        </button>
      </div>
      <div className="side-scroll">
        {ui.rightTab === 'tool' && <ToolSettings />}
        {ui.rightTab === 'props' && <PropsPanel key={route.screen} />}
        {ui.rightTab === 'parts' && <PartsPanel />}
        {ui.rightTab === 'layers' && <LayersPanel />}
      </div>
      <ResizeHandle side="right" />
    </aside>
  );
}

// ===== ツール設定 =====

function ToolSettings() {
  const ui = useStore((s) => s.ui);
  const route = useStore((s) => s.route);
  const pen = ui.pen;
  const setPen = (p: Partial<typeof pen>) => setUi({ pen: { ...pen, ...p } });
  const isGlyphLike = route.screen === 'glyph' || route.screen === 'part';
  const t = ui.tool;
  return (
    <div>
      {(t === 'pen' || t === 'select' || t === 'hand') && (
        <div className="section">
          <h4>ペン</h4>
          <PenPreview />
          <Slider label="太さ" value={pen.size} min={2} max={200} onChange={(v) => setPen({ size: v })} />
          <Toggle
            label={ui.penDetected ? '筆圧を使う（Apple Pencil）' : '筆圧を使う（ペン入力時のみ有効）'}
            checked={pen.usePressure}
            onChange={(v) => setPen({ usePressure: v })}
          />
          <Slider label="筆圧による強弱" value={pen.thinning} min={0} max={0.95} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setPen({ thinning: v })} />
          <Slider label="線の滑らかさ" value={pen.smoothing} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setPen({ smoothing: v })} />
          <Slider label="手ぶれ補正" value={pen.streamline} min={0} max={0.95} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setPen({ streamline: v })} />
          <Slider label="入りの細さ（はらい）" value={pen.taperStart} min={0} max={300} step={5} onChange={(v) => setPen({ taperStart: v })} />
          <Slider label="抜きの細さ（はらい）" value={pen.taperEnd} min={0} max={300} step={5} onChange={(v) => setPen({ taperEnd: v })} />
          <p className="note">筆圧が取れない入力（マウス・指）では、自動的に一定の太さで描きます。描いた後でも、線を選んで「調整」から太さを変えられます。</p>
        </div>
      )}
      {t === 'eraser' && (
        <div className="section">
          <h4>消しゴム</h4>
          {isGlyphLike ? (
            <Segmented
              value={ui.eraserMode}
              onChange={(v) => setUi({ eraserMode: v })}
              options={[
                { value: 'object', label: '線ごと消す' },
                { value: 'partial', label: '部分を消す' },
              ]}
            />
          ) : (
            <p className="note">ロゴ・合成では「線ごと消す」消しゴムです。</p>
          )}
          <div style={{ height: 10 }} />
          <Slider label="大きさ" value={ui.eraserSize} min={4} max={240} onChange={(v) => setUi({ eraserSize: v })} />
          <p className="note">
            「部分を消す」は、消した跡も編集データとして残ります。レイヤー一覧の「消しゴム」を削除すると元に戻せます。
          </p>
        </div>
      )}
      {(t === 'line' || t === 'curve' || t === 'rect' || t === 'ellipse' || t === 'polygon' || t === 'node') && (
        <div className="section">
          <h4>図形・曲線</h4>
          {t !== 'line' && (
            <Segmented
              value={ui.shapeFill ? 'fill' : 'line'}
              onChange={(v) => setUi({ shapeFill: v === 'fill' })}
              options={[
                { value: 'fill', label: '塗り' },
                { value: 'line', label: '線' },
              ]}
            />
          )}
          <div style={{ height: 10 }} />
          <Slider label="線の太さ" value={ui.shapeStroke} min={2} max={200} onChange={(v) => setUi({ shapeStroke: v })} />
          {t === 'polygon' && <Slider label="角の数" value={ui.polygonSides} min={3} max={12} onChange={(v) => setUi({ polygonSides: v })} />}
          {t === 'curve' && (
            <p className="note">
              タップで角の点、ドラッグで曲がる点を置きます。最初の点をタップすると閉じた形、「確定」または最後の点のダブルタップで線になります。
            </p>
          )}
          {t === 'node' && <p className="note">図形や曲線を選び、四角い点やハンドルをドラッグして形を直します。線の上をタップすると点を追加、点のダブルタップで角⇔なめらかを切り替えます。</p>}
        </div>
      )}
      {(t === 'text') && (
        <div className="section">
          <h4>文字</h4>
          <p className="note">キャンバスをタップすると文字を置きます。文章は「調整」タブで入力します。</p>
        </div>
      )}
      {!isGlyphLike && (
        <div className="section">
          <h4>描く色（ロゴ・合成）</h4>
          <ColorField value={ui.decoColor} onChange={(v) => setUi({ decoColor: v })} />
        </div>
      )}
      <div className="section">
        <h4>補助</h4>
        <Toggle label="グリッドに吸着" checked={ui.snap} onChange={(v) => setUi({ snap: v })} />
        {ui.snap && (
          <Segmented
            small
            value={String(ui.gridStep)}
            onChange={(v) => setUi({ gridStep: Number(v) })}
            options={[10, 25, 50, 100].map((v) => ({ value: String(v), label: String(v) }))}
          />
        )}
        {isGlyphLike && <Toggle label="グリッドを表示" checked={ui.showGrid} onChange={(v) => setUi({ showGrid: v })} />}
        {route.screen === 'glyph' && <Toggle label="お手本を表示（保存・出力には含みません）" checked={ui.showTemplate} onChange={(v) => setUi({ showTemplate: v })} />}
        {!isGlyphLike && <Toggle label="代用文字に目印を表示（出力には含みません）" checked={ui.showFallbackMarks} onChange={(v) => setUi({ showFallbackMarks: v })} />}
        <Toggle label="変形時に縦横比を保つ" checked={ui.keepRatio} onChange={(v) => setUi({ keepRatio: v })} />
        <Toggle label="指でも描く（オフ：Pencil 使用時は指で移動・拡大）" checked={ui.fingerDraws} onChange={(v) => setUi({ fingerDraws: v })} />
        <p className="note">
          2 本指でつまむと拡大縮小、2 本指タップで 1 つ取り消し。{ui.penDetected ? 'Apple Pencil を検出しました。' : 'ペンが未検出のため、指でも描けます。'}
        </p>
      </div>
    </div>
  );
}

function PenPreview() {
  const pen = useStore((s) => s.ui.pen);
  const obj = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      pts.push([t * 900, 120 + Math.sin(t * Math.PI * 2) * 60, 0.25 + 0.6 * Math.sin(t * Math.PI)]);
    }
    return [{ id: 'pv', type: 'stroke', transform: [1, 0, 0, 1, 0, 0], points: pts, pen } as Obj];
  }, [pen]);
  const env = useStore((s) => envOf(s.data!));
  return (
    <div style={{ height: 56, background: '#fff', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 160, height: 56 }}>
          <ObjectsThumb objects={obj} env={env} size={56} ink />
        </div>
      </div>
    </div>
  );
}

// ===== パーツ棚 =====

function PartsPanel() {
  const parts = useStore((s) => s.data!.parts);
  const env = useStore((s) => envOf(s.data!));
  const sel = useStore((s) => s.ui.selection.length);
  const [cat, setCat] = useState('すべて');
  const cats = useMemo(() => ['すべて', ...Array.from(new Set(parts.map((p) => p.category)))], [parts]);
  const shown = cat === 'すべて' ? parts : parts.filter((p) => p.category === cat);
  const [menu, setMenu] = useState<string | null>(null);
  return (
    <div>
      <div className="note" style={{ marginTop: 0 }}>
        描いた線や図形を選択して「パーツに登録」すると、ここに並びます。タップでいま編集中の文字・ロゴへ挿入します（挿入後は元のパーツから独立します）。
      </div>
      <button className="btn block" disabled={!sel} onClick={() => window.dispatchEvent(new CustomEvent('flw:register-part'))} style={{ marginBottom: 12 }}>
        <Plus size={16} />
        選択中のものをパーツに登録
      </button>
      {parts.length > 0 && (
        <div className="tabs">
          {cats.map((c) => (
            <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <div className="empty">パーツはまだありません。</div>
      ) : (
        <div className="parts-grid">
          {shown.map((p) => (
            <div key={p.id} className="pcell">
              <button className="thumb" onClick={() => insertPart(p)} title={`「${p.name}」を挿入`} aria-label={`${p.name}を挿入`}>
                <ObjectsThumb objects={p.objects} env={env} />
              </button>
              <div className="row" style={{ gap: 2 }}>
                <span className="pname" style={{ flex: 1 }}>
                  {p.name}
                </span>
                <button className="ibtn sm" style={{ width: 28, height: 28 }} aria-label="メニュー" onClick={() => setMenu(menu === p.id ? null : p.id)}>
                  ⋯
                </button>
              </div>
              {menu === p.id && <PartMenu part={p} onClose={() => setMenu(null)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PartMenu({ part, onClose }: { part: Part; onClose: () => void }) {
  const upd = (fn: (p: Part) => void) =>
    commit((d) => {
      const x = d.parts.find((y) => y.id === part.id);
      if (x) fn(x as Part);
    });
  return (
    <div className="menu-pop" style={{ right: 0, top: '100%' }} onPointerLeave={onClose}>
      <button
        onClick={() => {
          const n = prompt('パーツ名', part.name);
          if (n?.trim()) upd((p) => (p.name = n.trim()));
          onClose();
        }}
      >
        <Pencil size={16} />
        名前を変更
      </button>
      <button
        onClick={() => {
          const n = prompt('カテゴリ（例：濁点、へん、飾り）', part.category);
          if (n?.trim()) upd((p) => (p.category = n.trim()));
          onClose();
        }}
      >
        <Shapes size={16} />
        カテゴリを変更
      </button>
      <button
        onClick={() => {
          onClose();
          setRoute({ screen: 'part', id: part.id });
        }}
      >
        <PenLine size={16} />
        元のパーツを編集
      </button>
      <button
        onClick={() => {
          const copy: Part = { ...part, id: uid('part'), name: `${part.name} のコピー`, objects: cloneWithNewIds(part.objects), createdAt: Date.now(), updatedAt: Date.now() };
          commit((d) => {
            d.parts.push(copy as any);
          });
          onClose();
        }}
      >
        <Copy size={16} />
        複製
      </button>
      <button
        className="danger"
        onClick={() => {
          onClose();
          if (!confirm(`パーツ「${part.name}」を削除しますか？\n（すでに貼り付けた文字やロゴは変わりません）`)) return;
          const s = useStore.getState();
          if (s.route.screen === 'part' && s.route.id === part.id) setRoute({ screen: 'glyph', cp: 0x3042 });
          commit((d) => {
            d.parts = d.parts.filter((x) => x.id !== part.id);
          });
        }}
      >
        <Trash size={16} />
        削除
      </button>
    </div>
  );
}

// ===== レイヤー =====

function objLabel(o: Obj): string {
  if (o.name) return o.name;
  switch (o.type) {
    case 'stroke':
      return o.erase ? '消しゴム（部分）' : '手書き線';
    case 'path':
      return pathShapeLabel(o);
    case 'group':
      return `グループ（${o.children.length}）`;
    case 'text':
      return `文字「${o.text.slice(0, 12)}」`;
    case 'logoRef':
      return 'ロゴ';
  }
}
function ObjIcon({ o }: { o: Obj }) {
  const s = 16;
  switch (o.type) {
    case 'stroke':
      return <PenLine size={s} />;
    case 'path':
      return o.shape === 'ellipse' ? <Circle size={s} /> : o.shape === 'rect' ? <Square size={s} /> : o.shape === 'polygon' ? <Pentagon size={s} /> : o.shape === 'line' ? <Minus size={s} /> : <Spline size={s} />;
    case 'group':
      return <Shapes size={s} />;
    case 'text':
      return <Type size={s} />;
    case 'logoRef':
      return <ImageIcon size={s} />;
  }
}

function LayersPanel() {
  const data = useStore((s) => s.data);
  const route = useStore((s) => s.route);
  const selection = useStore((s) => s.ui.selection);
  const doc = useMemo(() => docOf(data, route), [data, route]);
  if (!doc) return null;
  const list = [...doc.objects].reverse();
  const upd = (id: string, fn: (o: Obj) => void) =>
    commit((d) => {
      const s = useStore.getState();
      editDocDraft(d, s.route, (objs) => {
        const o = objs.find((x) => x.id === id);
        if (o) fn(o);
      });
    });
  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>
        上にあるものほど手前に表示されます。{route.screen === 'glyph' ? 'フォントでは全レイヤーが 1 色の輪郭に合体されます。' : ''}
      </p>
      {list.length === 0 && <div className="empty">まだ何もありません。</div>}
      <div className="list">
        {list.map((o, i) => (
          <div key={o.id} className={'item' + (selection.includes(o.id) ? ' on' : '') + (o.hidden ? ' dim' : '')}>
            <ObjIcon o={o} />
            <button className="name" onClick={() => select([o.id])}>
              {objLabel(o)}
            </button>
            <button className="ibtn sm" aria-label="手前へ" disabled={i === 0} onClick={() => moveObject(o.id, 'up')}>
              <ArrowUp size={16} />
            </button>
            <button className="ibtn sm" aria-label="奥へ" disabled={i === list.length - 1} onClick={() => moveObject(o.id, 'down')}>
              <ArrowDown size={16} />
            </button>
            <button className="ibtn sm" aria-label={o.hidden ? '表示' : '非表示'} onClick={() => upd(o.id, (x) => (x.hidden ? delete x.hidden : (x.hidden = true)))}>
              {o.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button className="ibtn sm" aria-label={o.locked ? 'ロック解除' : 'ロック'} onClick={() => upd(o.id, (x) => (x.locked ? delete x.locked : (x.locked = true)))}>
              {o.locked ? <Lock size={16} /> : <LockOpen size={16} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

