import { useState, useEffect, useRef } from 'react';
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
  type: 'wall' | 'door' | 'bar' | 'plant' | 'divider' | 'chair' | 'cyclic_partition';
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

export default function RestaurantLiveView({ restaurantId }: RestaurantLiveViewProps) {
  const [layouts, setLayouts] = useState<FloorLayout[]>([]);
  const [currentLayout, setCurrentLayout] = useState<FloorLayout | null>(null);
  const [tableStatuses, setTableStatuses] = useState<Map<string, TableStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(5000); // 5 seconds
  const [selectedTable, setSelectedTable] = useState<TableStatus | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);


  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);


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

  // Space = pan in live view as well
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);


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
    <div className="restaurant-live-view">
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

      <div className={`live-view-container ${isPanning ? "is-panning" : ""}`} ref={canvasRef} onWheel={onCanvasWheel} onMouseDown={onCanvasMouseDown}>
        
        <div className="fe-canvas-controls live">
          <button className="btn-icon-small" onClick={() => zoomAtPoint(clampZoom(zoom * 1.1), (canvasRef.current?.getBoundingClientRect().left || 0) + 40, (canvasRef.current?.getBoundingClientRect().top || 0) + 40)} title="Zoom in">＋</button>
          <button className="btn-icon-small" onClick={() => zoomAtPoint(clampZoom(zoom * 0.9), (canvasRef.current?.getBoundingClientRect().left || 0) + 40, (canvasRef.current?.getBoundingClientRect().top || 0) + 40)} title="Zoom out">－</button>
          <button className="btn-icon-small" onClick={fitToScreen} title="Fit to screen">⤢</button>
          <div className="fe-zoom-readout">{Math.round(zoom * 100)}%</div>
          <div className="fe-hint">{spacePressed ? 'Pan: drag' : 'Tip: hold Space to pan, Ctrl+wheel to zoom'}</div>
        </div>
<div className="floor-grid" style={{
          gridTemplateColumns: `repeat(${currentLayout.gridCols}, 72px)`,
          gridTemplateRows: `repeat(${currentLayout.gridRows}, 72px)`,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0'
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

            
  const clampZoom = (z: number) => Math.max(0.4, Math.min(2.5, z));

  const fitToScreen = () => {
    if (!canvasRef.current || !currentLayout) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const cellPx = 72; // live view uses a bit larger cells
    const gridW = (currentLayout.gridCols * cellPx) + 32;
    const gridH = (currentLayout.gridRows * cellPx) + 32;
    const scale = clampZoom(Math.min((rect.width - 40) / gridW, (rect.height - 40) / gridH, 1.2));
    setZoom(scale);
    setPan({ x: Math.round((rect.width - gridW * scale) / 2), y: 20 });
  };

  const zoomAtPoint = (nextZoom: number, clientX: number, clientY: number) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ox = clientX - rect.left;
    const oy = clientY - rect.top;

    setPan((p) => {
      const dz = nextZoom / zoom;
      return { x: Math.round(ox - (ox - p.x) * dz), y: Math.round(oy - (oy - p.y) * dz) };
    });
    setZoom(nextZoom);
  };

  const onCanvasWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || (e as any).metaKey)) return;
    e.preventDefault();
    const next = clampZoom(zoom * (e.deltaY > 0 ? 0.9 : 1.1));
    zoomAtPoint(next, e.clientX, e.clientY);
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const isMiddle = e.button === 1;
    const isSpaceLeft = spacePressed && e.button === 0;
    if (!isMiddle && !isSpaceLeft) return;

    e.preventDefault();
    setIsPanning(true);
    const start = { x: e.clientX, y: e.clientY };
    const startPan = { ...pan };

    const onMove = (ev: MouseEvent) => {
      setPan({ x: startPan.x + (ev.clientX - start.x), y: startPan.y + (ev.clientY - start.y) });
    };
    const onUp = () => {
      setIsPanning(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

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
                    <span>{t('floor.status.reserved', 'Reserved')}</span>
                  </div>
                )}

                {status.status === 'dirty' && (
                  <div className="table-info">
                    <span>🧹 {t('floor.status_text.dirty', 'Needs cleaning')}</span>
                  </div>
                )}

                {status.status === 'empty' && (
                  <div className="table-info">
                    <span>{t('floor.status_text.available', 'Available')}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

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
