import { useMemo, useState } from 'react';
import { Plus, Search, Copy, Trash, Pencil, ImagePlus, X } from 'lucide-react';
import { useStore, setRoute, commit, setUi, toast, returnRoute } from '../store/store';
import { BUILTIN_SETS, KANJI_SET_ID, cpOf, extractChars, setOfChar, unicodeLabel } from '../model/charsets';
import { GlyphThumb } from './thumbs';
import { glyphOutline } from '../geom/outline';
import { newLogo, newComposite } from '../model/defaults';
import { uid } from '../model/ids';
import { importImageAsset } from './imageImport';
import type { Logo, Composite } from '../model/types';

function SidePanelShell(props: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const ui = useStore((s) => s.ui);
  return (
    <aside className="side left" style={{ width: ui.leftW }}>
      <div className="side-head">
        <div className="side-title">{props.title}</div>
        {props.actions}
        <button className="ibtn sm" onClick={() => setUi({ leftOpen: false })} aria-label="パネルを閉じる" title="パネルを閉じる">
          <X size={18} />
        </button>
      </div>
      <div className="side-scroll">{props.children}</div>
      <ResizeHandle side="left" />
    </aside>
  );
}

export function ResizeHandle({ side }: { side: 'left' | 'right' }) {
  const onDown = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const ui = useStore.getState().ui;
    const w0 = side === 'left' ? ui.leftW : ui.rightW;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.max(200, Math.min(480, w0 + (side === 'left' ? dx : -dx)));
      setUi(side === 'left' ? { leftW: w } : { rightW: w });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="side-resize" onPointerDown={onDown} aria-hidden />;
}

export function LeftPanel() {
  const route = useStore((s) => s.route);
  if (route.screen === 'glyph') return <GlyphListPanel />;
  if (route.screen === 'logo') return <LogoListPanel />;
  if (route.screen === 'composite') return <CompositeListPanel />;
  return <PartEditPanel />;
}

// ===== 文字一覧 =====

function GlyphListPanel() {
  const project = useStore((s) => s.data!.project);
  const route = useStore((s) => s.route);
  const [tab, setTab] = useState<string>(() => setOfChar(String.fromCodePoint(route.screen === 'glyph' ? route.cp : 0x3042)));
  const [q, setQ] = useState('');
  const [onlyDone, setOnlyDone] = useState(false);
  const [kanjiInput, setKanjiInput] = useState('');
  const current = route.screen === 'glyph' ? route.cp : -1;

  const doneSet = useMemo(() => {
    const s = new Set<number>();
    for (const g of Object.values(project.glyphs)) if (g.objects.length && !glyphOutline(g).empty) s.add(g.cp);
    return s;
  }, [project.glyphs]);

  const chars = useMemo(() => {
    if (q.trim()) {
      const list = extractChars(q);
      return list;
    }
    if (tab === 'done') return [...doneSet].sort((a, b) => a - b).map((c) => String.fromCodePoint(c));
    if (tab === KANJI_SET_ID) {
      const builtin = new Set(BUILTIN_SETS.flatMap((s) => s.chars));
      const extra = [...doneSet].map((c) => String.fromCodePoint(c)).filter((c) => !builtin.has(c) && !project.customChars.includes(c));
      return [...project.customChars, ...extra];
    }
    return BUILTIN_SETS.find((s) => s.id === tab)?.chars ?? [];
  }, [tab, q, project.customChars, doneSet]);

  const shown = onlyDone ? chars.filter((c) => doneSet.has(cpOf(c))) : chars;
  const total = BUILTIN_SETS.find((s) => s.id === tab)?.chars.length;

  const addKanji = () => {
    const list = extractChars(kanjiInput);
    if (!list.length) return;
    const builtin = new Set(BUILTIN_SETS.flatMap((s) => s.chars));
    const add = list.filter((c) => !builtin.has(c) && !project.customChars.includes(c));
    if (add.length)
      commit((d) => {
        d.project.customChars.push(...add);
      });
    setKanjiInput('');
    setTab(KANJI_SET_ID);
    toast(add.length ? `${add.length} 文字を追加しました` : 'すでに一覧にある文字です');
  };

  const removeCustom = (ch: string) => {
    commit((d) => {
      d.project.customChars = d.project.customChars.filter((c) => c !== ch);
    });
  };

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of BUILTIN_SETS) m[s.id] = s.chars.filter((c) => doneSet.has(cpOf(c))).length;
    return m;
  }, [doneSet]);

  return (
    <SidePanelShell title={`文字一覧（作成済み ${doneSet.size}）`}>
      <div className="field">
        <div className="row" style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 10, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="文字を検索（例：あ、A、漢）" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!q && (
        <div className="tabs" role="tablist">
          {BUILTIN_SETS.map((s) => (
            <button key={s.id} className={tab === s.id ? 'on' : ''} onClick={() => setTab(s.id)}>
              {s.label}
              {counts[s.id] ? ` ${counts[s.id]}` : ''}
            </button>
          ))}
          <button className={tab === KANJI_SET_ID ? 'on' : ''} onClick={() => setTab(KANJI_SET_ID)}>
            漢字・追加
          </button>
          <button className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>
            作成済み
          </button>
        </div>
      )}
      {tab === KANJI_SET_ID && !q && (
        <div className="field">
          <span className="field-label">漢字などを追加（複数可）</span>
          <div className="row">
            <input className="input" value={kanjiInput} placeholder="例：氷 花 夢" onChange={(e) => setKanjiInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addKanji()} />
            <button className="btn" onClick={addKanji}>
              <Plus size={16} />
              追加
            </button>
          </div>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <label className="toggle" style={{ minHeight: 32, fontSize: 13 }}>
          <input type="checkbox" checked={onlyDone} onChange={(e) => setOnlyDone(e.target.checked)} />
          作成済みのみ
        </label>
        {total !== undefined && !q && (
          <span className="note" style={{ margin: 0 }}>
            {counts[tab] ?? 0} / {total}
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="empty">{tab === KANJI_SET_ID ? '上の入力欄から、作りたい漢字を追加できます。' : '該当する文字がありません。'}</div>
      ) : (
        <div className="glyph-grid">
          {shown.map((ch) => {
            const cp = cpOf(ch);
            const g = project.glyphs[String(cp)];
            const done = doneSet.has(cp);
            return (
              <button
                key={ch}
                className={'gcell' + (done ? ' done' : '') + (cp === current ? ' on' : '')}
                onClick={() => setRoute({ screen: 'glyph', cp })}
                title={`${ch}（${unicodeLabel(cp)}）${done ? '・作成済み' : '・未作成'}`}
                aria-label={`${ch} ${done ? '作成済み' : '未作成'}`}
                onContextMenu={(e) => {
                  if (tab === KANJI_SET_ID && project.customChars.includes(ch) && !done) {
                    e.preventDefault();
                    if (confirm(`「${ch}」を一覧から外しますか？`)) removeCustom(ch);
                  }
                }}
              >
                {done && g ? <GlyphThumb glyph={g} /> : <span className="ref">{ch}</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="note" style={{ marginTop: 12 }}>
        右上に点がある文字は作成済みです。フォントには作成済みの文字だけが入ります。
      </p>
    </SidePanelShell>
  );
}

// ===== ロゴ一覧 =====

function LogoListPanel() {
  const logos = useStore((s) => s.data!.project.logos);
  const route = useStore((s) => s.route);
  const add = () => {
    const l = newLogo(`タイトルロゴ ${logos.length + 1}`);
    commit((d) => {
      d.project.logos.push(l);
    });
    setRoute({ screen: 'logo', id: l.id });
  };
  return (
    <SidePanelShell
      title="ロゴ"
      actions={
        <button className="ibtn sm" onClick={add} title="新しいロゴ" aria-label="新しいロゴ">
          <Plus size={20} />
        </button>
      }
    >
      <div className="list">
        {logos.map((l) => (
          <DocItem
            key={l.id}
            item={l}
            on={route.screen === 'logo' && route.id === l.id}
            onOpen={() => setRoute({ screen: 'logo', id: l.id })}
            onRename={(name) =>
              commit((d) => {
                const x = d.project.logos.find((y) => y.id === l.id);
                if (x) x.name = name;
              })
            }
            onDuplicate={() => {
              const copy: Logo = { ...structuredClone(l), id: uid('logo'), name: `${l.name} のコピー`, updatedAt: Date.now() };
              commit((d) => {
                d.project.logos.push(copy);
              });
              setRoute({ screen: 'logo', id: copy.id });
            }}
            onDelete={() => {
              const used = useStore.getState().data!.project.composites.some((c) => c.objects.some((o) => o.type === 'logoRef' && o.logoId === l.id));
              if (!confirm(`ロゴ「${l.name}」を削除しますか？${used ? '\n※画像合成で使われています。合成からも表示されなくなります。' : ''}`)) return;
              commit((d) => {
                d.project.logos = d.project.logos.filter((x) => x.id !== l.id);
              });
              const rest = useStore.getState().data!.project.logos;
              if (rest[0]) setRoute({ screen: 'logo', id: rest[0].id });
              else setRoute({ screen: 'glyph', cp: 0x3042 });
            }}
            sub={`${l.width}×${l.height}・${l.objects.length} 要素`}
          />
        ))}
      </div>
      {logos.length === 0 && <div className="empty">右上の＋で新しいロゴを作れます。</div>}
      <p className="note" style={{ marginTop: 12 }}>
        文字ツール（T）でタイトルを入れると、作成済みの字形が自動で使われます。未作成の文字は端末のフォントで代用表示されます。
      </p>
    </SidePanelShell>
  );
}

function DocItem(props: {
  item: { id: string; name: string };
  on: boolean;
  sub: string;
  onOpen: () => void;
  onRename: (n: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={'item' + (props.on ? ' on' : '')}>
      <button className="name" onClick={props.onOpen}>
        {props.item.name}
        <div className="sub">{props.sub}</div>
      </button>
      <button
        className="ibtn sm"
        title="名前を変更"
        aria-label="名前を変更"
        onClick={() => {
          const n = prompt('名前', props.item.name);
          if (n && n.trim()) props.onRename(n.trim());
        }}
      >
        <Pencil size={16} />
      </button>
      <button className="ibtn sm" title="複製" aria-label="複製" onClick={props.onDuplicate}>
        <Copy size={16} />
      </button>
      <button className="ibtn sm" title="削除" aria-label="削除" onClick={props.onDelete}>
        <Trash size={16} />
      </button>
    </div>
  );
}

// ===== 合成一覧 =====

function CompositeListPanel() {
  const comps = useStore((s) => s.data!.project.composites);
  const route = useStore((s) => s.route);
  const addFromImage = async () => {
    const a = await importImageAsset();
    if (!a) return;
    const c = newComposite(`画像合成 ${comps.length + 1}`, a.width, a.height, a.id);
    commit((d) => {
      d.project.composites.push(c);
    });
    setRoute({ screen: 'composite', id: c.id });
  };
  const addBlank = () => {
    const c = newComposite(`画像合成 ${comps.length + 1}`, 1600, 1200, null);
    commit((d) => {
      d.project.composites.push(c);
    });
    setRoute({ screen: 'composite', id: c.id });
  };
  return (
    <SidePanelShell title="画像合成">
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn primary block" onClick={addFromImage}>
          <ImagePlus size={18} />
          画像を読み込んで新規
        </button>
      </div>
      <button className="btn sm block" style={{ marginBottom: 12 }} onClick={addBlank}>
        背景なしで新規
      </button>
      <div className="list">
        {comps.map((c) => (
          <DocItem
            key={c.id}
            item={c}
            on={route.screen === 'composite' && route.id === c.id}
            onOpen={() => setRoute({ screen: 'composite', id: c.id })}
            onRename={(name) =>
              commit((d) => {
                const x = d.project.composites.find((y) => y.id === c.id);
                if (x) x.name = name;
              })
            }
            onDuplicate={() => {
              const copy: Composite = { ...structuredClone(c), id: uid('cmp'), name: `${c.name} のコピー`, updatedAt: Date.now() };
              commit((d) => {
                d.project.composites.push(copy);
              });
              setRoute({ screen: 'composite', id: copy.id });
            }}
            onDelete={() => {
              if (!confirm(`「${c.name}」を削除しますか？`)) return;
              commit((d) => {
                d.project.composites = d.project.composites.filter((x) => x.id !== c.id);
              });
              const rest = useStore.getState().data!.project.composites;
              if (rest[0]) setRoute({ screen: 'composite', id: rest[0].id });
            }}
            sub={`${c.width}×${c.height}${c.assetId ? '' : '・背景なし'}`}
          />
        ))}
      </div>
      {comps.length === 0 && <div className="empty">写真や生成AIのイラストを読み込んで、作ったロゴや文字を重ねられます。画像は端末の外へ送信されません。</div>}
    </SidePanelShell>
  );
}

function PartEditPanel() {
  const route = useStore((s) => s.route);
  const part = useStore((s) => (route.screen === 'part' ? s.data!.parts.find((p) => p.id === route.id) : undefined));
  return (
    <SidePanelShell title="パーツを編集中">
      <p className="note">
        パーツ「{part?.name ?? ''}」の元データを編集しています。ここでの変更は、すでに文字やロゴへ貼り付けたパーツには反映されません（貼り付けた時点で独立したコピーになります）。
      </p>
      <button className="btn block" onClick={() => setRoute(returnRoute)}>
        元の画面に戻る
      </button>
    </SidePanelShell>
  );
}
