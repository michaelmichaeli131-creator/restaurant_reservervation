import { useState, useEffect } from 'react';
import './RestaurantLiveView.css';
import TableContextMenu from './TableContextMenu';
import { t } from '../i18n';

interface TableStatus {
  tableId: string;
  tableNumber: number;
  status: 'empty' | 'occupied' | 'reserved' | 'dirty';
  guestCount?: number;
  orderId?: string;
  orderTotal?: number;
  occupiedSince?: number;
  itemsReady?: number;
  itemsPending?: number;
}

interface FloorTable {
  id: string;
  name: string;
  tableNumber: number;
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  seats: number;
  shape: 'square' | 'round' | 'rect' | 'booth';
  sectionId?: string;
}

interface FloorObject {
  id: string;
  type: 'wall' | 'door' | 'bar' | 'plant' | 'divider';
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  rotation?: 0 | 90 | 180 | 270;
  label?: string;
}

interface FloorLayout {
  id: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  tables: FloorTable[];
  objects?: FloorObject[];
  isActive: boolean;
  tableStatuses?: TableStatus[];
}

interface RestaurantLiveViewProps {
  restaurantId: string;
  /** When true, renders map only (no header/legend) for Host/Waiter screens */
  embedded?: boolean;
}

const STATUS_COLORS = {
  empty: '#4CAF50',        // Green
  occupied: '#FF6B6B',     // Red
  reserved: '#FFC107',     // Orange
  dirty: '#9C27B0',        // Purple
};

const STATUS_LABELS = {
  empty: t('floor.status.empty', 'Empty'),
  occupied: t('floor.status.occupied', 'Occupied'),
  reserved: t('floor.status.reserved', 'Reserved'),
  dirty: t('floor.status.dirty', 'Dirty'),
};

export default function RestaurantLiveView({ restaurantId, embedded }: RestaurantLiveViewProps) {
  const [layouts, setLayouts] = useState<FloorLayout[]>([]);
  const [currentLayout, setCurrentLayout] = useState<FloorLayout | null>(null);
  const [tableStatuses, setTableStatuses] = useState<Map<string, TableStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5000); // 5 seconds
  const [selectedTable, setSelectedTable] = useState<TableStatus | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Load all layouts
  useEffect(() => {
    const loadLayouts = async () => {
      try {
        const res = await fetch(`/api/floor-layouts/${restaurantId}`);
        if (res.ok) {
          const allLayouts: FloorLayout[] = await res.json();
          setLayouts(allLayouts);

          // Find active layout or use first one
          const active = allLayouts.find(l => l.isActive) || allLayouts[0];
          if (active) {
            await loadLayout(active.id);
          }
        }
      } catch (err) {
        console.error('Failed to load layouts:', err);
      } finally {
        setLoading(false);
      }
    };

    loadLayouts();
  }, [restaurantId]);

  // Load specific layout with table statuses
  const loadLayout = async (layoutId: string) => {
    try {
      const res = await fetch(`/api/floor-layouts/${restaurantId}/${layoutId}`);
      if (res.ok) {
        const layout: FloorLayout = await res.json();
        setCurrentLayout(layout);

        // Initialize table statuses
        if (layout.tableStatuses) {
          const statusMap = new Map();
          layout.tableStatuses.forEach(ts => {
            statusMap.set(ts.tableId, ts);
          });
          setTableStatuses(statusMap);
        }
      }
    } catch (err) {
      console.error('Failed to load layout:', err);
    }
  };

  // Auto-refresh table statuses
  useEffect(() => {
    if (!autoRefresh || !currentLayout) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/floor-layouts/${restaurantId}/${currentLayout.id}`);
        if (res.ok) {
          const layout: FloorLayout = await res.json();
          if (layout.tableStatuses) {
            const statusMap = new Map();
            layout.tableStatuses.forEach(ts => {
              statusMap.set(ts.tableId, ts);
            });
            setTableStatuses(statusMap);
          }
        }
      } catch (err) {
        console.error('Failed to refresh table statuses:', err);
      }
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [restaurantId, autoRefresh, refreshInterval, currentLayout]);

  if (loading) {
    return <div className="live-view-loading">{t('floor.loading', 'Loading floor layouts...')}</div>;
  }

  if (!currentLayout) {
    return (
      <div className="live-view-error">
        <p>{t('floor.empty_state', 'No floor layouts found. Please create a floor layout first.')}</p>
      </div>
    );
  }

  const getTableStatus = (tableId: string): TableStatus => {
    return tableStatuses.get(tableId) || {
      tableId,
      tableNumber: 0,
      status: 'empty',
    };
  };

  const handleTableClick = (status: TableStatus) => {
    setSelectedTable(status);
    setIsMenuOpen(true);
  };

  const handleStatusChange = (tableId: string, newStatus: string) => {
    const updatedStatus = { ...getTableStatus(tableId), status: newStatus as any };
    setTableStatuses(prev => new Map(prev).set(tableId, updatedStatus));
  };

  const formatTime = (timestamp?: number): string => {
    if (!timestamp) return '';
    const mins = Math.floor((Date.now() - timestamp) / 1000 / 60);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  const formatPrice = (price?: number): string => {
    if (!price) return '₪0';
    return `₪${price.toFixed(0)}`;
  };

  const handleLayoutChange = (layoutId: string) => {
    const selected = layouts.find(l => l.id === layoutId);
    if (selected) {
      loadLayout(layoutId);
    }
  };

  return (
    <div className={`restaurant-live-view ${embedded ? 'is-embedded' : ''}`}>
      {!embedded && (
      <div className="live-view-header">
        <div className="header-title">
          <h1>🔴 Live Floor View</h1>
          {layouts.length > 1 && (
            <div className="layout-selector-live">
              <label>Layout:</label>
              <select
                value={currentLayout.id}
                onChange={(e) => handleLayoutChange(e.target.value)}
                className="layout-select"
              >
                {layouts.map((layout) => (
                  <option key={layout.id} value={layout.id}>
                    {layout.name} {layout.isActive ? '★' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="control-panel">
          <label className="auto-refresh-label">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {t('live.auto_refresh', 'Auto-refresh')}
          </label>
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            disabled={!autoRefresh}
            className="refresh-interval-select"
          >
            <option value={3000}>3s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
            <option value={15000}>15s</option>
          </select>
          <button
            className="refresh-btn"
            onClick={() => currentLayout && loadLayout(currentLayout.id)}
          >
            🔄 {t('common.btn_refresh', 'Refresh')}
          </button>
        </div>
      </div>
      )}

      <div className="live-view-container">
        <div className="floor-grid" style={{
          gridTemplateColumns: `repeat(${currentLayout.gridCols}, 1fr)`,
          gridTemplateRows: `repeat(${currentLayout.gridRows}, 1fr)`,
        }}>
          {(currentLayout.objects ?? []).map((obj) => (
            <div
              key={obj.id}
              className={`floor-object-live type-${obj.type}`}
              style={{
                gridColumn: `${obj.gridX + 1} / span ${obj.spanX}`,
                gridRow: `${obj.gridY + 1} / span ${obj.spanY}`,
                transform: `rotate(${obj.rotation ?? 0}deg)`,
              }}
              title={obj.label || obj.type}
            >
              <span className="obj-icon">
                {obj.type === 'wall' ? '🧱' : obj.type === 'door' ? '🚪' : obj.type === 'bar' ? '🍸' : obj.type === 'plant' ? '🪴' : '➖'}
              </span>
              {obj.label ? <span className="obj-label">{obj.label}</span> : null}
            </div>
          ))}
          {currentLayout.tables.map((table) => {
            const status = getTableStatus(table.id);
            const color = STATUS_COLORS[status.status];
            const timeSeated = formatTime(status.occupiedSince);

            return (
              <div
                key={table.id}
                className={`table-card table-${table.shape} status-${status.status}`}
                style={{
                  gridColumn: `${table.gridX + 1} / span ${table.spanX}`,
                  gridRow: `${table.gridY + 1} / span ${table.spanY}`,
                }}
                onClick={() => handleTableClick(status)}
              >
                <div className="table-num-badge">{status.tableNumber}</div>
                <div className={`table-chip chip-${status.status}`}>
                  <span className="chip-dot" />
                  <span className="chip-text">
                    {status.status === 'empty'
                      ? t('floor.status_text.available', 'Available')
                      : status.status === 'occupied'
                      ? t('floor.status.occupied', 'Occupied')
                      : status.status === 'reserved'
                      ? t('floor.status.reserved', 'Reserved')
                      : t('floor.status.dirty', 'Dirty')}
                  </span>
                  {status.status === 'occupied' && timeSeated ? (
                    <span className="chip-sub">{timeSeated}</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!embedded && (
      <div className="live-view-footer">
        <div className="status-legend">
          <h3>{t('live.status_legend', 'Status Legend')}</h3>
          <div className="legend-items">
            {Object.entries(STATUS_COLORS).map(([status, color]) => (
              <div key={status} className="legend-item">
                <span
                  className="legend-color"
                  style={{ backgroundColor: color, opacity: status === 'empty' ? 0.6 : 1 }}
                />
                <span>{STATUS_LABELS[status as keyof typeof STATUS_LABELS]}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="stats-panel">
        <div className="stat">
          <span className="label">{t('live.stats.total_tables', 'Total Tables:')}</span>
          <span className="value">{currentLayout.tables.length}</span>
        </div>
        <div className="stat">
          <span className="label">{t('live.stats.occupied', 'Occupied:')}</span>
          <span className="value" style={{ color: STATUS_COLORS.occupied }}>
            {Array.from(tableStatuses.values()).filter(ts => ts.status === 'occupied').length}
          </span>
        </div>
        <div className="stat">
          <span className="label">{t('live.stats.empty', 'Empty:')}</span>
          <span className="value" style={{ color: STATUS_COLORS.empty }}>
            {Array.from(tableStatuses.values()).filter(ts => ts.status === 'empty').length}
          </span>
        </div>
        <div className="stat">
          <span className="label">{t('live.stats.occupancy', 'Occupancy:')}</span>
          <span className="value">
            {currentLayout.tables.length > 0 ? Math.round(
              (Array.from(tableStatuses.values()).filter(ts => ts.status === 'occupied').length /
                currentLayout.tables.length) *
                100
            ) : 0}%
          </span>
        </div>
        </div>
      </div>
      )}

      {selectedTable && (
        <TableContextMenu
          table={selectedTable}
          restaurantId={restaurantId}
          isOpen={isMenuOpen}
          onClose={() => setIsMenuOpen(false)}
          onStatusChange={handleStatusChange}
        />
      )}
    </div>
  );
}
