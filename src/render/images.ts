import { getAsset } from '../store/db';

// 背景画像の読み込みキャッシュ（端末内の IndexedDB からのみ読み込む）
const cache = new Map<string, CanvasImageSource>();
const loading = new Map<string, Promise<CanvasImageSource | null>>();
const listeners = new Set<() => void>();

export function onImageLoaded(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getImage(id: string | null | undefined): CanvasImageSource | null {
  if (!id) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  void loadImage(id);
  return null;
}

export function loadImage(id: string): Promise<CanvasImageSource | null> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(id);
  if (!p) {
    p = (async () => {
      const a = await getAsset(id);
      if (!a) return null;
      const img = await decodeBlob(a.blob);
      cache.set(id, img);
      listeners.forEach((f) => f());
      return img;
    })().catch(() => null);
    loading.set(id, p);
  }
  return p;
}

export async function decodeBlob(blob: Blob): Promise<CanvasImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* 一部形式は img 要素で読む */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export function imageSize(img: CanvasImageSource): { w: number; h: number } {
  const anyImg = img as any;
  return { w: anyImg.naturalWidth || anyImg.width || 0, h: anyImg.naturalHeight || anyImg.height || 0 };
}
