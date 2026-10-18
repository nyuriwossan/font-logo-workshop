import { useEffect, useMemo, useState } from 'react';
import { Download, Share2 } from 'lucide-react';
import { Modal, Segmented, Slider, Toggle, ColorField, NumberField } from './controls';
import { useStore, toast } from '../store/store';
import { envOf } from '../editor/actions';
import {
  resolveSource,
  exportFrame,
  pixelSize,
  renderRaster,
  canvasToBlob,
  exportSvg,
  downloadBlob,
  canShareFile,
  shareBlob,
  safeFileName,
  type ExportSource,
  type ExportOptions,
} from '../render/exporter';
import { INK } from '../model/defaults';
import { layoutText } from '../render/textLayout';
import type { Obj } from '../model/types';

type Format = 'png' | 'svg' | 'jpeg';

function countFallback(objs: Obj[], env: ReturnType<typeof envOf>, depth = 0): number {
  let n = 0;
  for (const o of objs) {
    if (o.hidden) continue;
    if (o.type === 'text') n += layoutText(o, env).chars.filter((c) => !c.outline && c.ch.trim()).length;
    if (o.type === 'group') n += countFallback(o.children, env, depth);
    if (o.type === 'logoRef' && depth < 4) {
      const l = env.logos.find((x) => x.id === o.logoId);
      if (l) n += countFallback(l.objects, env, depth + 1);
    }
  }
  return n;
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const route = useStore((s) => s.route);
  const data = useStore((s) => s.data!);
  const env = envOf(data);
  const src: ExportSource | null =
    route.screen === 'glyph' ? { kind: 'glyph', cp: route.cp } : route.screen === 'logo' ? { kind: 'logo', id: route.id } : route.screen === 'composite' ? { kind: 'composite', id: route.id } : null;
  const resolved = src ? resolveSource(data.project, src) : null;
  const isComposite = src?.kind === 'composite';
  const hasBgImage = !!resolved?.bgAssetId;
  const [format, setFormat] = useState<Format>('png');
  const [includeBg, setIncludeBg] = useState(isComposite && hasBgImage);
  const [range, setRange] = useState<'frame' | 'content'>(src?.kind === 'logo' ? 'content' : src?.kind === 'glyph' ? 'content' : 'frame');
  const [padding, setPadding] = useState(src?.kind === 'glyph' ? 40 : 24);
  const [bgOn, setBgOn] = useState(false);
  const [bg, setBg] = useState('#ffffff');
  const [ink, setInk] = useState(INK);
  const [sizeMode, setSizeMode] = useState<'scale' | 'width'>('scale');
  const [scale, setScale] = useState(src?.kind === 'glyph' ? 1 : 1);
  const [width, setWidth] = useState(1200);
  const [quality, setQuality] = useState(0.92);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fmtOptions: { value: Format; label: string }[] = isComposite && includeBg
    ? [
        { value: 'png', label: 'PNG' },
        { value: 'jpeg', label: 'JPEG' },
        { value: 'svg', label: 'SVG' },
      ]
    : [
        { value: 'png', label: '透過 PNG' },
        { value: 'svg', label: 'SVG' },
        ...(isComposite ? [{ value: 'jpeg' as Format, label: 'JPEG' }] : []),
      ];
  useEffect(() => {
    // 「ロゴ部分のみ（透過）」に切り替えたら透過 PNG を既定にする
    if (!includeBg && format === 'jpeg') setFormat('png');
    else if (!fmtOptions.some((o) => o.value === format)) setFormat('png');
  }, [includeBg]);

  const opts: ExportOptions = {
    range: includeBg ? 'frame' : range,
    padding,
    scale: 1,
    background: format === 'jpeg' ? (bgOn ? bg : '#ffffff') : bgOn ? bg : null,
    ink,
    includeBg,
  };
  const frame = resolved ? exportFrame(resolved, env, opts) : null;
  const effScale = frame ? (sizeMode === 'scale' ? scale : width / frame.w) : 1;
  opts.scale = effScale;
  const px = frame ? pixelSize(frame, effScale) : null;
  const fallbackCount = useMemo(() => (resolved && !resolved.glyph ? countFallback(resolved.objects, env) : 0), [resolved, env]);

  // プレビュー
  const key = JSON.stringify([format, includeBg, range, padding, bgOn, bg, ink, effScale, frame, quality]);
  useEffect(() => {
    if (!resolved || !frame) {
      setPreview(null);
      return;
    }
    let alive = true;
    let url: string | null = null;
    const t = setTimeout(async () => {
      try {
        if (format === 'svg') {
          const r = await exportSvg(resolved, env, opts, frame);
          url = URL.createObjectURL(r.blob);
        } else {
          const r = await renderRaster(resolved, env, opts, frame, 900);
          const blob = await canvasToBlob(r.canvas, format === 'jpeg' ? 'image/jpeg' : 'image/png', quality);
          url = URL.createObjectURL(blob);
        }
        if (alive) setPreview(url);
      } catch (e) {
        if (alive) setPreview(null);
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
    };
  }, [key, data]);

  const make = async (): Promise<{ blob: Blob; name: string } | null> => {
    if (!resolved || !frame) return null;
    const base = safeFileName(resolved.name);
    if (format === 'svg') {
      const r = await exportSvg(resolved, env, opts, frame);
      if (r.rasterChars > 0) toast(`代用文字 ${r.rasterChars} 文字はラスター画像として SVG に埋め込みました`);
      return { blob: r.blob, name: `${base}.svg` };
    }
    const r = await renderRaster(resolved, env, opts, frame);
    if (r.clamped) toast(`端末の上限に合わせて ${r.w}×${r.h} に縮小しました`);
    const blob = await canvasToBlob(r.canvas, format === 'jpeg' ? 'image/jpeg' : 'image/png', quality);
    // メモリを早めに解放（iPad 対策）
    r.canvas.width = 1;
    r.canvas.height = 1;
    return { blob, name: `${base}.${format === 'jpeg' ? 'jpg' : 'png'}` };
  };

  const run = async (share: boolean) => {
    setBusy(true);
    try {
      const r = await make();
      if (!r) return;
      if (share && canShareFile(r.blob, r.name)) await shareBlob(r.blob, r.name);
      else downloadBlob(r.blob, r.name);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') toast(`書き出しに失敗しました：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const shareSupported = typeof navigator !== 'undefined' && !!navigator.canShare;
  const empty = !frame;

  return (
    <Modal
      title="画像として書き出す"
      onClose={onClose}
      size="wide"
      footer={
        <>
          {shareSupported && (
            <button className="btn" disabled={busy || empty} onClick={() => run(true)}>
              <Share2 size={18} />
              共有・写真に保存
            </button>
          )}
          <button className="btn primary" disabled={busy || empty} onClick={() => run(false)} data-testid="do-export">
            <Download size={18} />
            {busy ? '作成中…' : 'ダウンロード'}
          </button>
        </>
      }
    >
      <div className="two-col">
        <div>
          {isComposite && hasBgImage && (
            <div className="field">
              <span className="field-label">書き出す内容</span>
              <Segmented
                value={includeBg ? 'all' : 'logo'}
                onChange={(v) => setIncludeBg(v === 'all')}
                options={[
                  { value: 'all', label: '合成した画像' },
                  { value: 'logo', label: 'ロゴ部分のみ（透過）' },
                ]}
              />
            </div>
          )}
          <div className="field">
            <span className="field-label">形式</span>
            <Segmented value={format} onChange={setFormat} options={fmtOptions} />
          </div>
          {!includeBg && (
            <div className="field">
              <span className="field-label">範囲</span>
              <Segmented
                value={range}
                onChange={setRange}
                options={[
                  { value: 'content', label: '内容の範囲だけ' },
                  { value: 'frame', label: resolved?.glyph ? '文字枠全体' : 'キャンバス全体' },
                ]}
              />
            </div>
          )}
          {!includeBg && range === 'content' && <Slider label="余白" value={padding} min={0} max={400} onChange={setPadding} />}
          <div className="field">
            <span className="field-label">サイズ</span>
            <Segmented
              value={sizeMode}
              onChange={setSizeMode}
              options={[
                { value: 'scale', label: '倍率' },
                { value: 'width', label: '幅を指定' },
              ]}
            />
          </div>
          {sizeMode === 'scale' ? (
            <Slider label="倍率（解像度）" value={scale} min={0.25} max={4} step={0.25} format={(v) => `${v} 倍`} onChange={setScale} />
          ) : (
            <div style={{ marginBottom: 12 }}>
              <NumberField label="幅" suffix="px" value={width} min={16} max={8192} onChange={setWidth} />
            </div>
          )}
          <Toggle label={format === 'jpeg' ? '背景色を指定（オフ：白）' : '背景に色を付ける（オフ：透明）'} checked={bgOn} onChange={setBgOn} />
          {bgOn && <ColorField value={bg} onChange={setBg} />}
          {resolved?.glyph && <ColorField label="文字の色" value={ink} onChange={setInk} />}
          {format === 'jpeg' && <Slider label="JPEG の画質" value={Math.round(quality * 100)} min={50} max={100} unit="%" onChange={(v) => setQuality(v / 100)} />}
        </div>
        <div>
          <div className="preview-box">{preview ? <img src={preview} alt="書き出しプレビュー" /> : <span className="note">{empty ? '書き出す内容がありません' : 'プレビューを作成中…'}</span>}</div>
          {px && (
            <p className="note">
              出力サイズ：{px.w} × {px.h} px{px.clamped ? '（端末の上限に合わせて縮小）' : ''}。プレビューの市松模様は透明部分の表示で、画像には含まれません。
            </p>
          )}
          {format === 'svg' && fallbackCount > 0 && (
            <p className="note warn">代用文字が {fallbackCount} 文字あります。SVG では見た目を保つため、その文字だけラスター画像（PNG）として埋め込みます（完全なベクターではありません）。</p>
          )}
          {format === 'svg' && includeBg && <p className="note warn">背景画像はラスター画像として SVG に埋め込まれます。</p>}
          {format === 'svg' && fallbackCount === 0 && !includeBg && <p className="note ok">すべてベクター（パス）で出力されます。</p>}
          {format === 'jpeg' && <p className="note">JPEG は透明を保存できないため、透明部分は背景色で塗られます。</p>}
          {!resolved?.glyph && fallbackCount > 0 && format !== 'svg' && (
            <p className="note">代用文字 {fallbackCount} 文字も、表示どおり画像に含まれます。</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
