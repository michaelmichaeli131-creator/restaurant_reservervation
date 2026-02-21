import React from 'react';
import ReactDOM from 'react-dom/client';
import FloorViewPage from './FloorViewPage';
import '../index.css';

const rootEl = document.getElementById('sb-floor-root');
if (!rootEl) {
  throw new Error('Missing #sb-floor-root');
}

const rid = rootEl.getAttribute('data-rid') || rootEl.getAttribute('data-restaurant-id') || '';
const clickMode = rootEl.getAttribute('data-click-mode') || rootEl.getAttribute('data-mode') || 'page';
const mountMode = clickMode === 'lobby' ? 'lobby' : 'page';

console.info('[FloorView] mount', { rid, mountMode, clickMode });

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <FloorViewPage restaurantId={rid} mountMode={mountMode as any} />
  </React.StrictMode>
);
