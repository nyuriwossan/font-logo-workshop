// ===== 共通データモデル =====
// 編集データ（ここ）・表示データ（render/）・出力データ（font/, render/export）を分離する。
// 編集データは常に「元の入力」を保持し、輪郭化などの派生結果は保存しない。

/** 2D アフィン変換 [a, b, c, d, e, f]（Canvas の setTransform と同じ並び） */
export type Mat = [number, number, number, number, number, number];

export interface Vec {
  x: number;
  y: number;
}

/** 色（CSS カラー文字列 #rrggbb / #rrggbbaa） */
export type Color = string;

export type Paint =
  | { kind: 'solid'; color: Color }
  | { kind: 'linear'; from: Color; to: Color; angle: number };

/** ロゴ・合成で使う装飾スタイル。フォント字形には使われない（単色輪郭のみ） */
export interface Style {
  fill: Paint;
  outline: { on: boolean; color: Color; width: number };
  shadow: { on: boolean; color: Color; blur: number; dx: number; dy: number };
  opacity: number;
}

export interface PenSettings {
  size: number;
  /** 筆圧による太さ変化の強さ 0..0.95 */
  thinning: number;
  /** 線の滑らかさ 0..1 */
  smoothing: number;
  /** 手ぶれ補正 0..1 */
  streamline: number;
  taperStart: number;
  taperEnd: number;
  /** 記録した筆圧を使うか（取得できない環境では false = 固定幅） */
  usePressure: boolean;
}

/** 手書きの元データ（[x, y, pressure]）を保持する */
export type StrokePoint = [number, number, number];

interface BaseObj {
  id: string;
  transform: Mat;
  style?: Style;
  name?: string;
  hidden?: boolean;
  locked?: boolean;
}

export interface StrokeObj extends BaseObj {
  type: 'stroke';
  points: StrokePoint[];
  pen: PenSettings;
  /** true: 部分消しゴム（それより下の線を削る） */
  erase?: boolean;
}

export interface PathNode {
  x: number;
  y: number;
  /** 入りハンドル（絶対座標・ローカル） */
  hin?: Vec;
  /** 出ハンドル（絶対座標・ローカル） */
  hout?: Vec;
}

export type ShapeKind = 'line' | 'curve' | 'rect' | 'ellipse' | 'polygon';

export interface PathObj extends BaseObj {
  type: 'path';
  nodes: PathNode[];
  closed: boolean;
  fill: boolean;
  /** 0 で線なし */
  strokeWidth: number;
  shape?: ShapeKind;
}

export interface GroupObj extends BaseObj {
  type: 'group';
  children: Obj[];
}

export interface CharAdjust {
  dx: number;
  dy: number;
  rot: number;
  scale: number;
}

export interface TextObj extends BaseObj {
  type: 'text';
  text: string;
  fontSize: number;
  /** 文字間（px） */
  letterSpacing: number;
  /** 行間（倍率） */
  lineHeight: number;
  vertical: boolean;
  /** 文字インデックス（改行を含む text 上の位置）ごとの調整 */
  charAdj: Record<string, CharAdjust>;
}

export interface LogoRefObj extends BaseObj {
  type: 'logoRef';
  logoId: string;
}

export type Obj = StrokeObj | PathObj | GroupObj | TextObj | LogoRefObj;

export interface GlyphMetrics {
  /** 字形の拡大率（em 中心基準） */
  scale: number;
  offsetX: number;
  offsetY: number;
  /** 文字送り幅（autoAdvance=false のとき使用） */
  advance: number;
  /** true: 字形の幅＋左右余白から送り幅を自動計算（欧文向け） */
  autoAdvance: boolean;
  /** 自動計算時の左右余白 */
  sideBearing: number;
}

export interface Glyph {
  cp: number;
  objects: Obj[];
  metrics: GlyphMetrics;
  updatedAt: number;
}

export interface FontInfo {
  /** 表示用フォント名（日本語可） */
  displayName: string;
  /** 英字フォント名（必須・ASCII） */
  familyName: string;
  styleName: string;
  designer: string;
}

export interface Logo {
  id: string;
  name: string;
  width: number;
  height: number;
  objects: Obj[];
  updatedAt: number;
}

export interface Composite {
  id: string;
  name: string;
  /** 背景画像アセット（なしも可） */
  assetId: string | null;
  width: number;
  height: number;
  objects: Obj[];
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  schema: 1;
  createdAt: number;
  updatedAt: number;
  font: FontInfo;
  /** key は 10 進のコードポイント文字列 */
  glyphs: Record<string, Glyph>;
  /** 文字セットに追加した漢字など */
  customChars: string[];
  logos: Logo[];
  composites: Composite[];
}

export interface Part {
  id: string;
  name: string;
  category: string;
  /** 原点中心に正規化した編集可能ベクターデータ */
  objects: Obj[];
  /** 登録元の位置（同じ種類の画面へ挿入するときは元の位置に置く） */
  origin?: { x: number; y: number; kind: 'glyph' | 'logo' | 'composite' | 'part' };
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  glyphCount: number;
}

export interface Asset {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  blob: Blob;
}

export type Frame = { x: number; y: number; w: number; h: number };

export type Route =
  | { screen: 'glyph'; cp: number }
  | { screen: 'logo'; id: string }
  | { screen: 'composite'; id: string }
  | { screen: 'part'; id: string };

export type Tool =
  | 'select'
  | 'pen'
  | 'eraser'
  | 'line'
  | 'curve'
  | 'ellipse'
  | 'rect'
  | 'polygon'
  | 'node'
  | 'text'
  | 'hand';
