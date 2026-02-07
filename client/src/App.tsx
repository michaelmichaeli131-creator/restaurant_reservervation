import { useState } from 'react';
import FloorEditor from './components/FloorEditor';
import ShiftBoard from './components/ShiftBoard';
import RestaurantLiveView from './components/RestaurantLiveView';
import './App.css';

function App() {
  // Get restaurant ID and page from window config (set by server) or URL params
  const config = (window as any).__APP_CONFIG__ || {};
  const params = new URLSearchParams(window.location.search);

  const role = config.role || params.get('role') || 'owner';
  const initialTab = config.initialTab || params.get('tab') || (role === 'waiter' || role === 'host' ? 'live' : 'edit');
  const [floorMode, setFloorMode] = useState<'edit' | 'live'>(initialTab === 'live' ? 'live' : 'edit');

  const restaurantId = config.restaurantId || params.get('restaurantId') || '';
  const page = config.page || params.get('page') || 'floor'; // 'floor' or 'shifts'

  if (page === 'shifts') {
    return (
      <div className="app shifts-app">
        <ShiftBoard restaurantId={restaurantId} />
      </div>
    );
  }

  // Staff compact modes (waiter / host): live-only (no edit)
  if (role === 'waiter' || role === 'host') {
    const variant = (config.variant || params.get('variant') || (role === 'waiter' ? 'waiter' : 'map')) as any;
    return (
      <div className={`app staff-mode role-${role}`}>
        <main className="app-main">
          <RestaurantLiveView restaurantId={restaurantId} variant={variant} />
        </main>
      </div>
    );
  }

  // Default: Floor Plan page (owner)
  return (
    <div className="app">
      <header className="app-header">
        <h1>🍽️ Floor Plan Manager</h1>
        <div className="mode-switch">
          <button className={floorMode === 'edit' ? 'active' : ''} onClick={() => setFloorMode('edit')}>
            ✏️ Edit Layout
          </button>
          <button className={floorMode === 'live' ? 'active' : ''} onClick={() => setFloorMode('live')}>
            👁️ Live View
          </button>
        </div>
      </header>

      <main className="app-main">
        {floorMode === 'edit' ? (
          <FloorEditor restaurantId={restaurantId} />
        ) : (
          <RestaurantLiveView restaurantId={restaurantId} />
        )}
      </main>
    </div>
  );
}

export default App;
