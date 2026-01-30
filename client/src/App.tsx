import { useEffect, useMemo, useState } from 'react';
import FloorEditor from './components/FloorEditor';
import ShiftBoard from './components/ShiftBoard';
import RestaurantLiveView from './components/RestaurantLiveView';
import AppShell from './app/AppShell';
import type { AppRouteKey } from './app/nav';
import './app/AppShell.css';

function normalizeRoute(input: string | null | undefined): AppRouteKey {
  // Backward compatible: server used to send page=floor or page=shifts
  if (!input) return 'layout';
  const p = String(input).toLowerCase();
  if (p === 'floor') return 'layout';
  if (p === 'shifts') return 'shifts';
  if (p === 'layout' || p === 'live' || p === 'settings') return p;
  return 'layout';
}

function setQueryParam(key: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState({}, '', url.toString());
}

function App() {
  // Get restaurant ID and default page from window config (set by server) or URL params
  const config = (window as any).__APP_CONFIG__ || {};
  const params = new URLSearchParams(window.location.search);
  const restaurantId = config.restaurantId || params.get('restaurantId') || '';

  const initialRoute = normalizeRoute(config.page || params.get('page'));
  const [route, setRoute] = useState<AppRouteKey>(initialRoute);

  useEffect(() => {
    // Keep URL in sync (also helps refresh/share links)
    setQueryParam('page', route);
  }, [route]);

  const title = useMemo(() => {
    switch (route) {
      case 'layout':
        return 'Floor Layout';
      case 'live':
        return 'Live View';
      case 'shifts':
        return 'Shifts';
      case 'settings':
        return 'Settings';
      default:
        return 'Restaurant App';
    }
  }, [route]);

  const content = useMemo(() => {
    if (!restaurantId) {
      return (
        <div className="app-empty-state">
          <h2>Missing restaurantId</h2>
          <p className="muted">Please open this app with a restaurantId query param.</p>
        </div>
      );
    }

    if (route === 'layout') return <FloorEditor restaurantId={restaurantId} />;
    if (route === 'live') return <RestaurantLiveView restaurantId={restaurantId} />;
    if (route === 'shifts') return <ShiftBoard restaurantId={restaurantId} />;

    // Settings (placeholder – easy to extend later)
    return (
      <div className="app-settings">
        <div className="app-card">
          <h2>Settings</h2>
          <p className="muted">This screen is ready for your future app settings (users, permissions, notifications, theme, etc.).</p>
        </div>
      </div>
    );
  }, [restaurantId, route]);

  return (
    <AppShell title={title} activeRoute={route} onNavigate={setRoute}>
      {content}
    </AppShell>
  );
}

export default App;
