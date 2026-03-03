import React from 'react';
import ReactDOM from 'react-dom/client';
import FloorViewPage from './FloorViewPage';
import '../index.css';
import { initI18n } from '../i18n';

// Get language from server-provided config or cookie
declare global {
  interface Window {
    __APP_CONFIG__?: {
      page?: string;
      restaurantId?: string;
      lang?: string;
    };
  }
}

function getLang(): string {
  // Prefer server-provided config (when present)
  const cfg = window.__APP_CONFIG__?.lang;
  if (cfg && typeof cfg === 'string') return cfg;
  // Fallback to cookie
  const match = document.cookie.match(/(?:^|; )lang=([^;]*)/);
  if (match) return match[1];
  // Default to English
  return 'en';
}

const rootEl = document.getElementById('sb-floor-root');
if (!rootEl) {
  throw new Error('Missing #sb-floor-root');
}

const rid = rootEl.getAttribute('data-rid') || rootEl.getAttribute('data-restaurant-id') || '';
const clickMode = rootEl.getAttribute('data-click-mode') || rootEl.getAttribute('data-mode') || 'page';
const mountMode = (clickMode === 'lobby' || clickMode === 'host') ? 'lobby' : 'page';

console.info('[FloorView] mount', { rid, mountMode, clickMode });

// Initialize i18n before rendering (matches the editor app behavior)
initI18n(getLang()).finally(() => {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <FloorViewPage restaurantId={rid} mountMode={mountMode as any} />
    </React.StrictMode>
  );
});
