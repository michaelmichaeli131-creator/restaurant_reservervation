import { useState } from 'react';
import { t } from './i18n';
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
  const page = config.page || params.get('page') || 'floor'; // 'floor' or 'shifts'
  const tx = (key: string, fallback: string) => t(key, fallback);

  if (page === 'shifts') {
    return (
      <div className="app shifts-app">
        <ShiftBoard restaurantId={restaurantId} />
      </div>
    );
  }

  // Default: Floor Plan page
  return (
    <div className="app">
      <header className="app-header">
        <h1>{tx('floor.app_title', 'Floor Plan Manager')}</h1>
        <nav className="mode-switch" aria-label={tx('floor.view_mode', 'View mode')}>
          <button
            className={floorMode === 'edit' ? 'active' : ''}
            onClick={() => setFloorMode('edit')}
            aria-pressed={floorMode === 'edit'}
            aria-label={tx('floor.edit_mode', 'Switch to edit layout mode')}
          >
            {tx('floor.edit_layout', 'Edit Layout')}
          </button>
          <button
            className={floorMode === 'live' ? 'active' : ''}
            onClick={() => {
              if (window.dispatchEvent(new Event('floor-before-leave', { cancelable: true }))) setFloorMode('live');
            }}
            aria-pressed={floorMode === 'live'}
            aria-label={tx('floor.live_mode', 'Switch to live view mode')}
          >
            {tx('floor.live_view', 'Live View')}
          </button>
        </nav>
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
