// opentype.js v2 は型定義を同梱していないため、このアプリで使う範囲だけ宣言する
declare module 'opentype.js' {
  export class Path {
    commands: { type: string; x?: number; y?: number }[];
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
    close(): void;
  }
  export class Glyph {
    constructor(opts: { name: string; unicode?: number; unicodes?: number[]; advanceWidth: number; path: Path });
    index: number;
    name: string;
    unicode?: number;
    unicodes?: number[];
    advanceWidth?: number;
    path: Path;
  }
  export class Font {
    constructor(opts: Record<string, unknown>);
    names: {
      windows?: Record<string, Record<string, string>>;
      macintosh?: Record<string, Record<string, string>>;
      unicode?: Record<string, Record<string, string>>;
    };
    outlinesFormat: string;
    unitsPerEm: number;
    glyphs: { length: number; get(i: number): Glyph };
    charToGlyph(ch: string): Glyph;
    toArrayBuffer(): ArrayBuffer;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
