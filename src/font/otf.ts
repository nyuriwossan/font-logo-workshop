import * as opentype from 'opentype.js';
import type { Project } from '../model/types';
import { glyphOutline } from '../geom/outline';
import { simplifyRing, type Ring } from '../geom/clip';
import { BASELINE, ASCENDER, DESCENDER, EM } from '../model/defaults';
import { unicodeLabel } from '../model/charsets';

export interface FontIssue {
  cp: number;
  level: 'error' | 'warn';
  message: string;
}

export interface FontPlanGlyph {
  cp: number;
  advance: number;
  contours: number[][][]; // [contour][point][x,y]（フォント座標・Y 上向き・整数）
}

export interface FontPlan {
  glyphs: FontPlanGlyph[];
  issues: FontIssue[];
  /** 作成途中（オブジェクトはあるが輪郭が空）などで除外した文字 */
  excluded: number[];
}

export const ASCII_NAME = /^[A-Za-z][A-Za-z0-9 \-]{0,62}$/;

export function sanitizePostScript(name: string): string {
  return name.replace(/[^A-Za-z0-9\-]/g, '').slice(0, 60) || 'Font';
}

function signedArea(c: number[][]): number {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[(i + 1) % c.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function toFontContour(r: Ring, wantPositive: boolean): number[][] | null {
  const simp = simplifyRing(r, 0.35);
  const pts: number[][] = [];
  for (const p of simp) {
    const x = Math.round(p.x);
    const y = Math.round(BASELINE - p.y);
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    pts.push([x, y]);
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;
  const a = signedArea(pts);
  if (Math.abs(a) < 0.5) return null;
  // CFF：外側は反時計回り（面積が正）、穴は時計回り
  if (a > 0 !== wantPositive) pts.reverse();
  return pts;
}

/** 出力前の検査と輪郭データ化 */
export function planFont(project: Project): FontPlan {
  const issues: FontIssue[] = [];
  const glyphs: FontPlanGlyph[] = [];
  const excluded: number[] = [];
  const cps = Object.keys(project.glyphs)
    .map(Number)
    .filter((cp) => Number.isInteger(cp))
    .sort((a, b) => a - b);
  for (const cp of cps) {
    const g = project.glyphs[String(cp)];
    if (!g || g.objects.length === 0) continue;
    if (cp <= 0x20 || cp === 0x3000 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) {
      issues.push({ cp, level: 'error', message: `${unicodeLabel(cp)} はフォントに登録できない文字です` });
      excluded.push(cp);
      continue;
    }
    const ol = glyphOutline(g);
    if (ol.empty) {
      issues.push({ cp, level: 'warn', message: `「${String.fromCodePoint(cp)}」は輪郭が空のため収録しません（消しゴムで全部消えている等）` });
      excluded.push(cp);
      continue;
    }
    const contours: number[][][] = [];
    let bad = false;
    for (const s of ol.shapes) {
      const outer = toFontContour(s.outer, true);
      if (outer) contours.push(outer);
      for (const h of s.holes) {
        const hole = toFontContour(h, false);
        if (hole) contours.push(hole);
      }
    }
    for (const c of contours) for (const [x, y] of c) if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 16000 || Math.abs(y) > 16000) bad = true;
    if (bad || contours.length === 0) {
      issues.push({ cp, level: 'error', message: `「${String.fromCodePoint(cp)}」の輪郭が不正なため収録しません` });
      excluded.push(cp);
      continue;
    }
    const b = ol.bbox!;
    if (b.minY < -EM * 0.6 || b.maxY > EM * 1.6 || b.minX < -EM * 0.6 || b.maxX > ol.advance + EM * 0.6) {
      issues.push({ cp, level: 'warn', message: `「${String.fromCodePoint(cp)}」が文字枠から大きくはみ出しています（表示が切れる場合があります）` });
    }
    const points = contours.reduce((s, c) => s + c.length, 0);
    if (points > 20000) issues.push({ cp, level: 'warn', message: `「${String.fromCodePoint(cp)}」の点数が多く（${points}点）、ファイルが大きくなります` });
    glyphs.push({ cp, advance: ol.advance, contours });
  }
  return { glyphs, issues, excluded };
}

export interface FontNames {
  displayName: string;
  familyName: string;
  styleName: string;
  designer?: string;
}

function glyphName(cp: number) {
  return cp <= 0xffff ? 'uni' + cp.toString(16).toUpperCase().padStart(4, '0') : 'u' + cp.toString(16).toUpperCase();
}

/** OTF（CFF アウトライン）を生成 */
export function buildOtf(plan: FontPlan, names: FontNames): ArrayBuffer {
  if (!ASCII_NAME.test(names.familyName)) throw new Error('英字フォント名は半角英数字（先頭は英字）で入力してください');
  const style = ASCII_NAME.test(names.styleName) ? names.styleName : 'Regular';
  const list: opentype.Glyph[] = [];
  // .notdef（字形のない文字を「別の字」として見せないための四角）
  const nd = new opentype.Path();
  nd.moveTo(100, -100);
  nd.lineTo(500, -100);
  nd.lineTo(500, 800);
  nd.lineTo(100, 800);
  nd.close();
  nd.moveTo(160, -40);
  nd.lineTo(160, 740);
  nd.lineTo(440, 740);
  nd.lineTo(440, -40);
  nd.close();
  list.push(new opentype.Glyph({ name: '.notdef', unicode: undefined, advanceWidth: 600, path: nd }));
  const have = new Set(plan.glyphs.map((g) => g.cp));
  if (!have.has(0x20)) list.push(new opentype.Glyph({ name: 'space', unicode: 0x20, advanceWidth: 300, path: new opentype.Path() }));
  if (!have.has(0x3000)) list.push(new opentype.Glyph({ name: 'uni3000', unicode: 0x3000, advanceWidth: 1000, path: new opentype.Path() }));
  for (const g of plan.glyphs) {
    const p = new opentype.Path();
    for (const c of g.contours) {
      p.moveTo(c[0][0], c[0][1]);
      for (let i = 1; i < c.length; i++) p.lineTo(c[i][0], c[i][1]);
      p.close();
    }
    list.push(new opentype.Glyph({ name: glyphName(g.cp), unicode: g.cp, advanceWidth: Math.max(0, Math.round(g.advance)), path: p }));
  }
  const ps = sanitizePostScript(names.familyName) + '-' + sanitizePostScript(style);
  const font = new opentype.Font({
    familyName: names.familyName,
    styleName: style,
    postScriptName: ps,
    designer: names.designer?.trim() || ' ',
    unitsPerEm: EM,
    ascender: ASCENDER,
    descender: DESCENDER,
    version: 'Version 1.000',
    glyphs: list,
  });
  // 日本語の表示名（Windows 名前テーブル・日本語）
  const disp = names.displayName.trim();
  if (disp && disp !== names.familyName) {
    const win = (font as any).names.windows;
    win.fontFamily.ja = disp;
    win.fullName.ja = `${disp} ${style}`;
  }
  return font.toArrayBuffer();
}

export interface VerifyResult {
  ok: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
}

/** 生成したフォントを読み直して検証 */
export function verifyOtf(buffer: ArrayBuffer, plan: FontPlan, names: FontNames): VerifyResult {
  const checks: VerifyResult['checks'] = [];
  let font: opentype.Font;
  try {
    font = opentype.parse(buffer);
    checks.push({ label: 'フォントファイルを読み込み直せる', ok: true });
  } catch (e) {
    checks.push({ label: 'フォントファイルを読み込み直せる', ok: false, detail: String(e) });
    return { ok: false, checks };
  }
  checks.push({ label: 'OTF（CFF アウトライン）形式', ok: font.outlinesFormat === 'cff', detail: font.outlinesFormat });
  const fam = font.names.windows?.fontFamily?.en ?? (font.names as any).fontFamily?.en;
  checks.push({ label: 'フォント名', ok: fam === names.familyName, detail: String(fam) });
  let mismatch: string[] = [];
  for (const g of plan.glyphs) {
    const ch = String.fromCodePoint(g.cp);
    const gl = font.charToGlyph(ch);
    const contours = gl.path.commands.filter((c: any) => c.type === 'Z').length;
    const okMap = gl.index !== 0 && (gl.unicode === g.cp || (gl.unicodes ?? []).includes(g.cp));
    const okShape = contours === g.contours.length;
    const okAdv = Math.round(gl.advanceWidth ?? -1) === Math.round(g.advance);
    if (!okMap || !okShape || !okAdv) mismatch.push(`${ch}（${!okMap ? '割当' : !okShape ? '輪郭数' : '送り幅'}）`);
  }
  checks.push({
    label: `${plan.glyphs.length} 文字が正しい Unicode・輪郭で収録されている`,
    ok: mismatch.length === 0,
    detail: mismatch.length ? mismatch.slice(0, 10).join('、') : undefined,
  });
  // 収録していない文字が別字形にならないこと
  const probe = findMissingProbe(plan);
  const pg = font.charToGlyph(String.fromCodePoint(probe));
  checks.push({
    label: `未収録の文字（${String.fromCodePoint(probe)}）は字形なし（.notdef）になる`,
    ok: pg.index === 0,
  });
  return { ok: checks.every((c) => c.ok), checks };
}

function findMissingProbe(plan: FontPlan): number {
  const have = new Set(plan.glyphs.map((g) => g.cp));
  for (const cp of [0x5b57, 0x3042, 0x41, 0x7a, 0x30a2, 0x2603]) if (!have.has(cp)) return cp;
  let cp = 0x4e00;
  while (have.has(cp)) cp++;
  return cp;
}

export function fontFileName(names: FontNames): string {
  return `${sanitizePostScript(names.familyName)}-${sanitizePostScript(names.styleName || 'Regular')}.otf`;
}
