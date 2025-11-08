import { useState } from 'react';
import FloorEditor from './components/FloorEditor';
import './App.css';

function App() {
  const [mode, setMode] = useState<'edit' | 'live'>('edit');

  // Get restaurant ID from URL params (passed from server)
  const params = new URLSearchParams(window.location.search);
  const restaurantId = params.get('restaurantId') || '';

  return (
    <div className="app">
      <header className="app-header">
        <h1>🍽️ Floor Plan Manager</h1>
        <div className="mode-switch">
          <button
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => setMode('edit')}
          >
            ✏️ Edit Layout
          </button>
          <button
            className={mode === 'live' ? 'active' : ''}
            onClick={() => setMode('live')}
          >
            👁️ Live View
          </button>
        </div>
      </header>

      <main className="app-main">
        {mode === 'edit' ? (
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
