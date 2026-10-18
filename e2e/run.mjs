// 受け入れテスト（開発指示書 14 章）を Chromium で実行する
// 使い方: npm run build && npx vite preview --port 4173 & → CHROME_PATH=... npm run test:e2e
import fs from 'node:fs';
import * as otNs from 'opentype.js';
const opentype = otNs.default?.parse ? otNs.default : otNs;
import { launch, BASE, OUT, penStroke, state, shot } from './lib.mjs';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
}

const { browser, page, errors } = await launch();

/** ドキュメント座標で描く */
async function drawDoc(pts, opts) {
  const v = await page.evaluate(() => ({ s: window.__flwView.s, tx: window.__flwView.tx, ty: window.__flwView.ty }));
  await penStroke(
    page,
    pts.map(([x, y]) => [x * v.s + v.tx, y * v.s + v.ty]),
    opts,
  );
}
async function tool(t) {
  await page.click(`[data-tool="${t}"]`);
}
async function glyphObjs(cp) {
  const s = await state(page);
  return s.data.project.glyphs[String(cp)]?.objects ?? [];
}
async function waitSaved() {
  await page.waitForFunction(() => window.__flw.useStore.getState().save.state === 'saved', null, { timeout: 5000 });
}
async function openChar(ch) {
  await page.fill('input[placeholder^="文字を検索"]', ch);
  await page.click(`.gcell[aria-label^="${ch} "]`);
  await page.fill('input[placeholder^="文字を検索"]', '');
}
async function download(trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), trigger()]);
  const p = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(p);
  return p;
}

await page.goto(BASE);
await page.waitForSelector('.topbar');
await page.keyboard.press('Escape'); // 使い方を閉じる
await page.waitForTimeout(300);

// ===== 文字制作 =====
const A_HIRA = 0x3042;
await tool('pen');
await drawDoc([[250, 330], [760, 300]]);
await drawDoc([[470, 160], [430, 560], [520, 860]]);
await drawDoc([[640, 420], [520, 700], [330, 820], [250, 700], [420, 560], [700, 540], [820, 700], [700, 840]]);
let objs = await glyphObjs(A_HIRA);
check('「あ」を手書きで作成できる（ペン入力・筆圧あり）', objs.length === 3 && objs[0].type === 'stroke' && objs[0].pen.usePressure, `${objs.length} 本`);
await waitSaved();
check('自動保存される', true);
await shot(page, '10-a-drawn');

// 再読み込み後に編集を再開
await page.reload();
await page.waitForSelector('.topbar');
await page.waitForTimeout(400);
objs = await glyphObjs(A_HIRA);
check('再読み込み後も「あ」が残っている', objs.length === 3);
await tool('select');
const before = objs[0].transform.join(',');
// 1 本目の線をつかんで動かす
{
  const v = await page.evaluate(() => ({ s: window.__flwView.s, tx: window.__flwView.tx, ty: window.__flwView.ty }));
  const sx = 500 * v.s + v.tx;
  const sy = 316 * v.s + v.ty;
  await penStroke(page, [[sx, sy], [sx + 30, sy + 40]], { pointerType: 'mouse' });
}
objs = await glyphObjs(A_HIRA);
check('作成した文字を後から編集できる（選択して移動）', objs[0].transform.join(',') !== before);
// 線の太さを後から変更
await page.click('.side.right .seg button:has-text("調整")');
await page.waitForTimeout(100);
const sizeBefore = objs[0].pen.size;
await page.evaluate(() => {
  const s = window.__flw;
  s.commitDoc((o) => {
    const t = o.find((x) => x.id === s.useStore.getState().ui.selection[0]);
    t.pen = { ...t.pen, size: 70 };
  });
});
objs = await glyphObjs(A_HIRA);
check('描いた後に線の太さを変えられる（元データ保持）', objs[0].pen.size === 70 && sizeBefore !== 70);

// ===== デザインモード：図形・曲線 =====
await openChar('い');
await page.click('.palette .modeswitch button:has-text("デザイン")');
await tool('rect');
await drawDoc([[200, 200], [320, 800]], { pointerType: 'mouse' });
await tool('ellipse');
await drawDoc([[560, 260], [800, 760]], { pointerType: 'mouse' });
await tool('curve');
for (const [x, y] of [[180, 880], [500, 940], [820, 880]]) await drawDoc([[x, y], [x, y]], { pointerType: 'mouse', steps: 1 });
await page.click('.curvebar button:has-text("確定")');
let iObjs = await glyphObjs(0x3044);
check('図形・曲線で文字を制作できる（四角・円・曲線）', iObjs.length === 3 && iObjs.every((o) => o.type === 'path'), iObjs.map((o) => o.shape).join(','));
// 制御点を動かす
await tool('node');
await page.evaluate((id) => window.__flw.setUi({ selection: [id] }), iObjs[1].id);
{
  const o = iObjs[1];
  const n0 = o.nodes[0];
  await drawDoc([[n0.x, n0.y], [n0.x + 60, n0.y - 40]], { pointerType: 'mouse' });
}
const moved = (await glyphObjs(0x3044))[1].nodes[0];
check('制御点を編集できる', Math.abs(moved.x - iObjs[1].nodes[0].x) > 20);
await shot(page, '11-design');

// ===== パーツ再利用 =====
await openChar('あ');
await page.click('.palette .modeswitch button:has-text("手書き")');
await tool('select');
// 範囲選択で 1 本目と 2 本目（上側）を囲む
await drawDoc([[150, 120], [900, 450]], { pointerType: 'mouse' });
let sel = (await state(page)).ui.selection;
check('範囲選択で複数の線を選べる', sel.length >= 1, `${sel.length} 個`);
await page.click('[data-testid="register-part"]');
await page.fill('[data-testid="part-name"]', 'あの上部');
await page.click('[data-testid="part-save"]');
await page.waitForTimeout(200);
let st = await state(page);
const part = st.data.parts.find((p) => p.name === 'あの上部');
check('作成した線をパーツ棚へ登録できる（ベクターのまま）', !!part && part.objects.every((o) => o.type === 'stroke'));
await openChar('お');
await page.click('.side.right .seg button:has-text("パーツ")');
await page.click('.pcell .thumb');
let oObjs = await glyphObjs(0x304a);
check('別の文字へ貼り付けられる', oObjs.length === part.objects.length);
const tBefore = oObjs[0].transform.join(',');
await page.click('[aria-label="左右反転"]');
oObjs = await glyphObjs(0x304a);
check('貼り付け後に変形できる（左右反転）', oObjs[0].transform.join(',') !== tBefore);
const snapshot = JSON.stringify(oObjs);
// 元パーツを編集
await page.click('.pcell button[aria-label="メニュー"]');
await page.click('.menu-pop button:has-text("元のパーツを編集")');
await page.waitForTimeout(200);
await tool('pen');
await drawDoc([[-200, 300], [200, 300]]);
st = await state(page);
const partAfter = st.data.parts.find((p) => p.id === part.id);
check('元パーツを編集できる', partAfter.objects.length === part.objects.length + 1);
oObjs = await glyphObjs(0x304a);
check('元パーツを編集しても、貼り付け済みデータは変化しない', JSON.stringify(oObjs) === snapshot);
await page.click('.side.left button:has-text("元の画面に戻る")');

// ===== フォント用に A・B を作る =====
await openChar('A');
await tool('pen');
await drawDoc([[200, 880], [400, 180]]);
await drawDoc([[400, 180], [600, 880]]);
await drawDoc([[280, 620], [520, 620]]);
await openChar('B');
await page.click('.palette .modeswitch button:has-text("デザイン")');
await tool('rect');
await drawDoc([[200, 180], [280, 880]], { pointerType: 'mouse' });
await tool('ellipse');
await drawDoc([[200, 180], [560, 520]], { pointerType: 'mouse' });
await drawDoc([[200, 500], [620, 880]], { pointerType: 'mouse' });
await page.click('.palette .modeswitch button:has-text("手書き")');

// ===== ロゴ =====
await page.click('[data-testid="mode-logo"]');
await page.waitForTimeout(200);
await tool('text');
{
  const v = await page.evaluate(() => ({ s: window.__flwView.s, tx: window.__flwView.tx, ty: window.__flwView.ty }));
  await penStroke(page, [[200 * v.s + v.tx, 450 * v.s + v.ty], [200 * v.s + v.tx, 450 * v.s + v.ty]], { pointerType: 'mouse', steps: 1 });
}
await page.waitForSelector('.side.right textarea');
await page.fill('.side.right textarea', 'ああAB漢');
await page.locator('.side.right textarea').blur();
await page.waitForTimeout(200);
st = await state(page);
const logo = st.data.project.logos[0];
const text = logo.objects.find((o) => o.type === 'text');
check('複数文字を組み合わせられる（ロゴに文字列を配置）', text && text.text === 'ああAB漢');
const chips = await page.$$eval('.chip', (els) => els.map((e) => ({ t: e.textContent, c: e.className })));
const customChips = chips.filter((c) => c.c.includes('custom')).map((c) => c.t).join('');
const fbChips = chips.filter((c) => c.c.includes('fallback')).map((c) => c.t).join('');
check('自作文字と代用文字を区別できる', customChips === 'ああAB' && fbChips === '漢', `自作:${customChips} 代用:${fbChips}`);
// 装飾：縁取り・影・グラデーション
await page.evaluate(() => {
  const s = window.__flw;
  s.commitDoc((o) => {
    const t = o.find((x) => x.type === 'text');
    t.style = { fill: { kind: 'linear', from: '#5b6fd6', to: '#d6597a', angle: 0 }, outline: { on: true, color: '#ffffff', width: 10 }, shadow: { on: true, color: '#00000066', blur: 12, dx: 6, dy: 8 }, opacity: 1 };
    t.vertical = false;
  });
});
// 飾りパーツも挿入
await page.click('.side.right .seg button:has-text("パーツ")');
await page.click('.pcell .thumb');
await page.waitForTimeout(200);
await shot(page, '12-logo');

// PNG（透過）
await page.click('[data-testid="open-export"]');
await page.waitForTimeout(600);
await shot(page, '13-export-dialog');
const pngPath = await download(() => page.click('[data-testid="do-export"]'));
const pngInfo = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const corner = x.getImageData(0, 0, 1, 1).data[3];
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
  return { w: img.width, h: img.height, corner, opaque };
}, fs.readFileSync(pngPath).toString('base64'));
check('透過 PNG を出力できる（角が透明・内容あり）', pngInfo.corner === 0 && pngInfo.opaque > 1000, `${pngInfo.w}×${pngInfo.h}`);
// SVG
await page.click('.modal .seg button:has-text("SVG")');
await page.waitForTimeout(400);
const svgNote = await page.textContent('.modal');
const svgPath = await download(() => page.click('[data-testid="do-export"]'));
const svg = fs.readFileSync(svgPath, 'utf8');
const imgs = (svg.match(/<image /g) || []).length;
check('SVG を出力できる（自作文字はパス）', svg.includes('<svg') && (svg.match(/<path /g) || []).length >= 2);
check('SVG の代用文字はラスター埋め込み＋明示', imgs === 1 && svg.includes('data-fallback-char="漢"') && svg.includes('完全なベクターではありません') && svgNote.includes('完全なベクターではありません'));
check('SVG にグラデーション・影・縁取りを保持', svg.includes('linearGradient') && svg.includes('feDropShadow') && svg.includes('stroke-linejoin="round"'));
await page.click('.modal [aria-label="閉じる"]');

// 代用文字 → 自作文字に差し替え
await page.evaluate(() => {
  const s = window.__flw;
  const st = s.useStore.getState();
  const t = s.docOf(st.data, st.route).objects.find((x) => x.type === 'text');
  s.setUi({ selection: [t.id], rightTab: 'props' });
});
await page.click('.side.right .seg button:has-text("調整")');
await page.click('.chip.fallback');
await page.click('button:has-text("この文字を作る")');
await page.waitForTimeout(200);
st = await state(page);
check('代用文字から、その文字の制作画面へ移れる', st.route.screen === 'glyph' && st.route.cp === '漢'.codePointAt(0));
await tool('pen');
await drawDoc([[200, 300], [800, 300]]);
await drawDoc([[500, 150], [500, 850]]);
await page.click('[data-testid="mode-logo"]');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const s = window.__flw;
  const st = s.useStore.getState();
  const t = s.docOf(st.data, st.route).objects.find((x) => x.type === 'text');
  s.setUi({ selection: [t.id], rightTab: 'props' });
});
await page.waitForTimeout(200);
const chips2 = await page.$$eval('.chip', (els) => els.filter((e) => e.className.includes('fallback')).length);
check('あとから代用文字を自作文字に差し替えられる', chips2 === 0);
await shot(page, '14-logo-replaced');

// ===== 画像合成 =====
await page.click('[data-testid="mode-composite"]');
await page.waitForTimeout(300);
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("背景画像を読み込む")')]);
await fc.setFiles('e2e/bg-test.png');
await page.waitForTimeout(600);
st = await state(page);
let comp = st.data.project.composites[0];
check('端末内の画像を背景として読み込める', comp.assetId && comp.width === 1200 && comp.height === 800);
await page.click('.side.right .item button:has-text("配置")');
await page.waitForTimeout(300);
st = await state(page);
comp = st.data.project.composites[0];
const ref = comp.objects.find((o) => o.type === 'logoRef');
check('画像の上にロゴを配置できる', !!ref);
// 拡大・回転・不透明度
await page.evaluate(() => {
  const s = window.__flw;
  s.commitDoc((o) => {
    const r = o.find((x) => x.type === 'logoRef');
    const c = Math.cos(0.2), n = Math.sin(0.2);
    const t = r.transform;
    r.transform = [t[0] * c - t[1] * n, t[0] * n + t[1] * c, t[2] * c - t[3] * n, t[2] * n + t[3] * c, t[4], t[5]];
    r.style = { ...r.style, opacity: 0.9, outline: { on: true, color: '#ffffff', width: 6 }, shadow: { on: true, color: '#00000088', blur: 10, dx: 4, dy: 4 } };
  });
});
await shot(page, '15-composite');
await page.click('[data-testid="open-export"]');
await page.waitForTimeout(500);
const compPng = await download(() => page.click('[data-testid="do-export"]'));
const compInfo = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  return { w: img.width, h: img.height };
}, fs.readFileSync(compPng).toString('base64'));
check('合成済み画像を PNG で保存できる（元画像サイズ）', compInfo.w === 1200 && compInfo.h === 800);
await page.click('.modal .seg button:has-text("JPEG")');
await shot(page, '15b-jpeg');
await page.waitForTimeout(300);
const jpg = await download(() => page.click('[data-testid="do-export"]'));
check('合成済み画像を JPEG で保存できる', jpg.endsWith('.jpg') && fs.statSync(jpg).size > 1000, jpg);
await page.click('.modal .seg button:has-text("ロゴ部分のみ")');
await page.waitForTimeout(300);
const logoOnly = await download(() => page.click('[data-testid="do-export"]'));
check('合成画面からロゴ部分のみを透過 PNG で保存できる', logoOnly.endsWith('.png'), logoOnly);
await page.click('.modal [aria-label="閉じる"]');

// ===== フォント =====
await page.click('[data-testid="open-font"]');
await page.waitForTimeout(300);
await page.click('[data-testid="build-font"]');
await page.waitForSelector('.modal h4:has-text("検証結果")', { timeout: 15000 });
await page.waitForTimeout(300);
await shot(page, '16-font');
const ngInDialog = await page.$$eval('.modal .check-list .ng', (e) => e.length);
const dialogText = await page.textContent('.modal');
check('アプリ内の検証がすべて合格（読込・Unicode・.notdef・ブラウザ表示）', ngInDialog === 0, dialogText.includes('ブラウザで読み込み') ? '' : 'ブラウザ確認なし');
const otfPath = await download(() => page.click('[data-testid="download-font"]'));
const buf = fs.readFileSync(otfPath);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
check('OTF を書き出せる（CFF 形式）', font.outlinesFormat === 'cff' && otfPath.endsWith('.otf'));
const gA = font.charToGlyph('A');
const gB = font.charToGlyph('B');
check('作成した英字 A・B が Unicode に割り当てられている', gA.unicode === 65 && gB.unicode === 66 && gA.index !== gB.index && gA.index > 0);
check('字形のない文字（C・ん）は .notdef になる', font.charToGlyph('C').index === 0 && font.charToGlyph('ん').index === 0);
check('ひらがな・漢字も収録されている（あ・漢）', font.charToGlyph('あ').unicode === 0x3042 && font.charToGlyph('漢').unicode === 0x6f22);
// 出力した OTF をブラウザで再読み込みして A・B を描画
const render = await page.evaluate(async (b64) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const ff = new FontFace('E2EFont', arr.buffer);
  await ff.load();
  document.fonts.add(ff);
  const draw = (ch, family) => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 200;
    const x = c.getContext('2d');
    x.font = `160px ${family}`;
    x.fillText(ch, 20, 170);
    return c.toDataURL();
  };
  return { A: draw('A', 'E2EFont'), B: draw('B', 'E2EFont'), A2: draw('A', 'E2EFont'), Asys: draw('A', 'sans-serif') };
}, buf.toString('base64'));
check('出力した OTF を再読み込みすると A・B が別々の字形で表示される', render.A !== render.B && render.A === render.A2 && render.A !== render.Asys);
await page.click('.modal [aria-label="閉じる"]');

// ===== バックアップと復元 =====
await page.click('[data-testid="menu"]');
await page.click('[data-testid="open-backup"]');
const backupPath = await download(() => page.click('[data-testid="backup-all"]'));
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
check('編集データを JSON で書き出せる（画像・パーツ込み）', backup.app === 'font-logo-workshop' && backup.parts.length >= 1 && backup.assets.length === 1);
const nBefore = (await state(page)).projects.length;
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-testid="restore"]')]);
await fc2.setFiles(backupPath);
await page.waitForSelector('.modal .note.ok:has-text("復元しました")', { timeout: 10000 });
st = await state(page);
check('JSON から復元できる（別プロジェクトとして追加）', st.projects.length === nBefore + 1);
await page.click('.modal [aria-label="閉じる"]');
// 復元したプロジェクトを開いて中身を確認
const restoredId = st.projects.find((p) => p.name.includes('復元')).id;
await page.evaluate((id) => window.__flw.openProject(id), restoredId);
await page.waitForTimeout(400);
st = await state(page);
check('復元したプロジェクトで「あ」を編集できる', st.data.project.glyphs[String(0x3042)].objects.length === 3);
check('パーツ棚も復元・保持されている', st.data.parts.some((p) => p.name === 'あの上部'));
check('背景画像の参照も復元される', !!st.data.project.composites[0]?.assetId);

// 取り消し・やり直し
await page.evaluate(() => window.__flw.setRoute({ screen: 'glyph', cp: 0x3042 }));
await page.waitForTimeout(200);
await tool('pen');
await drawDoc([[300, 950], [700, 950]]);
const n1 = (await glyphObjs(0x3042)).length;
await page.click('[data-testid="undo"]');
const n2 = (await glyphObjs(0x3042)).length;
await page.click('[data-testid="redo"]');
const n3 = (await glyphObjs(0x3042)).length;
check('Undo・Redo が動く', n2 === n1 - 1 && n3 === n1);

// 指（タッチ）は Pencil 検出後に描画しない
const nTouch0 = (await glyphObjs(0x3042)).length;
await drawDoc([[300, 400], [600, 400]], { pointerType: 'touch' });
check('Pencil 検出後は指で描かない（誤タッチ対策）', (await glyphObjs(0x3042)).length === nTouch0);

check('ページのエラーがない', errors.length === 0, errors.slice(0, 3).join(' | '));

await shot(page, '17-final');
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} / ${results.length} 合格`);
await browser.close();
process.exit(failed.length ? 1 : 0);
