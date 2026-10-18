import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { useStore, boot, setRoute, setUi, commit, flushSave, docOf, undo, redo, importData } from '../src/store/store';
import { registerPart, insertPart, flipH } from '../src/editor/actions';
import { stroke } from './helpers';
import { makeBackup, parseBackup, resolveConflicts } from '../src/store/backup';
import * as dbm from '../src/store/db';
import { normalizeProject } from '../src/model/normalize';
import type { StrokeObj, Part } from '../src/model/types';

const cpA = 0x3042;
const cpB = 0x3044;

function glyphObjs(cp: number) {
  return useStore.getState().data!.project.glyphs[String(cp)]?.objects ?? [];
}

describe('パーツ再利用', () => {
  beforeAll(async () => {
    await boot();
    expect(useStore.getState().data).toBeTruthy();
  });

  it('線をパーツ棚へ登録し、別の文字へ貼り付けて変形できる', () => {
    setRoute({ screen: 'glyph', cp: cpA });
    const s1 = stroke([[100, 100], [300, 120]]);
    const s2 = stroke([[120, 200], [320, 180]]);
    commit((d) => {
      d.project.glyphs[String(cpA)] = { cp: cpA, objects: [s1, s2], metrics: { scale: 1, offsetX: 0, offsetY: 0, advance: 1000, autoAdvance: false, sideBearing: 60 }, updatedAt: 0 };
    });
    setUi({ selection: [s1.id, s2.id] });
    const part = registerPart('二本線', '線');
    expect(part).toBeTruthy();
    expect(useStore.getState().data!.parts.length).toBe(1);
    expect(part!.objects.length).toBe(2);
    // ベクターのまま（画像ではない）
    expect(part!.objects[0].type).toBe('stroke');

    setRoute({ screen: 'glyph', cp: cpB });
    insertPart(useStore.getState().data!.parts[0]);
    const inserted = glyphObjs(cpB);
    expect(inserted.length).toBe(2);
    // 同じ種類の画面なので、登録時と同じ位置に入る
    expect((inserted[0] as StrokeObj).points[0][0] + inserted[0].transform[4]).toBeCloseTo(100, 0);
    // ID は新しく振られる（元の線とは別物）
    expect(inserted[0].id).not.toBe(s1.id);

    // 貼り付け後に変形できる
    const before = inserted[0].transform;
    flipH();
    expect(glyphObjs(cpB)[0].transform).not.toEqual(before);
  });

  it('元パーツを編集しても、貼り付け済みの文字は変化しない', () => {
    const snapshot = JSON.stringify(glyphObjs(cpB));
    const partId = useStore.getState().data!.parts[0].id;
    setRoute({ screen: 'part', id: partId });
    commit((d) => {
      const p = d.parts.find((x) => x.id === partId)!;
      (p.objects[0] as StrokeObj).points.push([999, 999, 0.5]);
      p.objects[0].transform = [3, 0, 0, 3, 50, 50];
    });
    expect(JSON.stringify(glyphObjs(cpB))).toBe(snapshot);
    const edited = useStore.getState().data!.parts[0];
    expect((edited.objects[0] as StrokeObj).points.at(-1)).toEqual([999, 999, 0.5]);
  });

  it('取り消し・やり直しができる', () => {
    setRoute({ screen: 'glyph', cp: cpB });
    const n = glyphObjs(cpB).length;
    commit((d) => {
      d.project.glyphs[String(cpB)].objects.push(stroke([[0, 0], [10, 10]]));
    });
    expect(glyphObjs(cpB).length).toBe(n + 1);
    undo();
    expect(glyphObjs(cpB).length).toBe(n);
    redo();
    expect(glyphObjs(cpB).length).toBe(n + 1);
  });

  it('保存して読み込み直すと編集を再開できる（パーツ棚も復元）', async () => {
    expect(await flushSave()).toBe(true);
    expect(useStore.getState().save.state).toBe('saved');
    const id = useStore.getState().data!.project.id;
    const p = await dbm.loadProject(id);
    expect(p!.glyphs[String(cpB)].objects.length).toBe(glyphObjs(cpB).length);
    const parts = await dbm.loadParts();
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('二本線');
    // 読み込んだデータも編集可能な元データ（点列）を保持している
    expect((p!.glyphs[String(cpA)].objects[0] as StrokeObj).points.length).toBeGreaterThan(5);
  });

  it('JSON バックアップから復元できる（パーツ棚・画像も）', async () => {
    const st = useStore.getState();
    const img = { id: 'img_test', name: 'bg.png', type: 'image/png', width: 2, height: 2, blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) };
    await dbm.putAsset(img);
    commit((d) => {
      d.project.composites.push({ id: 'cmp_t', name: '合成', assetId: 'img_test', width: 2, height: 2, objects: [], updatedAt: 0 });
    });
    await flushSave();
    const project = (await dbm.loadProject(st.data!.project.id))!;
    const backup = await makeBackup([project], useStore.getState().data!.parts, dbm.getAsset);
    const text = JSON.stringify(backup);
    const parsed = parseBackup(text);
    expect(parsed.projects.length).toBe(1);
    expect(parsed.parts.length).toBe(1);
    expect(parsed.assets.length).toBe(1);
    expect(parsed.assets[0].blob.size).toBe(4);
    // 同じ ID があるので複製として取り込む
    const { projects, newParts } = resolveConflicts(parsed, new Set(useStore.getState().projects.map((p) => p.id)), useStore.getState().data!.parts);
    expect(projects[0].id).not.toBe(project.id);
    expect(projects[0].name).toContain('復元');
    expect(newParts.length).toBe(0); // 同一内容のパーツは重複させない
    await importData(projects, newParts, parsed.assets);
    const list = await dbm.listProjects();
    expect(list.some((p) => p.id === projects[0].id)).toBe(true);
    const restored = (await dbm.loadProject(projects[0].id))!;
    expect(JSON.stringify(restored.glyphs)).toBe(JSON.stringify(project.glyphs));
    expect(docOf({ project: restored, parts: [] }, { screen: 'glyph', cp: cpA })!.objects.length).toBe(2);
  });

  it('壊れたデータは読める部分だけ残す', () => {
    const p = normalizeProject({
      id: 'x',
      name: 'こわれ',
      glyphs: { '12354': { objects: [{ type: 'stroke', points: [[1, 2]], transform: 'bad' }, { type: 'unknown' }, null] }, abc: {} },
      logos: [{ objects: [{ type: 'text', text: 'あ' }] }],
    });
    expect(p.glyphs['12354'].objects.length).toBe(1);
    expect(p.glyphs['12354'].objects[0].transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(p.logos[0].objects[0].type).toBe('text');
    expect(() => parseBackup('{"app":"other"}')).toThrow();
    expect(() => parseBackup('not json')).toThrow();
  });

  it('パーツ登録時に位置情報（origin）を保存する', () => {
    const part = useStore.getState().data!.parts[0] as Part;
    expect(part.origin?.kind).toBe('glyph');
  });
});
