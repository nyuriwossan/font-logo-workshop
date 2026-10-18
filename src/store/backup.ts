import type { Asset, Part, Project } from '../model/types';
import { normalizePart, normalizeProject } from '../model/normalize';
import { uid } from '../model/ids';

export const BACKUP_APP = 'font-logo-workshop';
export const BACKUP_FORMAT = 1;

export interface BackupAsset {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  dataUrl: string;
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  format: number;
  exportedAt: string;
  projects: Project[];
  parts: Part[];
  assets: BackupAsset[];
}

export async function blobToDataUrl(b: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(b);
    });
  }
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return `data:${b.type || 'application/octet-stream'};base64,${btoa(s)}`;
}

export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('画像データの形式が正しくありません');
  const type = m[1] || 'application/octet-stream';
  if (m[2]) {
    const bin = atob(m[3]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type });
  }
  return new Blob([decodeURIComponent(m[3])], { type });
}

export async function makeBackup(projects: Project[], parts: Part[], getAsset: (id: string) => Promise<Asset | null>): Promise<BackupFile> {
  const ids = new Set<string>();
  for (const p of projects) for (const c of p.composites) if (c.assetId) ids.add(c.assetId);
  const assets: BackupAsset[] = [];
  for (const id of ids) {
    const a = await getAsset(id);
    if (!a) continue;
    assets.push({ id: a.id, name: a.name, type: a.type, width: a.width, height: a.height, dataUrl: await blobToDataUrl(a.blob) });
  }
  return { app: BACKUP_APP, format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), projects, parts, assets };
}

export interface ParsedBackup {
  projects: Project[];
  parts: Part[];
  assets: Asset[];
  warnings: string[];
}

/** バックアップ JSON を検証して読み込む（壊れた項目は除外して警告） */
export function parseBackup(text: string): ParsedBackup {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSON として読み込めませんでした。ファイルが壊れている可能性があります。');
  }
  if (!raw || raw.app !== BACKUP_APP) throw new Error('このアプリのバックアップファイルではありません。');
  if (typeof raw.format !== 'number' || raw.format > BACKUP_FORMAT) throw new Error('新しい形式のバックアップです。アプリを更新してから読み込んでください。');
  const warnings: string[] = [];
  const projects: Project[] = [];
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    try {
      projects.push(normalizeProject(p));
    } catch (e) {
      warnings.push(`プロジェクトを 1 件読み込めませんでした（${(e as Error).message}）`);
    }
  }
  const parts = (Array.isArray(raw.parts) ? raw.parts : []).map(normalizePart).filter(Boolean) as Part[];
  const assets: Asset[] = [];
  for (const a of Array.isArray(raw.assets) ? raw.assets : []) {
    try {
      if (typeof a?.id !== 'string' || typeof a?.dataUrl !== 'string') throw new Error('不明な形式');
      const blob = dataUrlToBlob(a.dataUrl);
      assets.push({ id: a.id, name: String(a.name ?? '画像'), type: blob.type, width: Number(a.width) || 0, height: Number(a.height) || 0, blob });
    } catch {
      warnings.push('画像を 1 件読み込めませんでした');
    }
  }
  return { projects, parts, assets, warnings };
}

/** 既存データと ID が衝突する場合は複製として取り込む */
export function resolveConflicts(parsed: ParsedBackup, existingProjectIds: Set<string>, existingParts: Part[]) {
  const projects = parsed.projects.map((p) => (existingProjectIds.has(p.id) ? { ...p, id: uid('prj'), name: `${p.name}（復元）` } : p));
  const byId = new Map(existingParts.map((p) => [p.id, p]));
  const newParts: Part[] = [];
  for (const p of parsed.parts) {
    const ex = byId.get(p.id);
    if (!ex) newParts.push(p);
    else {
      // 正規化してから比べる（キーの順序の違いで別物扱いしない）
      const a = JSON.stringify(normalizePart(ex)?.objects ?? null);
      const b = JSON.stringify(p.objects);
      if (a !== b || ex.name !== p.name) newParts.push({ ...p, id: uid('part') });
    }
  }
  return { projects, newParts };
}
