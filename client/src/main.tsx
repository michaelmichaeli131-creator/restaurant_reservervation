import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initI18n } from './i18n';

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
  // Default to Hebrew
  return 'he';
}

// Initialize i18n before rendering
initI18n(getLang()).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
