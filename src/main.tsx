import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { boot } from './store/store';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void boot();

// 自動テスト用の読み取りフック（URL に ?e2e を付けたときだけ）
if (location.search.includes('e2e')) {
  import('./store/store').then((m) => ((window as any).__flw = m));
}

// PWA（オフライン起動・ホーム画面追加）。更新は保存してから反映する
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      const update = registerSW({
        onNeedRefresh() {
          window.dispatchEvent(new CustomEvent('flw:need-refresh', { detail: () => update(true) }));
        },
      });
    })
    .catch(() => {});
}
