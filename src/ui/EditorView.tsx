import { useEffect, useRef, useState } from 'react';
import {
  MousePointer2,
  PenLine,
  Eraser,
  Minus,
  Spline,
  Circle,
  Square,
  Pentagon,
  Waypoints,
  Type,
  Hand,
  ZoomIn,
  ZoomOut,
  Maximize,
  Copy,
  Trash,
  Group,
  Ungroup,
  Puzzle,
  ArrowUpToLine,
  ArrowDownToLine,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  Check,
  X,
} from 'lucide-react';
import { useStore, setUi } from '../store/store';
import { EditorController, activeEditor } from '../editor/controller';
import type { Tool } from '../model/types';
import {
  duplicateSelection,
  deleteSelection,
  groupSelection,
  ungroupSelection,
  reorderSelection,
  alignSelection,
  flipH,
  flipV,
  selectedObjs,
} from '../editor/actions';
import { FlipHIcon, FlipVIcon } from './controls';
import { charOf, unicodeLabel } from '../model/charsets';

export function EditorView() {
  const host = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const ctl = useRef<EditorController | null>(null);
  useEffect(() => {
    if (!host.current || !main.current || !overlay.current) return;
    ctl.current = new EditorController(host.current, main.current, overlay.current);
    return () => ctl.current?.destroy();
  }, []);
  return (
    <div className="center">
      <div className="canvas-host" ref={host} data-testid="canvas-host">
        <canvas ref={main} aria-hidden />
        <canvas ref={overlay} data-testid="editor-canvas" aria-label="編集キャンバス" />
        <Palette />
        <SelectionBar />
        <CurveBar />
        <GlyphBadge />
        <ViewControls ctl={ctl} />
        <Hint />
      </div>
    </div>
  );
}

const TOOL_INFO: Record<Tool, { label: string; icon: React.ReactNode; hint: string }> = {
  select: { label: '選択', icon: <MousePointer2 size={20} />, hint: 'タップで選択・ドラッグで移動。四隅で拡大縮小、上の丸で回転' },
  pen: { label: 'ペン', icon: <PenLine size={20} />, hint: 'Apple Pencil で描きます。指 2 本で拡大・移動' },
  eraser: { label: '消しゴム', icon: <Eraser size={20} />, hint: 'なぞった線を消します' },
  line: { label: '直線', icon: <Minus size={20} />, hint: 'ドラッグで直線を引きます' },
  curve: { label: '曲線', icon: <Spline size={20} />, hint: 'タップで点、ドラッグで曲がる点。最初の点で閉じる' },
  ellipse: { label: '円', icon: <Circle size={20} />, hint: 'ドラッグで円・楕円' },
  rect: { label: '四角', icon: <Square size={20} />, hint: 'ドラッグで四角形' },
  polygon: { label: '多角形', icon: <Pentagon size={20} />, hint: 'ドラッグで多角形（角の数はツール設定）' },
  node: { label: '制御点', icon: <Waypoints size={20} />, hint: '図形を選んで点やハンドルをドラッグ。線上タップで点を追加' },
  text: { label: '文字', icon: <Type size={20} />, hint: 'タップした位置に文字を置きます' },
  hand: { label: '移動', icon: <Hand size={20} />, hint: 'ドラッグで表示を移動' },
};

function Palette() {
  const route = useStore((s) => s.route);
  const tool = useStore((s) => s.ui.tool);
  const mode = useStore((s) => s.ui.glyphMode);
  let tools: Tool[];
  const glyphLike = route.screen === 'glyph' || route.screen === 'part';
  if (glyphLike) tools = mode === 'hand' ? ['select', 'pen', 'eraser', 'hand'] : ['select', 'line', 'curve', 'ellipse', 'rect', 'polygon', 'node', 'hand'];
  else if (route.screen === 'logo') tools = ['select', 'text', 'pen', 'eraser', 'line', 'curve', 'ellipse', 'rect', 'polygon', 'node', 'hand'];
  else tools = ['select', 'text', 'pen', 'eraser', 'line', 'ellipse', 'rect', 'hand'];
  return (
    <div className="palette">
      <div className="palette-inner" role="toolbar" aria-label="ツール">
        {glyphLike && (
          <div className="modeswitch">
            <button
              className={mode === 'hand' ? 'on' : ''}
              onClick={() => setUi({ glyphMode: 'hand', tool: tool === 'select' || tool === 'hand' ? tool : 'pen' })}
              title="手書きモード"
            >
              手書き
            </button>
            <button
              className={mode === 'design' ? 'on' : ''}
              onClick={() => setUi({ glyphMode: 'design', tool: tool === 'select' || tool === 'hand' ? tool : 'curve' })}
              title="デザインモード"
            >
              デザイン
            </button>
          </div>
        )}
        {tools.map((t) => (
          <button
            key={t}
            className={'tool' + (tool === t ? ' on' : '')}
            onClick={() => setUi({ tool: t, nodeSel: null, ...(t === 'node' ? {} : {}) })}
            title={`${TOOL_INFO[t].label}：${TOOL_INFO[t].hint}`}
            aria-label={TOOL_INFO[t].label}
            aria-pressed={tool === t}
            data-tool={t}
          >
            {TOOL_INFO[t].icon}
            <span>{TOOL_INFO[t].label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectionBar() {
  const selection = useStore((s) => s.ui.selection);
  const tool = useStore((s) => s.ui.tool);
  const multi = useStore((s) => s.ui.multiSelect);
  useStore((s) => s.data);
  const [alignOpen, setAlignOpen] = useState(false);
  if (!selection.length || (tool !== 'select' && tool !== 'node')) {
    if (tool === 'select')
      return (
        <div className="selbar">
          <button className={'btn sm' + (multi ? ' primary' : '')} onClick={() => setUi({ multiSelect: !multi })} title="タップで複数選択を切り替え">
            複数選択 {multi ? 'オン' : 'オフ'}
          </button>
        </div>
      );
    return null;
  }
  const sel = selectedObjs();
  const hasGroup = sel.some((o) => o.type === 'group');
  return (
    <div className="selbar" role="toolbar" aria-label="選択中の操作">
      <button className={'btn sm' + (multi ? ' primary' : '')} onClick={() => setUi({ multiSelect: !multi })} title="タップで複数選択">
        複数{multi ? 'オン' : ''}
      </button>
      <div className="sep" />
      <button className="ibtn" title="複製" aria-label="複製" onClick={() => duplicateSelection()}>
        <Copy size={20} />
      </button>
      <button className="ibtn" title="左右反転" aria-label="左右反転" onClick={flipH}>
        <FlipHIcon />
      </button>
      <button className="ibtn" title="上下反転" aria-label="上下反転" onClick={flipV}>
        <FlipVIcon />
      </button>
      <button className="ibtn" title="最前面へ" aria-label="最前面へ" onClick={() => reorderSelection('top')}>
        <ArrowUpToLine size={20} />
      </button>
      <button className="ibtn" title="最背面へ" aria-label="最背面へ" onClick={() => reorderSelection('bottom')}>
        <ArrowDownToLine size={20} />
      </button>
      <div style={{ position: 'relative' }}>
        <button className={'ibtn' + (alignOpen ? ' on' : '')} title="整列" aria-label="整列" onClick={() => setAlignOpen(!alignOpen)}>
          <AlignCenterVertical size={20} />
        </button>
        {alignOpen && (
          <div className="menu-pop" style={{ top: '110%', left: -60 }} onPointerLeave={() => setAlignOpen(false)}>
            <p className="note" style={{ margin: '4px 8px' }}>
              {sel.length === 1 ? '文字枠（キャンバス）に揃える' : '選択範囲に揃える'}
            </p>
            {(
              [
                ['left', '左揃え', <AlignStartVertical size={16} key="a" />],
                ['hcenter', '左右中央', <AlignCenterVertical size={16} key="b" />],
                ['right', '右揃え', <AlignEndVertical size={16} key="c" />],
                ['top', '上揃え', <AlignStartHorizontal size={16} key="d" />],
                ['vcenter', '上下中央', <AlignCenterHorizontal size={16} key="e" />],
                ['bottom', '下揃え', <AlignEndHorizontal size={16} key="f" />],
              ] as const
            ).map(([k, l, ic]) => (
              <button
                key={k}
                onClick={() => {
                  alignSelection(k);
                  setAlignOpen(false);
                }}
              >
                {ic}
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      {sel.length > 1 && (
        <button className="ibtn" title="グループ化" aria-label="グループ化" onClick={groupSelection}>
          <Group size={20} />
        </button>
      )}
      {hasGroup && (
        <button className="ibtn" title="グループ解除" aria-label="グループ解除" onClick={ungroupSelection}>
          <Ungroup size={20} />
        </button>
      )}
      <div className="sep" />
      <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('flw:register-part'))} title="選択したものをパーツ棚に登録" data-testid="register-part">
        <Puzzle size={18} />
        パーツに登録
      </button>
      <button className="ibtn" title="削除" aria-label="削除" onClick={deleteSelection}>
        <Trash size={20} />
      </button>
    </div>
  );
}

function CurveBar() {
  const n = useStore((s) => s.ui.curvePending);
  if (!n) return null;
  return (
    <div className="curvebar">
      <span className="note" style={{ margin: '0 6px', alignSelf: 'center' }}>
        点 {n} 個
      </span>
      <button className="btn sm primary" onClick={() => activeEditor?.finishCurve(false)} disabled={n < 2}>
        <Check size={16} />
        確定
      </button>
      <button className="btn sm" onClick={() => activeEditor?.finishCurve(true)} disabled={n < 3}>
        閉じて確定
      </button>
      <button
        className="ibtn sm"
        aria-label="やめる"
        onClick={() => {
          if (activeEditor) {
            activeEditor.curve = null;
            setUi({ curvePending: 0 });
            activeEditor.scheduleOverlay();
          }
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

function GlyphBadge() {
  const route = useStore((s) => s.route);
  if (route.screen !== 'glyph') return null;
  return (
    <div className="glyph-badge" aria-label="編集中の文字">
      <b>{charOf(route.cp)}</b>
      <span>{unicodeLabel(route.cp)}</span>
    </div>
  );
}

function ViewControls({ ctl }: { ctl: React.RefObject<EditorController | null> }) {
  return (
    <div className="viewctl">
      <button className="ibtn sm" aria-label="縮小" title="縮小" onClick={() => ctl.current?.zoomBy(0.8)}>
        <ZoomOut size={18} />
      </button>
      <button className="ibtn sm" aria-label="全体を表示" title="全体を表示" onClick={() => ctl.current?.fit()}>
        <Maximize size={18} />
      </button>
      <button className="ibtn sm" aria-label="拡大" title="拡大" onClick={() => ctl.current?.zoomBy(1.25)}>
        <ZoomIn size={18} />
      </button>
    </div>
  );
}

function Hint() {
  const tool = useStore((s) => s.ui.tool);
  const sel = useStore((s) => s.ui.selection.length);
  const [shownFor, setShownFor] = useState<string>('');
  const key = tool + (sel ? 's' : '');
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (key === shownFor) return;
    setShownFor(key);
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(t);
  }, [key]);
  if (!visible) return null;
  return <div className="hintbar">{TOOL_INFO[tool].hint}</div>;
}
