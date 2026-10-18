import { useEffect, useState } from 'react';
import { Undo2, Redo2, Download, CircleQuestionMark, Menu, PanelLeft, PanelRight, FileType, Archive, FolderOpen } from 'lucide-react';
import { useStore, undo, redo, setRoute, setUi, flushSave, isDirty, toast, commit } from './store/store';
import { newLogo, newComposite } from './model/defaults';
import { LeftPanel } from './ui/LeftPanel';
import { RightPanel } from './ui/RightPanel';
import { EditorView } from './ui/EditorView';
import { ExportDialog } from './ui/ExportDialog';
import { FontDialog } from './ui/FontDialog';
import { ProjectsDialog, BackupDialog, PartSaveDialog, HelpDialog } from './ui/Dialogs';
import { getMeta, setMeta } from './store/db';

type DialogKind = 'export' | 'font' | 'projects' | 'backup' | 'part' | 'help' | null;

export function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const data = useStore((s) => s.data);
  const [dialog, setDialog] = useState<DialogKind>(null);

  useEffect(() => {
    const onExport = () => setDialog('export');
    const onPart = () => {
      if (useStore.getState().ui.selection.length) setDialog('part');
      else toast('パーツにしたい線や図形を、先に選択してください');
    };
    window.addEventListener('flw:export', onExport);
    window.addEventListener('flw:register-part', onPart);
    return () => {
      window.removeEventListener('flw:export', onExport);
      window.removeEventListener('flw:register-part', onPart);
    };
  }, []);

  // 初回は使い方を表示
  useEffect(() => {
    if (!ready || bootError) return;
    getMeta<boolean>('tutorialSeen')
      .then((seen) => {
        if (!seen) {
          setDialog('help');
          setMeta('tutorialSeen', true).catch(() => {});
        }
      })
      .catch(() => {});
  }, [ready]);

  // アプリ切り替え・終了時にすぐ保存
  useEffect(() => {
    const flush = () => {
      if (isDirty()) void flushSave();
    };
    const vis = () => document.visibilityState === 'hidden' && flush();
    const before = (e: BeforeUnloadEvent) => {
      if (isDirty() || useStore.getState().save.state === 'error') {
        flush();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', before);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', before);
    };
  }, []);

  if (!ready) return <div className="boot">読み込み中…</div>;
  if (bootError || !data)
    return (
      <div className="boot">
        <div>
          <b>データを読み込めませんでした。</b>
          <br />
          {bootError}
          <br />
          プライベートブラウズでは保存領域が使えない場合があります。通常のタブで開き直してください。
        </div>
      </div>
    );

  return (
    <div className="app">
      <TopBar open={setDialog} />
      <SaveErrorBanner />
      <Body />
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'font' && <FontDialog onClose={() => setDialog(null)} />}
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'backup' && <BackupDialog onClose={() => setDialog(null)} />}
      {dialog === 'part' && <PartSaveDialog onClose={() => setDialog(null)} />}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      <Toast />
      <UpdatePrompt />
    </div>
  );
}

function Body() {
  const leftOpen = useStore((s) => s.ui.leftOpen);
  const rightOpen = useStore((s) => s.ui.rightOpen);
  return (
    <div className="body">
      {leftOpen && <LeftPanel />}
      <EditorView />
      {rightOpen && <RightPanel />}
    </div>
  );
}

function TopBar({ open }: { open: (d: DialogKind) => void }) {
  const project = useStore((s) => s.data!.project);
  const route = useStore((s) => s.route);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const ui = useStore((s) => s.ui);
  const [menu, setMenu] = useState(false);
  const mode = route.screen === 'glyph' ? 'glyph' : route.screen === 'logo' ? 'logo' : route.screen === 'composite' ? 'composite' : 'part';
  const go = (m: string) => {
    const p = useStore.getState().data!.project;
    if (m === 'glyph') setRoute({ screen: 'glyph', cp: lastCp });
    if (m === 'logo') {
      const l = p.logos.find((x) => x.id === lastLogo) ?? p.logos[0];
      if (l) setRoute({ screen: 'logo', id: l.id });
      else {
        const nl = newLogo('タイトルロゴ 1');
        commit((d) => {
          d.project.logos.push(nl);
        });
        setRoute({ screen: 'logo', id: nl.id });
      }
    }
    if (m === 'composite') {
      const c = p.composites.find((x) => x.id === lastComp) ?? p.composites[0];
      if (c) setRoute({ screen: 'composite', id: c.id });
      else {
        // 合成がまだ無いときは、背景なしの合成を 1 つ作って開く（背景画像はあとから読み込める）
        const nc = newComposite('画像合成 1', 1600, 1200, null);
        commit((d) => {
          d.project.composites.push(nc);
        });
        setRoute({ screen: 'composite', id: nc.id });
        setUi({ rightOpen: true, rightTab: 'props' });
      }
    }
  };
  if (route.screen === 'glyph') lastCp = route.cp;
  if (route.screen === 'logo') lastLogo = route.id;
  if (route.screen === 'composite') lastComp = route.id;
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          字
        </div>
        <button className="project-btn" onClick={() => open('projects')} title="プロジェクトを切り替え">
          <FolderOpen size={18} />
          {project.name}
        </button>
      </div>
      <button className={'ibtn' + (ui.leftOpen ? ' on' : '')} onClick={() => setUi({ leftOpen: !ui.leftOpen })} aria-label="左パネル" title="左パネル">
        <PanelLeft size={20} />
      </button>
      <div className="seg" role="tablist" aria-label="制作モード">
        <button className={mode === 'glyph' ? 'on' : ''} onClick={() => go('glyph')} data-testid="mode-glyph">
          文字
        </button>
        <button className={mode === 'logo' ? 'on' : ''} onClick={() => go('logo')} data-testid="mode-logo">
          ロゴ
        </button>
        <button className={mode === 'composite' ? 'on' : ''} onClick={() => go('composite')} data-testid="mode-composite">
          合成
        </button>
      </div>
      <div className="spacer" />
      <SaveChip onRetry={() => flushSave()} />
      <button className="ibtn" onClick={undo} disabled={!canUndo} aria-label="取り消し" title="取り消し（⌘Z）" data-testid="undo">
        <Undo2 size={22} />
      </button>
      <button className="ibtn" onClick={redo} disabled={!canRedo} aria-label="やり直し" title="やり直し（⇧⌘Z）" data-testid="redo">
        <Redo2 size={22} />
      </button>
      <button className="btn" onClick={() => open('export')} disabled={route.screen === 'part'} data-testid="open-export">
        <Download size={18} />
        書き出し
      </button>
      <button className="btn" onClick={() => open('font')} data-testid="open-font">
        <FileType size={18} />
        フォント
      </button>
      <div style={{ position: 'relative' }}>
        <button className="ibtn" onClick={() => setMenu(!menu)} aria-label="メニュー" title="メニュー" data-testid="menu">
          <Menu size={22} />
        </button>
        {menu && (
          <div className="menu-pop" style={{ right: 0, top: '110%' }} onPointerLeave={() => setMenu(false)}>
            <button
              onClick={() => {
                setMenu(false);
                open('projects');
              }}
            >
              <FolderOpen size={16} />
              プロジェクト
            </button>
            <button
              data-testid="open-backup"
              onClick={() => {
                setMenu(false);
                open('backup');
              }}
            >
              <Archive size={16} />
              保存とバックアップ
            </button>
            <button
              onClick={() => {
                setMenu(false);
                open('help');
              }}
            >
              <CircleQuestionMark size={16} />
              使い方
            </button>
          </div>
        )}
      </div>
      <button className={'ibtn' + (ui.rightOpen ? ' on' : '')} onClick={() => setUi({ rightOpen: !ui.rightOpen })} aria-label="右パネル" title="右パネル">
        <PanelRight size={20} />
      </button>
    </header>
  );
}

let lastCp = 0x3042;
let lastLogo = '';
let lastComp = '';

function SaveChip({ onRetry }: { onRetry: () => void }) {
  const save = useStore((s) => s.save);
  const label = save.state === 'saved' ? '保存済み' : save.state === 'saving' ? '保存中…' : save.state === 'pending' ? '未保存の変更' : '保存できません';
  return (
    <button className={'save-chip ' + save.state} onClick={save.state === 'error' ? onRetry : undefined} title={save.message ?? label} style={{ border: 0, background: undefined }} data-testid="save-status" data-state={save.state}>
      <span className="dot" />
      {label}
    </button>
  );
}

function SaveErrorBanner() {
  const save = useStore((s) => s.save);
  if (save.state !== 'error') return null;
  return (
    <div className="banner" role="alert">
      <b>保存に失敗しました。</b>
      <span>{save.message}。この状態でページを閉じると、最後の変更が失われます。</span>
      <button className="btn sm danger" onClick={() => flushSave()}>
        もう一度保存
      </button>
    </div>
  );
}

function Toast() {
  const t = useStore((s) => s.toast);
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    if (!t) return;
    setVisible(t.id);
    const h = setTimeout(() => setVisible(null), t.kind === 'error' ? 6000 : 3200);
    return () => clearTimeout(h);
  }, [t?.id]);
  if (!t || visible !== t.id) return null;
  return (
    <div className={'toast ' + t.kind} role="status">
      {t.text}
    </div>
  );
}

function UpdatePrompt() {
  const [need, setNeed] = useState<null | (() => void)>(null);
  useEffect(() => {
    const h = (e: Event) => setNeed(() => (e as CustomEvent).detail as () => void);
    window.addEventListener('flw:need-refresh', h);
    return () => window.removeEventListener('flw:need-refresh', h);
  }, []);
  if (!need) return null;
  return (
    <div className="toast" role="status">
      新しいバージョンがあります
      <button
        onClick={async () => {
          await flushSave();
          need();
        }}
      >
        更新
      </button>
      <button onClick={() => setNeed(null)}>あとで</button>
    </div>
  );
}
