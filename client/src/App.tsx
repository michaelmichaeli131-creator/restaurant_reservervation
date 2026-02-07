import { useMemo, useState } from 'react';
import FloorEditor from './components/FloorEditor';
import ShiftBoard from './components/ShiftBoard';
import RestaurantLiveView from './components/RestaurantLiveView';
import './App.css';

function App() {
  const [floorMode, setFloorMode] = useState<'edit' | 'live'>('edit');

  // Get restaurant ID and page from window config (set by server) or URL params
  const config = (window as any).__APP_CONFIG__ || {};
  const params = new URLSearchParams(window.location.search);

  const restaurantId = config.restaurantId || params.get('restaurantId') || '';
  const page = config.page || params.get('page') || 'floor'; // 'floor' | 'shifts' | 'host' | 'waiter'
  const embed = Boolean(config.embed || params.get('embed'));

  // Some screens (Host/Waiter) should always show live view only (no editor UI)
  const embeddedMode = useMemo(() => {
    if (page === 'host' || page === 'waiter') return true;
    return embed;
  }, [page, embed]);

  if (page === 'shifts') {
    return (
      <div className="app shifts-app">
        <ShiftBoard restaurantId={restaurantId} />
      </div>
    );
  }

  // Embedded/live-only shell for Host/Waiter screens
  if (embeddedMode) {
    return (
      <div className={`app embedded ${page}-embedded`}>
        <main className="app-main embedded-main">
          <RestaurantLiveView restaurantId={restaurantId} embedded />
        </main>
      </div>
    );
  }

  // Default: Floor Plan page
  return (
    <div className="app">
      <header className="app-header">
        <h1>🍽️ Floor Plan Manager</h1>
        <div className="mode-switch">
          <button
            className={floorMode === 'edit' ? 'active' : ''}
            onClick={() => setFloorMode('edit')}
          >
            ✏️ Edit Layout
          </button>
          <button
            className={floorMode === 'live' ? 'active' : ''}
            onClick={() => setFloorMode('live')}
          >
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
