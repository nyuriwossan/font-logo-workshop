import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Frame, Obj, Part, PenSettings, Project, ProjectMeta, Route, Tool } from '../model/types';
import { defaultPen, newGlyph, newProject } from '../model/defaults';
import { uid } from '../model/ids';
import * as dbm from './db';

export interface Data {
  project: Project;
  parts: Part[];
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface UI {
  tool: Tool;
  pen: PenSettings;
  eraserMode: 'object' | 'partial';
  eraserSize: number;
  shapeFill: boolean;
  shapeStroke: number;
  polygonSides: number;
  snap: boolean;
  gridStep: number;
  showGrid: boolean;
  showTemplate: boolean;
  /** Pencil を検出したら指は移動専用になる。false にすると指でも描ける */
  fingerDraws: boolean;
  penDetected: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  leftW: number;
  rightW: number;
  rightTab: 'tool' | 'parts' | 'layers' | 'props';
  glyphMode: 'hand' | 'design';
  selection: string[];
  /** ロゴ：文字単位編集中のテキスト */
  charEdit: { id: string; index: number | null } | null;
  decoColor: string;
  keepRatio: boolean;
  multiSelect: boolean;
  showFallbackMarks: boolean;
  /** 制御点ツールで選択中の点 */
  nodeSel: number | null;
  /** 曲線ツールで描きかけの点の数（確定ボタン表示用） */
  curvePending: number;
}

export interface Store {
  ready: boolean;
  bootError: string | null;
  projects: ProjectMeta[];
  data: Data | null;
  past: Data[];
  future: Data[];
  route: Route;
  ui: UI;
  save: { state: SaveState; message?: string; at?: number };
  persisted: boolean | null;
  toast: { id: number; text: string; kind: 'info' | 'error' } | null;
}

const UI_KEY = 'flw-ui-v1';

function loadUiPrefs(): Partial<UI> {
  try {
    const raw = localStorage.getItem(UI_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveUiPrefs(ui: UI) {
  try {
    const { pen, eraserMode, eraserSize, shapeFill, shapeStroke, polygonSides, snap, gridStep, showGrid, showTemplate, fingerDraws, leftW, rightW, glyphMode, decoColor, keepRatio, showFallbackMarks } = ui;
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({ pen, eraserMode, eraserSize, shapeFill, shapeStroke, polygonSides, snap, gridStep, showGrid, showTemplate, fingerDraws, leftW, rightW, glyphMode, decoColor, keepRatio, showFallbackMarks }),
    );
  } catch {
    /* 保存できない環境（プライベートブラウズ等）では無視 */
  }
}

const narrow = typeof window !== 'undefined' && window.innerWidth < 900;

const defaultUi: UI = {
  tool: 'pen',
  pen: defaultPen(),
  eraserMode: 'object',
  eraserSize: 40,
  shapeFill: true,
  shapeStroke: 40,
  polygonSides: 5,
  snap: false,
  gridStep: 50,
  showGrid: true,
  showTemplate: true,
  fingerDraws: false,
  penDetected: false,
  leftOpen: !narrow,
  rightOpen: !narrow,
  leftW: 260,
  rightW: 300,
  rightTab: 'tool',
  glyphMode: 'hand',
  selection: [],
  charEdit: null,
  decoColor: '#4a5a8c',
  keepRatio: true,
  multiSelect: false,
  showFallbackMarks: true,
  nodeSel: null,
  curvePending: 0,
};

export const useStore = create<Store>(() => ({
  ready: false,
  bootError: null,
  projects: [],
  data: null,
  past: [],
  future: [],
  route: { screen: 'glyph', cp: 0x3042 },
  ui: { ...defaultUi, ...loadUiPrefs(), selection: [], charEdit: null, multiSelect: false, penDetected: false, tool: 'pen', nodeSel: null, curvePending: 0 },
  save: { state: 'saved' },
  persisted: null,
  toast: null,
}));

const get = () => useStore.getState();
const set = useStore.setState;

let toastSeq = 0;
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  set({ toast: { id: ++toastSeq, text, kind } });
}

export function setUi(patch: Partial<UI>) {
  const ui = { ...get().ui, ...patch };
  set({ ui });
  saveUiPrefs(ui);
}

// ===== ドキュメント（編集対象）=====

export interface DocInfo {
  kind: Route['screen'];
  objects: Obj[];
  frame: Frame;
}

const EMPTY: Obj[] = [];

export function docOf(data: Data | null, route: Route): DocInfo | null {
  if (!data) return null;
  switch (route.screen) {
    case 'glyph':
      return { kind: 'glyph', objects: data.project.glyphs[String(route.cp)]?.objects ?? EMPTY, frame: { x: 0, y: 0, w: 1000, h: 1000 } };
    case 'logo': {
      const l = data.project.logos.find((x) => x.id === route.id);
      return l ? { kind: 'logo', objects: l.objects, frame: { x: 0, y: 0, w: l.width, h: l.height } } : null;
    }
    case 'composite': {
      const c = data.project.composites.find((x) => x.id === route.id);
      return c ? { kind: 'composite', objects: c.objects, frame: { x: 0, y: 0, w: c.width, h: c.height } } : null;
    }
    case 'part': {
      const p = data.parts.find((x) => x.id === route.id);
      return p ? { kind: 'part', objects: p.objects, frame: { x: -500, y: -500, w: 1000, h: 1000 } } : null;
    }
  }
}

/** 下書き上で編集対象のオブジェクト配列を書き換える */
export function editDocDraft(d: Draft<Data>, route: Route, fn: (objs: Obj[]) => void) {
  const now = Date.now();
  switch (route.screen) {
    case 'glyph': {
      const key = String(route.cp);
      if (!d.project.glyphs[key]) d.project.glyphs[key] = newGlyph(route.cp) as Draft<any>;
      const g = d.project.glyphs[key];
      fn(g.objects as Obj[]);
      g.updatedAt = now;
      return;
    }
    case 'logo': {
      const l = d.project.logos.find((x) => x.id === route.id);
      if (l) {
        fn(l.objects as Obj[]);
        l.updatedAt = now;
      }
      return;
    }
    case 'composite': {
      const c = d.project.composites.find((x) => x.id === route.id);
      if (c) {
        fn(c.objects as Obj[]);
        c.updatedAt = now;
      }
      return;
    }
    case 'part': {
      const p = d.parts.find((x) => x.id === route.id);
      if (p) {
        fn(p.objects as Obj[]);
        p.updatedAt = now;
      }
      return;
    }
  }
}

// ===== 履歴つき更新 =====

const HISTORY_LIMIT = 150;
let gestureBase: Data | null = null;

function stampProject(prev: Data, next: Data): Data {
  if (prev.project !== next.project) {
    return produce(next, (d) => {
      d.project.updatedAt = Date.now();
    });
  }
  return next;
}

export function commit(recipe: (d: Draft<Data>) => void) {
  const s = get();
  if (!s.data) return;
  const base = gestureBase ?? s.data;
  let next = produce(s.data, recipe);
  if (next === s.data) return;
  next = stampProject(s.data, next);
  if (gestureBase) {
    set({ data: next });
    return;
  }
  set({ data: next, past: [...s.past.slice(-HISTORY_LIMIT + 1), base], future: [] });
}

export function commitDoc(fn: (objs: Obj[]) => void) {
  const route = get().route;
  commit((d) => editDocDraft(d, route, fn));
}

/** ドラッグ等の連続操作。end までを 1 回の取り消し単位にする */
export function beginGesture() {
  gestureBase = get().data;
}
export function endGesture() {
  const s = get();
  const base = gestureBase;
  gestureBase = null;
  if (base && s.data && base !== s.data) set({ past: [...s.past.slice(-HISTORY_LIMIT + 1), base], future: [] });
}
export function cancelGesture() {
  if (gestureBase) set({ data: gestureBase });
  gestureBase = null;
}

function pruneSelection() {
  const s = get();
  const doc = docOf(s.data, s.route);
  const ids = new Set(doc?.objects.map((o) => o.id) ?? []);
  const sel = s.ui.selection.filter((id) => ids.has(id));
  if (sel.length !== s.ui.selection.length) set({ ui: { ...s.ui, selection: sel } });
}

export function undo() {
  const s = get();
  if (!s.past.length || !s.data || gestureBase) return;
  const prev = s.past[s.past.length - 1];
  set({ data: prev, past: s.past.slice(0, -1), future: [s.data, ...s.future] });
  fixRoute();
  pruneSelection();
}
export function redo() {
  const s = get();
  if (!s.future.length || !s.data || gestureBase) return;
  const next = s.future[0];
  set({ data: next, future: s.future.slice(1), past: [...s.past, s.data] });
  fixRoute();
  pruneSelection();
}

/** 取り消しでロゴ等が消えた場合に表示先を戻す */
function fixRoute() {
  const s = get();
  if (!s.data) return;
  if (!docOf(s.data, s.route)) {
    const r = s.route;
    if (r.screen === 'logo') set({ route: s.data.project.logos[0] ? { screen: 'logo', id: s.data.project.logos[0].id } : { screen: 'glyph', cp: 0x3042 } });
    else if (r.screen === 'composite')
      set({ route: s.data.project.composites[0] ? { screen: 'composite', id: s.data.project.composites[0].id } : { screen: 'glyph', cp: 0x3042 } });
    else if (r.screen === 'part') set({ route: { screen: 'glyph', cp: 0x3042 } });
  }
}

/** パーツ編集から戻る先 */
export let returnRoute: Route = { screen: 'glyph', cp: 0x3042 };

export function setRoute(route: Route) {
  const s = get();
  if (route.screen === 'part' && s.route.screen !== 'part') returnRoute = s.route;
  const ui = { ...s.ui, selection: [], charEdit: null, nodeSel: null };
  // 画面に合わないツールは選択ツールへ
  if ((route.screen === 'glyph' || route.screen === 'part') && ui.tool === 'text') ui.tool = 'select';
  if ((route.screen === 'composite') && (ui.tool === 'eraser' && ui.eraserMode === 'partial')) ui.eraserMode = 'object';
  set({ route, ui });
}

// ===== 保存 =====

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedProject: Project | null = null;
let savedParts: Part[] | null = null;
let saving: Promise<void> | null = null;

export function isDirty() {
  const d = get().data;
  return !!d && (d.project !== savedProject || d.parts !== savedParts);
}

export async function flushSave(): Promise<boolean> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (saving) await saving.catch(() => {});
  const d = get().data;
  if (!d) return true;
  if (!isDirty()) {
    if (get().save.state !== 'error') set({ save: { state: 'saved', at: get().save.at } });
    return true;
  }
  const project = d.project;
  const parts = d.parts;
  set({ save: { state: 'saving' } });
  saving = (async () => {
    if (project !== savedProject) await dbm.saveProject(project);
    if (parts !== savedParts) await dbm.saveParts(parts);
  })();
  try {
    await saving;
    savedProject = project;
    savedParts = parts;
    const metas = get().projects.filter((m) => m.id !== project.id);
    set({ projects: [dbm.metaOf(project), ...metas].sort((a, b) => b.updatedAt - a.updatedAt) });
    if (isDirty()) scheduleSave();
    else set({ save: { state: 'saved', at: Date.now() } });
    if (get().persisted === null) dbm.requestPersistence().then((p) => set({ persisted: p }));
    return true;
  } catch (e) {
    const msg = (e as Error)?.name === 'QuotaExceededError' ? '端末の保存容量が不足しています' : String((e as Error)?.message || e);
    set({ save: { state: 'error', message: msg } });
    return false;
  } finally {
    saving = null;
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  if (get().save.state !== 'error') set({ save: { state: 'pending' } });
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 700);
}

useStore.subscribe((s, prev) => {
  if (s.data !== prev.data && s.data && isDirty()) scheduleSave();
});

// ===== 起動・プロジェクト管理 =====

export async function boot() {
  try {
    let projects = await dbm.listProjects();
    const parts = await dbm.loadParts();
    let project: Project | null = null;
    const last = await dbm.getMeta<string>('lastProject');
    if (last) project = await dbm.loadProject(last).catch(() => null);
    if (!project && projects[0]) project = await dbm.loadProject(projects[0].id).catch(() => null);
    if (!project) {
      project = newProject('はじめてのプロジェクト');
      await dbm.saveProject(project);
      projects = await dbm.listProjects();
    }
    savedProject = project;
    savedParts = parts;
    set({ ready: true, projects, data: { project, parts }, past: [], future: [], route: { screen: 'glyph', cp: 0x3042 } });
    await dbm.setMeta('lastProject', project.id).catch(() => {});
    dbm.requestPersistence().then((p) => set({ persisted: p }));
  } catch (e) {
    set({ ready: true, bootError: String((e as Error)?.message || e) });
  }
}

export async function openProject(id: string) {
  if (!(await flushSave())) {
    toast('現在のプロジェクトを保存できないため、切り替えを中止しました', 'error');
    return;
  }
  const p = await dbm.loadProject(id);
  if (!p) {
    toast('プロジェクトを読み込めませんでした', 'error');
    return;
  }
  savedProject = p;
  const parts = get().data?.parts ?? [];
  set({ data: { project: p, parts }, past: [], future: [], route: { screen: 'glyph', cp: 0x3042 }, ui: { ...get().ui, selection: [], charEdit: null } });
  await dbm.setMeta('lastProject', p.id).catch(() => {});
}

export async function createProject(name: string) {
  const p = newProject(name || '新しいプロジェクト');
  await dbm.saveProject(p);
  set({ projects: await dbm.listProjects() });
  await openProject(p.id);
}

export async function duplicateProject(id: string) {
  if (!(await flushSave())) return;
  const p = await dbm.loadProject(id);
  if (!p) return;
  const copy: Project = { ...structuredClone(p), id: uid('prj'), name: `${p.name} のコピー`, createdAt: Date.now(), updatedAt: Date.now() };
  await dbm.saveProject(copy);
  set({ projects: await dbm.listProjects() });
  toast(`「${copy.name}」を作成しました`);
}

export async function renameProject(id: string, name: string) {
  const s = get();
  if (s.data?.project.id === id) {
    commit((d) => {
      d.project.name = name;
    });
    await flushSave();
  } else {
    const p = await dbm.loadProject(id);
    if (!p) return;
    p.name = name;
    p.updatedAt = Date.now();
    await dbm.saveProject(p);
  }
  set({ projects: await dbm.listProjects() });
}

export async function removeProject(id: string) {
  const s = get();
  await flushSave();
  await dbm.deleteProject(id);
  let projects = await dbm.listProjects();
  if (s.data?.project.id === id) {
    if (projects[0]) {
      savedProject = null;
      const p = await dbm.loadProject(projects[0].id);
      if (p) {
        savedProject = p;
        set({ data: { project: p, parts: s.data.parts }, past: [], future: [], route: { screen: 'glyph', cp: 0x3042 } });
        await dbm.setMeta('lastProject', p.id);
      }
    } else {
      const p = newProject('はじめてのプロジェクト');
      await dbm.saveProject(p);
      savedProject = p;
      set({ data: { project: p, parts: s.data.parts }, past: [], future: [], route: { screen: 'glyph', cp: 0x3042 } });
      projects = await dbm.listProjects();
    }
  }
  set({ projects });
}

/** 外部から読み込んだプロジェクト・パーツを保存（復元） */
export async function importData(projects: Project[], parts: Part[], assets: import('../model/types').Asset[]) {
  for (const a of assets) {
    const ex = await dbm.getAsset(a.id);
    if (!ex) await dbm.putAsset(a);
  }
  for (const p of projects) await dbm.saveProject(p);
  if (parts.length) {
    commit((d) => {
      d.parts.push(...(parts as Draft<Part>[]));
    });
    await flushSave();
  }
  set({ projects: await dbm.listProjects() });
}

export function currentEnvKey(data: Data) {
  return data.project;
}
