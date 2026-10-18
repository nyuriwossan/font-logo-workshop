import { describe, it, expect } from 'vitest';
import * as opentype from 'opentype.js';
import { planFont, buildOtf, verifyOtf } from '../src/font/otf';
import { glyphOutline, composeInk } from '../src/geom/outline';
import { projectAB, stroke, shape } from './helpers';
import { newGlyph } from '../src/model/defaults';

const names = { displayName: 'テスト手書き', familyName: 'TestHand', styleName: 'Regular' };

function signedArea(cmds: any[]) {
  // 最初の輪郭の符号付き面積
  const pts: [number, number][] = [];
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') pts.push([c.x, c.y]);
    if (c.type === 'Z') break;
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

describe('字形の輪郭化', () => {
  it('手書き線を閉じた輪郭に変換し、重なりを 1 つに合体する', () => {
    const p = projectAB();
    const ol = glyphOutline(p.glyphs['65']);
    expect(ol.empty).toBe(false);
    // 3 本の線は交差しているので 1 つの外形にまとまる（中に三角の穴が 1 つ）
    expect(ol.shapes.length).toBe(1);
    expect(ol.shapes[0].holes.length).toBe(1);
  });

  it('部分消しゴムは下にある線だけを削る', () => {
    const g = newGlyph(0x3042);
    g.objects = [shape('rect', [100, 100], [900, 900]), stroke([[500, 0], [500, 1000]], 80, { erase: true })];
    const ink = composeInk(g.objects);
    // 縦に切ったので 2 つに分かれる
    expect(ink.length).toBe(2);
    // 消しゴムの後に描いた線は消えない
    g.objects = [...g.objects, stroke([[100, 500], [900, 500]], 60)];
    expect(composeInk(g.objects).length).toBe(1);
  });

  it('自己交差する手書き線（ループ）も穴にならない', () => {
    const g = newGlyph(0x306e);
    g.objects = [
      stroke(
        [
          [500, 200],
          [800, 500],
          [500, 800],
          [200, 500],
          [500, 200],
          [700, 300],
        ],
        120,
      ),
    ];
    const ol = glyphOutline(g);
    expect(ol.empty).toBe(false);
    expect(ol.shapes.length).toBe(1);
  });
});

describe('OTF 書き出し', () => {
  it('A・B を Unicode に割り当てて書き出し、読み込み直して検証できる', () => {
    const p = projectAB();
    const plan = planFont(p);
    expect(plan.glyphs.map((g) => g.cp)).toEqual([65, 66]);
    const buf = buildOtf(plan, names);
    expect(buf.byteLength).toBeGreaterThan(500);
    const v = verifyOtf(buf, plan, names);
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.ok).toBe(true);

    const f = opentype.parse(buf);
    expect(f.outlinesFormat).toBe('cff');
    const a = f.charToGlyph('A');
    const b = f.charToGlyph('B');
    expect(a.unicode).toBe(65);
    expect(b.unicode).toBe(66);
    expect(a.index).not.toBe(b.index);
    expect(a.path.commands.length).toBeGreaterThan(10);
    // 字形のない文字は .notdef（別の字形にならない）
    expect(f.charToGlyph('C').index).toBe(0);
    expect(f.charToGlyph('あ').index).toBe(0);
    // 外側の輪郭は反時計回り（CFF の慣例）
    expect(signedArea(a.path.commands)).toBeGreaterThan(0);
    // 日本語の表示名
    expect(f.names.windows?.fontFamily?.ja).toBe('テスト手書き');
    expect(f.names.windows?.fontFamily?.en).toBe('TestHand');
  });

  it('欧文の送り幅は字形の幅＋左右余白で決まる', () => {
    const p = projectAB();
    const g = p.glyphs['65'];
    const ol = glyphOutline(g);
    const bb = ol.bbox!;
    expect(Math.round(bb.minX)).toBe(g.metrics.sideBearing);
    expect(ol.advance).toBe(Math.round(bb.maxX - bb.minX + g.metrics.sideBearing * 2));
  });

  it('全角文字は送り幅 1000 で、未完成の文字だけでも書き出せる', () => {
    const p = projectAB();
    const g = newGlyph(0x3042);
    g.objects = [stroke([[200, 300], [800, 300]]), stroke([[500, 150], [450, 850]])];
    p.glyphs[String(0x3042)] = g;
    // 輪郭が空（消しゴムで全部消えた）文字は除外される
    const e = newGlyph(0x3044);
    e.objects = [stroke([[300, 300], [700, 700]], 40), stroke([[300, 300], [700, 700]], 200, { erase: true })];
    p.glyphs[String(0x3044)] = e;
    const plan = planFont(p);
    expect(plan.glyphs.find((x) => x.cp === 0x3042)?.advance).toBe(1000);
    expect(plan.excluded).toContain(0x3044);
    const buf = buildOtf(plan, names);
    expect(verifyOtf(buf, plan, names).ok).toBe(true);
    const f = opentype.parse(buf);
    expect(f.charToGlyph('あ').unicode).toBe(0x3042);
    expect(f.charToGlyph('い').index).toBe(0);
  });

  it('英字フォント名が不正なら書き出さない', () => {
    const plan = planFont(projectAB());
    expect(() => buildOtf(plan, { ...names, familyName: 'てすと' })).toThrow();
  });
});
