// E2E テスト用の共通処理（Playwright + Chromium）
import { chromium } from 'playwright';
import fs from 'node:fs';

export const BASE = process.env.E2E_URL || 'http://localhost:4173/?e2e';
export const OUT = process.env.E2E_OUT || 'e2e/out';

export async function launch() {
  fs.mkdirSync(OUT, { recursive: true });
  const executablePath = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--no-zygote', '--single-process'],
  });
  // iPad Air（横向き）相当
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    hasTouch: true,
    acceptDownloads: true,
    locale: 'ja-JP',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept(d.defaultValue() || 'テスト'));
  return { browser, context, page, errors };
}

/** Apple Pencil 相当のポインターイベントで線を描く */
export async function penStroke(page, pts, { pointerType = 'pen', pressure = 0.6, steps = 8 } = {}) {
  await page.evaluate(
    ({ pts, pointerType, pressure, steps }) => {
      const el = document.querySelector('[data-testid="editor-canvas"]');
      const r = el.getBoundingClientRect();
      const id = 10 + Math.floor(Math.random() * 1000);
      const ev = (type, x, y, p) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: id,
            pointerType,
            isPrimary: true,
            clientX: r.left + x,
            clientY: r.top + y,
            pressure: p,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
          }),
        );
      ev('pointerdown', pts[0][0], pts[0][1], pressure);
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          ev('pointermove', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, pressure * (0.6 + 0.4 * Math.sin(t * Math.PI)));
        }
      }
      const last = pts[pts.length - 1];
      ev('pointerup', last[0], last[1], 0);
    },
    { pts, pointerType, pressure, steps },
  );
  await page.waitForTimeout(60);
}

export async function tap(page, x, y, pointerType = 'mouse') {
  await penStroke(page, [[x, y], [x, y]], { pointerType, steps: 1 });
}

/** ドキュメント座標 → キャンバス上の座標 */
export async function docToScreen(page, x, y) {
  return page.evaluate(
    ({ x, y }) => {
      // controller はグローバルに出していないので、キャンバスの表示倍率をストア経由ではなく DOM から推定できない。
      // 代わりに __flwView を使う
      const v = window.__flwView;
      return { x: x * v.s + v.tx, y: y * v.s + v.ty };
    },
    { x, y },
  );
}

export function state(page) {
  return page.evaluate(() => {
    const s = window.__flw.useStore.getState();
    return JSON.parse(JSON.stringify({ route: s.route, ui: s.ui, save: s.save, data: s.data, projects: s.projects }));
  });
}

export async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
