import type { GlyphMetrics, Logo, Composite, PenSettings, Project, Style, Mat, Glyph } from './types';
import { uid } from './ids';
import { isFullWidthChar } from './charsets';

export const EM = 1000;
/** em ボックス上端からベースラインまで（Y 下向きの編集座標） */
export const BASELINE = 880;
export const ASCENDER = 880;
export const DESCENDER = -120;
export const X_HEIGHT = 500;
export const CAP_HEIGHT = 700;

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const INK = '#1d2230';

export function defaultPen(): PenSettings {
  return {
    size: 40,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    taperStart: 0,
    taperEnd: 0,
    usePressure: true,
  };
}

export function defaultStyle(color = '#2b3550'): Style {
  return {
    fill: { kind: 'solid', color },
    outline: { on: false, color: '#ffffff', width: 6 },
    shadow: { on: false, color: '#00000066', blur: 12, dx: 4, dy: 6 },
    opacity: 1,
  };
}

export function defaultMetrics(cp: number): GlyphMetrics {
  const full = isFullWidthChar(String.fromCodePoint(cp));
  return {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    advance: full ? 1000 : 600,
    autoAdvance: !full,
    sideBearing: 60,
  };
}

export function newGlyph(cp: number): Glyph {
  return { cp, objects: [], metrics: defaultMetrics(cp), updatedAt: Date.now() };
}

export function newProject(name = '新しいプロジェクト'): Project {
  const now = Date.now();
  return {
    id: uid('prj'),
    name,
    schema: 1,
    createdAt: now,
    updatedAt: now,
    font: { displayName: 'マイ手書きフォント', familyName: 'MyHandFont', styleName: 'Regular', designer: '' },
    glyphs: {},
    customChars: [],
    logos: [newLogo('タイトルロゴ 1')],
    composites: [],
  };
}

export function newLogo(name: string): Logo {
  return { id: uid('logo'), name, width: 1600, height: 900, objects: [], updatedAt: Date.now() };
}

export function newComposite(name: string, w = 1600, h = 1200, assetId: string | null = null): Composite {
  return { id: uid('cmp'), name, assetId, width: w, height: h, objects: [], updatedAt: Date.now() };
}
