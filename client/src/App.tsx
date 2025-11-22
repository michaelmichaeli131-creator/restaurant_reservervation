import { useState } from 'react';
import FloorEditor from './components/FloorEditor';
import ShiftScheduler from './components/ShiftScheduler';
import './App.css';

function App() {
  const [floorMode, setFloorMode] = useState<'edit' | 'live'>('edit');

  // Get restaurant ID and page from window config (set by server) or URL params
  const config = (window as any).__APP_CONFIG__ || {};
  const params = new URLSearchParams(window.location.search);

  const restaurantId = config.restaurantId || params.get('restaurantId') || '';
  const page = config.page || params.get('page') || 'floor'; // 'floor' or 'shifts'

  if (page === 'shifts') {
    return (
      <div className="app shifts-app">
        <ShiftScheduler restaurantId={restaurantId} />
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
          <div className="live-view-placeholder">
            <p>Live view coming soon...</p>
            <p className="muted">Real-time table status and orders</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
