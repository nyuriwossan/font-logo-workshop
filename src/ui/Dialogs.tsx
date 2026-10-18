import { useState } from 'react';
import { Plus, Copy, Trash, Pencil, Download, Upload, FolderOpen } from 'lucide-react';
import { Modal } from './controls';
import { useStore, openProject, createProject, duplicateProject, renameProject, removeProject, flushSave, importData, toast } from '../store/store';
import { makeBackup, parseBackup, resolveConflicts } from '../store/backup';
import * as dbm from '../store/db';
import { downloadBlob } from '../render/exporter';
import { pickFile } from './imageImport';
import { registerPart } from '../editor/actions';

// ===== プロジェクト管理 =====

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.data?.project.id);
  const [busy, setBusy] = useState(false);
  const wrap = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(String((e as Error).message || e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="プロジェクト"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy}
          onClick={wrap(async () => {
            const n = prompt('新しいプロジェクトの名前', '新しいプロジェクト');
            if (n === null) return;
            await createProject(n.trim());
            onClose();
          })}
        >
          <Plus size={18} />
          新しいプロジェクト
        </button>
      }
    >
      <p className="note" style={{ marginTop: 0 }}>
        プロジェクトごとに、文字・ロゴ・画像合成をまとめて保存します。パーツ棚はすべてのプロジェクトで共通です。
      </p>
      <div className="list">
        {projects.map((p) => (
          <div key={p.id} className={'item' + (p.id === current ? ' on' : '')}>
            <button
              className="name"
              disabled={busy}
              onClick={wrap(async () => {
                if (p.id !== current) await openProject(p.id);
                onClose();
              })}
            >
              {p.name}
              <div className="sub">
                作成済み {p.glyphCount} 文字・{new Date(p.updatedAt).toLocaleString('ja-JP')}
                {p.id === current ? '・開いています' : ''}
              </div>
            </button>
            <button
              className="ibtn sm"
              title="名前を変更"
              aria-label="名前を変更"
              onClick={wrap(async () => {
                const n = prompt('プロジェクト名', p.name);
                if (n && n.trim()) await renameProject(p.id, n.trim());
              })}
            >
              <Pencil size={16} />
            </button>
            <button className="ibtn sm" title="複製" aria-label="複製" onClick={wrap(() => duplicateProject(p.id))}>
              <Copy size={16} />
            </button>
            <button
              className="ibtn sm"
              title="削除"
              aria-label="削除"
              onClick={wrap(async () => {
                if (!confirm(`「${p.name}」を削除しますか？\nこの操作は取り消せません。必要なら先にバックアップを書き出してください。`)) return;
                await removeProject(p.id);
              })}
            >
              <Trash size={16} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ===== バックアップ =====

export function BackupDialog({ onClose }: { onClose: () => void }) {
  const persisted = useStore((s) => s.persisted);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string }[]>([]);
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);

  const doExport = async (all: boolean) => {
    setBusy(true);
    setResult([]);
    try {
      if (!(await flushSave())) throw new Error('保存に失敗しているため、最新の状態を書き出せません。');
      const s = useStore.getState();
      const ids = all ? s.projects.map((p) => p.id) : [s.data!.project.id];
      const projects = [];
      for (const id of ids) {
        const p = await dbm.loadProject(id);
        if (p) projects.push(p);
      }
      const backup = await makeBackup(projects, s.data!.parts, dbm.getAsset);
      const text = JSON.stringify(backup);
      // 書き出した JSON を読み直して確認
      const check = parseBackup(text);
      if (check.projects.length !== projects.length) throw new Error('バックアップの検証に失敗しました');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      downloadBlob(new Blob([text], { type: 'application/json' }), `font-logo-workshop-backup-${stamp}.json`);
      await dbm.setMeta('lastBackup', Date.now()).catch(() => {});
      setResult([{ kind: 'ok', text: `プロジェクト ${projects.length} 件・パーツ ${backup.parts.length} 件・画像 ${backup.assets.length} 件を書き出しました。` }]);
    } catch (e) {
      setResult([{ kind: 'err', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const f = await pickFile('application/json,.json');
    if (!f) return;
    setBusy(true);
    setResult([]);
    try {
      const parsed = parseBackup(await f.text());
      const s = useStore.getState();
      const { projects, newParts } = resolveConflicts(parsed, new Set(s.projects.map((p) => p.id)), s.data!.parts);
      await importData(projects, newParts, parsed.assets);
      const out: { kind: 'ok' | 'err' | 'warn'; text: string }[] = [
        { kind: 'ok', text: `プロジェクト ${projects.length} 件・パーツ ${newParts.length} 件を復元しました。プロジェクト一覧から開けます。` },
      ];
      parsed.warnings.forEach((w) => out.push({ kind: 'warn', text: w }));
      setResult(out);
    } catch (e) {
      setResult([{ kind: 'err', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="保存とバックアップ" onClose={onClose}>
      <p className="note warn" style={{ marginTop: 0 }}>
        作品はこの端末のブラウザ内に自動保存されます。ブラウザのデータ消去や、長期間使わなかった場合などに消えることがあるため、定期的にバックアップ（JSON）を書き出してください。
      </p>
      <div className="section">
        <h4>バックアップを書き出す</h4>
        <div className="row wrap">
          <button className="btn primary" disabled={busy} onClick={() => doExport(true)} data-testid="backup-all">
            <Download size={18} />
            すべてのプロジェクト＋パーツ棚
          </button>
          <button className="btn" disabled={busy} onClick={() => doExport(false)}>
            <Download size={18} />
            いまのプロジェクト＋パーツ棚
          </button>
        </div>
        <p className="note">文字・ロゴ・合成・パーツ・背景画像を、再編集できる形でまとめて保存します。</p>
      </div>
      <div className="section">
        <h4>バックアップから復元</h4>
        <button className="btn" disabled={busy} onClick={doImport} data-testid="restore">
          <Upload size={18} />
          JSON ファイルを選んで復元
        </button>
        <p className="note">今あるデータは上書きしません。同じプロジェクトがある場合は「（復元）」付きの別プロジェクトとして追加します。</p>
      </div>
      {result.map((r, i) => (
        <p key={i} className={'note ' + (r.kind === 'ok' ? 'ok' : r.kind === 'err' ? 'err' : 'warn')}>
          {r.text}
        </p>
      ))}
      <div className="section">
        <h4>この端末での保存状態</h4>
        <ul className="check-list">
          <li>
            {persisted ? '✓ ブラウザに「消さない保存領域」として登録済み' : persisted === false ? '・保存領域の永続化は許可されていません（ブラウザの判断で消える可能性があります）' : '・保存領域の永続化：確認できません'}
          </li>
          <li>{standalone ? '✓ ホーム画面のアプリとして起動中' : '・iPad では、共有ボタン →「ホーム画面に追加」から起動すると、データが消えにくくなります'}</li>
        </ul>
      </div>
    </Modal>
  );
}

// ===== パーツ登録 =====

export function PartSaveDialog({ onClose }: { onClose: () => void }) {
  const parts = useStore((s) => s.data!.parts);
  const cats = Array.from(new Set(['濁点・半濁点', 'へん・つくり', '飾り', '線', ...parts.map((p) => p.category)]));
  const [name, setName] = useState('');
  const [cat, setCat] = useState(parts[parts.length - 1]?.category ?? '飾り');
  return (
    <Modal
      title="パーツに登録"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            やめる
          </button>
          <button
            className="btn primary"
            data-testid="part-save"
            onClick={() => {
              if (registerPart(name || 'パーツ', cat || '未分類')) onClose();
            }}
          >
            登録する
          </button>
        </>
      }
    >
      <div className="field">
        <label>パーツ名</label>
        <input className="input" autoFocus value={name} placeholder="例：濁点、さんずい、飾り線" onChange={(e) => setName(e.target.value)} data-testid="part-name" />
      </div>
      <div className="field">
        <label>カテゴリ</label>
        <input className="input" value={cat} onChange={(e) => setCat(e.target.value)} list="part-cats" />
        <datalist id="part-cats">
          {cats.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div className="tabs" style={{ marginTop: 6 }}>
          {cats.slice(0, 8).map((c) => (
            <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <p className="note">編集できるベクターデータのまま保存します。すべてのプロジェクトで使えます。</p>
    </Modal>
  );
}

// ===== 使い方 =====

const STEPS: [string, string][] = [
  ['文字を描く', '左の文字一覧から「あ」などを選び、Apple Pencil で描きます。薄いお手本はオン・オフできます。指 2 本でつまむと拡大・移動、2 本指タップで取り消しです。'],
  ['あとから直す', '「選択」ツールで線を選ぶと、移動・拡大・回転・反転ができます。「調整」タブでは、描いた後の線の太さや滑らかさも変えられます。図形や曲線は「デザイン」モードで作り、「制御点」で形を直します。'],
  ['パーツで再利用', '線や図形を選んで「パーツに登録」。パーツ棚のサムネイルをタップすると、別の文字やロゴに挿入できます。濁点・へん・飾り線などに便利です。'],
  ['ロゴを作る', '上の「ロゴ」で文字ツールを選び、タイトルを入力します。作成済みの字形が自動で使われ、未作成の文字は点線の枠付きで代用表示されます。色・縁取り・影・グラデーションを付けて、透過 PNG・SVG で保存できます。'],
  ['画像に重ねる', '「合成」で写真や生成 AI のイラストを読み込み、作ったロゴを配置して PNG・JPEG で保存します。画像は端末の外へは送信されません。'],
  ['フォントにする', '右上の「フォント」から、作成済みの文字だけで OTF を書き出せます。書き出し後に自動で読み込み直して検証します。'],
  ['データを守る', '自動保存されますが、ブラウザのデータ消去で消えることがあります。メニューの「保存とバックアップ」から JSON を時々書き出してください。iPad はホーム画面に追加して使うのがおすすめです。'],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [title, body] = STEPS[i];
  return (
    <Modal
      title="使い方"
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>
            戻る
          </button>
          {i < STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setI(i + 1)}>
              次へ（{i + 1}/{STEPS.length}）
            </button>
          ) : (
            <button className="btn primary" onClick={onClose}>
              はじめる
            </button>
          )}
        </>
      }
    >
      <div className="tut-step">
        <div className="num">{i + 1}</div>
        <div>
          <h4 style={{ margin: '4px 0 0', fontSize: 17 }}>{title}</h4>
          <p>{body}</p>
        </div>
      </div>
      <div className="section">
        <h4>キーボード（PC・Magic Keyboard）</h4>
        <p className="note" style={{ lineHeight: 2 }}>
          <span className="kbd">⌘/Ctrl+Z</span> 取り消し　<span className="kbd">⇧+⌘/Ctrl+Z</span> やり直し　<span className="kbd">⌘/Ctrl+D</span> 複製　<span className="kbd">Delete</span> 削除
          <span className="kbd">V</span> 選択　<span className="kbd">P</span> ペン　<span className="kbd">E</span> 消しゴム　<span className="kbd">スペース</span>+ドラッグ 移動　<span className="kbd">0</span> 全体表示
        </p>
      </div>
      <div className="section">
        <button className="btn sm" onClick={() => setI(0)}>
          <FolderOpen size={14} />
          最初から見る
        </button>
      </div>
    </Modal>
  );
}
