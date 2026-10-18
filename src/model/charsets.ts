export interface CharSet {
  id: string;
  label: string;
  chars: string[];
}

const split = (s: string) => Array.from(s);

const HIRAGANA = split(
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん' +
    'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ' +
    'ぁぃぅぇぉっゃゅょゎゔ',
);
const KATAKANA = split(
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
    'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ' +
    'ァィゥェォッャュョヮヴヵヶ',
);
const UPPER = split('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
const LOWER = split('abcdefghijklmnopqrstuvwxyz');
const DIGITS = split('0123456789');
const SYMBOLS = split('!?.,:;\'"-_+=*/\\()[]{}<>@#$%&^~`|' + '、。・ー〜…！？「」『』（）【】♪☆★♡♥※');

export const BUILTIN_SETS: CharSet[] = [
  { id: 'hira', label: 'ひらがな', chars: HIRAGANA },
  { id: 'kata', label: 'カタカナ', chars: KATAKANA },
  { id: 'upper', label: '英大文字', chars: UPPER },
  { id: 'lower', label: '英小文字', chars: LOWER },
  { id: 'digit', label: '数字', chars: DIGITS },
  { id: 'symbol', label: '記号', chars: SYMBOLS },
];

export const KANJI_SET_ID = 'kanji';

export function cpOf(ch: string): number {
  return ch.codePointAt(0) ?? 0;
}

export function charOf(cp: number): string {
  return String.fromCodePoint(cp);
}

/** 全角扱い（送り幅 1000 固定）にする文字 */
export function isFullWidthChar(ch: string): boolean {
  const cp = cpOf(ch);
  if (cp < 0x2000) return false;
  if (cp >= 0xff61 && cp <= 0xff9f) return false; // 半角カナ
  return true;
}

export function setOfChar(ch: string): string {
  for (const s of BUILTIN_SETS) if (s.chars.includes(ch)) return s.id;
  return KANJI_SET_ID;
}

/** 入力文字列から追加可能な単一文字だけを取り出す（サロゲートペア対応） */
export function extractChars(input: string): string[] {
  const out: string[] = [];
  for (const ch of Array.from(input)) {
    const cp = cpOf(ch);
    if (cp <= 0x20 || (cp >= 0x7f && cp < 0xa0) || ch === '　') continue;
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (!out.includes(ch)) out.push(ch);
  }
  return out;
}

export function unicodeLabel(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}
