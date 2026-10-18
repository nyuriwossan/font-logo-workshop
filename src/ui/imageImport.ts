import type { Asset } from '../model/types';
import { uid } from '../model/ids';
import { putAsset } from '../store/db';
import { decodeBlob, imageSize } from '../render/images';
import { toast } from '../store/store';

/** ファイル選択（ユーザー操作の中で呼ぶこと） */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-1000px';
    let done = false;
    input.onchange = () => {
      done = true;
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    // キャンセル検知（対応ブラウザのみ）
    input.addEventListener('cancel', () => {
      if (!done) resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** 端末内の画像を読み込み、IndexedDB に保存（外部へは送信しない） */
export async function importImageAsset(): Promise<Asset | null> {
  const f = await pickFile('image/*');
  if (!f) return null;
  try {
    const img = await decodeBlob(f);
    const { w, h } = imageSize(img);
    if (!w || !h) throw new Error('size');
    // File は元ファイルへの参照のことがあるため、中身をコピーした Blob で保存する
    const blob = new Blob([await f.arrayBuffer()], { type: f.type || 'image/png' });
    const a: Asset = { id: uid('img'), name: f.name || '画像', type: blob.type, width: w, height: h, blob };
    await putAsset(a);
    if (w * h > 16_777_216) toast(`大きな画像です（${w}×${h}）。iPad では書き出しサイズが自動で縮小される場合があります`);
    return a;
  } catch {
    toast('この画像は読み込めませんでした（JPEG・PNG・WebP などを使ってください）', 'error');
    return null;
  }
}
