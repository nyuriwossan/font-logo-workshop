import { useEffect, useMemo, useState } from 'react';
import { Download, Share2, CircleCheck, TriangleAlert, LoaderCircle } from 'lucide-react';
import { Modal } from './controls';
import { useStore, commit, toast } from '../store/store';
import { planFont, buildOtf, verifyOtf, fontFileName, ASCII_NAME, type VerifyResult } from '../font/otf';
import { downloadBlob, canShareFile, shareBlob } from '../render/exporter';
import { BUILTIN_SETS, cpOf } from '../model/charsets';

interface Built {
  buffer: ArrayBuffer;
  verify: VerifyResult;
  browserCheck: { ok: boolean; detail: string } | null;
  family: string;
  size: number;
}

let testSeq = 0;

/** ブラウザに実際に読み込ませて、文字送り幅が一致するか確認 */
async function browserFontCheck(buffer: ArrayBuffer, sample: { ch: string; advance: number }[]): Promise<{ ok: boolean; detail: string; family: string }> {
  const family = `FLWTest${++testSeq}`;
  if (typeof FontFace === 'undefined') return { ok: false, detail: 'この環境では読み込み確認ができません', family };
  const ff = new FontFace(family, buffer.slice(0));
  await ff.load();
  document.fonts.add(ff);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `100px "${family}"`;
  const bad: string[] = [];
  for (const s of sample.slice(0, 30)) {
    const w = ctx.measureText(s.ch).width;
    if (Math.abs(w - s.advance / 10) > 1.5) bad.push(`${s.ch}（${w.toFixed(1)} / ${(s.advance / 10).toFixed(1)}）`);
  }
  return bad.length
    ? { ok: false, detail: `幅が一致しない文字：${bad.slice(0, 5).join('、')}`, family }
    : { ok: true, detail: `${Math.min(30, sample.length)} 文字の文字送りがブラウザ上でも一致`, family };
}

export function FontDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.data!.project);
  const font = project.font;
  const plan = useMemo(() => planFont(project), [project.glyphs]);
  const [built, setBuilt] = useState<Built | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState('');
  const setFont = (p: Partial<typeof font>) =>
    commit((d) => {
      d.project.font = { ...d.project.font, ...p };
    });
  useEffect(() => setBuilt(null), [project.glyphs, font]);

  const nameOk = ASCII_NAME.test(font.familyName);
  const styleOk = ASCII_NAME.test(font.styleName);
  const errors = plan.issues.filter((i) => i.level === 'error');
  const warns = plan.issues.filter((i) => i.level === 'warn');
  const counts = BUILTIN_SETS.map((s) => ({ label: s.label, done: s.chars.filter((c) => plan.glyphs.some((g) => g.cp === cpOf(c))).length, total: s.chars.length }));
  const builtinCps = new Set(BUILTIN_SETS.flatMap((s) => s.chars.map(cpOf)));
  const others = plan.glyphs.filter((g) => !builtinCps.has(g.cp)).length;

  const build = async () => {
    setBusy(true);
    setErr(null);
    try {
      const names = { displayName: font.displayName, familyName: font.familyName.trim(), styleName: font.styleName.trim() || 'Regular', designer: font.designer };
      const buffer = buildOtf(plan, names);
      const verify = verifyOtf(buffer, plan, names);
      let browserCheck: Built['browserCheck'] = null;
      let family = '';
      try {
        const r = await browserFontCheck(
          buffer,
          plan.glyphs.map((g) => ({ ch: String.fromCodePoint(g.cp), advance: g.advance })),
        );
        browserCheck = { ok: r.ok, detail: r.detail };
        family = r.family;
      } catch (e) {
        browserCheck = { ok: false, detail: `ブラウザがフォントを読み込めませんでした：${(e as Error).message}` };
      }
      setBuilt({ buffer, verify, browserCheck, family, size: buffer.byteLength });
      if (!sample) setSample(plan.glyphs.slice(0, 12).map((g) => String.fromCodePoint(g.cp)).join(''));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fileName = fontFileName({ displayName: font.displayName, familyName: font.familyName || 'Font', styleName: font.styleName || 'Regular' });
  const blob = built ? new Blob([built.buffer], { type: 'font/otf' }) : null;
  const allOk = !!built && built.verify.ok && (built.browserCheck?.ok ?? true);

  return (
    <Modal
      title="フォント（OTF）を書き出す"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button className="btn" disabled={busy || plan.glyphs.length === 0 || !nameOk} onClick={build} data-testid="build-font">
            {busy ? <LoaderCircle size={18} className="spin" /> : null}
            {built ? 'もう一度作成・検証' : 'フォントを作成して検証'}
          </button>
          {blob && canShareFile(blob, fileName) && (
            <button className="btn" onClick={() => shareBlob(blob, fileName).catch(() => {})}>
              <Share2 size={18} />
              共有
            </button>
          )}
          <button
            className="btn primary"
            disabled={!blob}
            data-testid="download-font"
            onClick={() => {
              if (!blob) return;
              downloadBlob(blob, fileName);
              if (!allOk) toast('検証で問題が見つかったフォントです。内容を確認してください', 'error');
            }}
          >
            <Download size={18} />
            OTF をダウンロード
          </button>
        </>
      }
    >
      <div className="two-col">
        <div>
          <div className="field">
            <label>フォント名（表示用・日本語可）</label>
            <input className="input" value={font.displayName} onChange={(e) => setFont({ displayName: e.target.value })} />
          </div>
          <div className="field">
            <label>英字フォント名（必須・半角英数字）</label>
            <input className="input" value={font.familyName} onChange={(e) => setFont({ familyName: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {!nameOk && <span className="note err">半角英字で始まる、英数字・空白・ハイフンだけの名前にしてください。</span>}
          </div>
          <div className="field">
            <label>スタイル名</label>
            <input className="input" value={font.styleName} onChange={(e) => setFont({ styleName: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {!styleOk && <span className="note warn">半角英数字以外は「Regular」として書き出します。</span>}
          </div>
          <div className="field">
            <label>作者名（任意）</label>
            <input className="input" value={font.designer} onChange={(e) => setFont({ designer: e.target.value })} />
          </div>
          <p className="note">
            フォントは「単色の輪郭」だけを持ちます。ロゴで付けた色・縁取り・影・グラデーションは OTF には入りません（それらは PNG・SVG で書き出してください）。
          </p>
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px' }}>収録内容</h4>
          <p className="note" style={{ marginTop: 0 }}>
            作成済みの <b>{plan.glyphs.length}</b> 文字を収録します（文字セットが揃っていなくても書き出せます）。半角・全角スペースは自動で追加されます。
          </p>
          <ul className="check-list">
            {counts.map((c) => (
              <li key={c.label}>
                {c.label}：{c.done} / {c.total}
              </li>
            ))}
            {others > 0 && <li>漢字・その他：{others}</li>}
          </ul>
          {errors.map((i, k) => (
            <p key={'e' + k} className="note err">
              {i.message}
            </p>
          ))}
          {warns.map((i, k) => (
            <p key={'w' + k} className="note warn">
              {i.message}
            </p>
          ))}
          {plan.glyphs.length === 0 && <p className="note warn">まだ作成済みの文字がありません。</p>}
          {err && <p className="note err">{err}</p>}
          {built && (
            <div className="section">
              <h4>検証結果（{(built.size / 1024).toFixed(1)} KB）</h4>
              <ul className="check-list">
                {built.verify.checks.map((c, i) => (
                  <li key={i}>
                    {c.ok ? <CircleCheck size={18} className="ok" /> : <TriangleAlert size={18} className="ng" />}
                    <span>
                      {c.label}
                      {c.detail && !c.ok ? `：${c.detail}` : ''}
                    </span>
                  </li>
                ))}
                {built.browserCheck && (
                  <li>
                    {built.browserCheck.ok ? <CircleCheck size={18} className="ok" /> : <TriangleAlert size={18} className="ng" />}
                    <span>ブラウザで読み込み：{built.browserCheck.detail}</span>
                  </li>
                )}
              </ul>
              {built.family && (
                <div className="field">
                  <label>試し書き（作成したフォントで表示）</label>
                  <input className="input" value={sample} onChange={(e) => setSample(e.target.value)} />
                  <div style={{ fontFamily: `"${built.family}", serif`, fontSize: 44, lineHeight: 1.3, padding: '8px 4px', background: '#fff', border: '1px solid var(--line)', borderRadius: 10, marginTop: 6, wordBreak: 'break-all' }}>
                    {sample || ' '}
                  </div>
                  <p className="note">収録していない文字は、端末の別のフォント（明朝など）で表示されます。</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
