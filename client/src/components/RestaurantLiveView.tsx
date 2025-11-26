import { useState, useEffect } from 'react';
import './RestaurantLiveView.css';
import TableContextMenu from './TableContextMenu';

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

interface FloorPlan {
  id: string;
  name: string;
  gridRows: number;
  gridCols: number;
  tables: FloorTable[];
  tableStatuses?: TableStatus[];
}

interface RestaurantLiveViewProps {
  restaurantId: string;
}

const STATUS_COLORS = {
  empty: '#4CAF50',        // Green
  occupied: '#FF6B6B',     // Red
  reserved: '#FFC107',     // Orange
  dirty: '#9C27B0',        // Purple
};

const STATUS_LABELS = {
  empty: 'Empty',
  occupied: 'Occupied',
  reserved: 'Reserved',
  dirty: 'Dirty',
};

export default function RestaurantLiveView({ restaurantId }: RestaurantLiveViewProps) {
  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null);
  const [tableStatuses, setTableStatuses] = useState<Map<string, TableStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5000); // 5 seconds
  const [selectedTable, setSelectedTable] = useState<TableStatus | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Load floor plan and initial table statuses
  useEffect(() => {
    const loadFloorPlan = async () => {
      try {
        const res = await fetch(`/api/floor-plans/${restaurantId}`);
        if (res.ok) {
          const plan: FloorPlan = await res.json();
          setFloorPlan(plan);

          // Initialize table statuses
          if (plan.tableStatuses) {
            const statusMap = new Map();
            plan.tableStatuses.forEach(ts => {
              statusMap.set(ts.tableId, ts);
            });
            setTableStatuses(statusMap);
          }
        }
      } catch (err) {
        console.error('Failed to load floor plan:', err);
      } finally {
        setLoading(false);
      }
    };

    loadFloorPlan();
  }, [restaurantId]);

  // Auto-refresh table statuses
  useEffect(() => {
    if (!autoRefresh || !floorPlan) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/floor-plans/${restaurantId}`);
        if (res.ok) {
          const plan: FloorPlan = await res.json();
          if (plan.tableStatuses) {
            const statusMap = new Map();
            plan.tableStatuses.forEach(ts => {
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
  }, [restaurantId, autoRefresh, refreshInterval, floorPlan]);

  if (loading) {
    return <div className="live-view-loading">Loading floor plan...</div>;
  }

  if (!floorPlan) {
    return (
      <div className="live-view-error">
        <p>Floor plan not found. Please set up your floor plan first.</p>
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
    // Update the local state with the new status
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

  return (
    <div className="restaurant-live-view">
      <div className="live-view-header">
        <h1>🔴 Live Floor View - {floorPlan.name}</h1>
        <div className="control-panel">
          <label>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            disabled={!autoRefresh}
          >
            <option value={3000}>3 seconds</option>
            <option value={5000}>5 seconds</option>
            <option value={10000}>10 seconds</option>
            <option value={15000}>15 seconds</option>
          </select>
          <button onClick={() => {
            const res = fetch(`/api/floor-plans/${restaurantId}`);
            res.then(r => r.json()).then(plan => {
              if (plan.tableStatuses) {
                const statusMap = new Map();
                plan.tableStatuses.forEach((ts: TableStatus) => {
                  statusMap.set(ts.tableId, ts);
                });
                setTableStatuses(statusMap);
              }
            });
          }}>
            🔄 Refresh Now
          </button>
        </div>
      </div>

      <div className="live-view-container">
        <div className="floor-grid" style={{
          gridTemplateColumns: `repeat(${floorPlan.gridCols}, 1fr)`,
          gridTemplateRows: `repeat(${floorPlan.gridRows}, 1fr)`,
        }}>
          {floorPlan.tables.map((table) => {
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
                  backgroundColor: color,
                  opacity: status.status === 'empty' ? 0.6 : 1,
                  cursor: 'pointer',
                }}
                onClick={() => handleTableClick(status)}
              >
                <div className="table-number">{status.tableNumber}</div>

                {status.status === 'occupied' && (
                  <>
                    <div className="table-info">
                      <span className="guests">👥 {status.guestCount || '-'}</span>
                      <span className="seated">{timeSeated}</span>
                    </div>
                    <div className="order-summary">
                      {status.itemsPending ? (
                        <span className="pending">⏳ {status.itemsPending}</span>
                      ) : null}
                      {status.itemsReady ? (
                        <span className="ready">✅ {status.itemsReady}</span>
                      ) : null}
                      {status.orderTotal ? (
                        <span className="total">{formatPrice(status.orderTotal)}</span>
                      ) : null}
                    </div>
                  </>
                )}

                {status.status === 'reserved' && (
                  <div className="table-info">
                    <span>Reserved</span>
                  </div>
                )}

                {status.status === 'dirty' && (
                  <div className="table-info">
                    <span>🧹 Needs cleaning</span>
                  </div>
                )}

                {status.status === 'empty' && (
                  <div className="table-info">
                    <span>Available</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="live-view-footer">
        <div className="status-legend">
          <h3>Status Legend</h3>
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
          <span className="label">Total Tables:</span>
          <span className="value">{floorPlan.tables.length}</span>
        </div>
        <div className="stat">
          <span className="label">Occupied:</span>
          <span className="value" style={{ color: STATUS_COLORS.occupied }}>
            {Array.from(tableStatuses.values()).filter(ts => ts.status === 'occupied').length}
          </span>
        </div>
        <div className="stat">
          <span className="label">Empty:</span>
          <span className="value" style={{ color: STATUS_COLORS.empty }}>
            {Array.from(tableStatuses.values()).filter(ts => ts.status === 'empty').length}
          </span>
        </div>
        <div className="stat">
          <span className="label">Occupancy:</span>
          <span className="value">
            {Math.round(
              (Array.from(tableStatuses.values()).filter(ts => ts.status === 'occupied').length /
                floorPlan.tables.length) *
                100
            )}%
          </span>
        </div>
        </div>
      </div>

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
