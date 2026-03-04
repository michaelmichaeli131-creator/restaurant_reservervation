import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initI18n } from './i18n';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';

// Vite extracts CSS into separate files during production builds.
// Ensure the required stylesheets are loaded even if the HTML template
// does not include them explicitly.
function ensureCSS(href: string) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
ensureCSS('/dist/floor-index.css');
ensureCSS('/dist/floor-floor-app.css');

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
  // First, check server-provided config
  if (window.__APP_CONFIG__?.lang) {
    return window.__APP_CONFIG__.lang;
  }
  // Fallback to cookie
  const match = document.cookie.match(/(?:^|; )lang=([^;]*)/);
  if (match) {
    return match[1];
  }
  // Default to English
  return 'en';
}

// Initialize i18n before rendering
initI18n(getLang()).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
});
