import { openDB, type IDBPDatabase } from 'idb';
import type { Asset, Part, Project, ProjectMeta } from '../model/types';
import { normalizePart, normalizeProject } from '../model/normalize';

const DB_NAME = 'font-logo-workshop';
const DB_VERSION = 1;

let dbp: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('projectMeta')) d.createObjectStore('projectMeta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('parts')) d.createObjectStore('parts');
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      },
      blocked() {
        console.warn('IndexedDB blocked');
      },
    });
    dbp.catch(() => {
      dbp = null;
    });
  }
  return dbp;
}

export function metaOf(p: Project): ProjectMeta {
  return {
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    glyphCount: Object.values(p.glyphs).filter((g) => g.objects.length > 0).length,
  };
}

/** 保存（トランザクション完了まで待つ。失敗時は例外） */
export async function saveProject(p: Project): Promise<void> {
  const d = await db();
  const tx = d.transaction(['projects', 'projectMeta'], 'readwrite');
  await Promise.all([tx.objectStore('projects').put(p), tx.objectStore('projectMeta').put(metaOf(p)), tx.done]);
}

export async function loadProject(id: string): Promise<Project | null> {
  const d = await db();
  const raw = await d.get('projects', id);
  return raw ? normalizeProject(raw) : null;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const d = await db();
  const all = (await d.getAll('projectMeta')) as ProjectMeta[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['projects', 'projectMeta'], 'readwrite');
  await Promise.all([tx.objectStore('projects').delete(id), tx.objectStore('projectMeta').delete(id), tx.done]);
  await gcAssets();
}

export async function saveParts(parts: Part[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('parts', 'readwrite');
  await Promise.all([tx.store.put(parts, 'library'), tx.done]);
}

export async function loadParts(): Promise<Part[]> {
  const d = await db();
  const raw = await d.get('parts', 'library');
  return Array.isArray(raw) ? (raw.map(normalizePart).filter(Boolean) as Part[]) : [];
}

export async function putAsset(a: Asset): Promise<void> {
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  await Promise.all([tx.store.put(a), tx.done]);
}

export async function getAsset(id: string): Promise<Asset | null> {
  const d = await db();
  return ((await d.get('assets', id)) as Asset | undefined) ?? null;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return (await d.get('meta', key)) as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const d = await db();
  const tx = d.transaction('meta', 'readwrite');
  await Promise.all([tx.store.put(value, key), tx.done]);
}

/** どのプロジェクトからも参照されていない画像を削除 */
export async function gcAssets(): Promise<void> {
  const d = await db();
  const used = new Set<string>();
  const projects = (await d.getAll('projects')) as Project[];
  for (const p of projects) for (const c of p.composites ?? []) if (c.assetId) used.add(c.assetId);
  const keys = (await d.getAllKeys('assets')) as string[];
  const tx = d.transaction('assets', 'readwrite');
  await Promise.all([...keys.filter((k) => !used.has(k)).map((k) => tx.store.delete(k)), tx.done]);
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* 非対応 */
  }
  return null;
}
