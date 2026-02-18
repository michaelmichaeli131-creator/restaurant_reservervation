import React from 'react';
import ReactDOM from 'react-dom/client';
import FloorViewPage from './FloorViewPage';
import '../index.css';

/**
 * Floor View App
 * - Used by waiter/host map screens
 * - Mounts into <div id="sb-floor-root" data-rid="...">
 */

function getRid(): string {
  const el = document.getElementById('sb-floor-root');
  const rid = el?.getAttribute('data-rid') || '';
  if (rid) return rid;
  const params = new URLSearchParams(window.location.search);
  return params.get('rid') || params.get('restaurantId') || '';
}

const rootEl = document.getElementById('sb-floor-root');
if (rootEl) {
  const rid = getRid();
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <FloorViewPage restaurantId={rid} />
    </React.StrictMode>
  );
}
