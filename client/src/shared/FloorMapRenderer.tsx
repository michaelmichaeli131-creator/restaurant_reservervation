import { useEffect, useMemo, useRef, useState } from 'react';
import '../components/FloorEditor.css';

export interface FloorTableLike {
  id: string;
  tableNumber?: number;
  name?: string;
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  seats?: number;
  shape?: string;
  assetFile?: string;
  scale?: number;
  rotationDeg?: number;
  rotation?: number;
  sectionId?: string;
}

export interface FloorObjectLike {
  id: string;
  type: string;
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  label?: string;
  assetFile?: string;
  scale?: number;
  rotationDeg?: number;
  rotation?: number;
  kind?: 'object' | 'visualOnly';
}

export interface FloorLayoutLike {
  id: string;
  restaurantId?: string;
  name?: string;
  gridRows: number;
  gridCols: number;
  gridMask?: number[];
  floorColor?: string;
  tables: FloorTableLike[];
  objects?: FloorObjectLike[];
  // Optional live statuses (used by waiter/host view). Shape mirrors legacy sb_floor_map.js.
  tableStatuses?: Array<{
    tableId?: string;
    tableNumber?: number;
    status?: string;
    guestName?: string | null;
    guestCount?: number | string | null;
    orderId?: string | null;
  }>;
  isActive?: boolean;
}

type FloorThemeKey = 'parquet_blue' | 'parquet_brown' | 'slate_dark' | 'navy_carpet' | 'teal_terrazzo';

const ASSET_BASE = '/floor_assets/';

const getItemScale = (v?: number, fallback = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.5, Math.min(1.6, n));
};

const getItemRotation = (deg?: number) => {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 45) * 45;
};

const normalizeTheme = (v?: string): FloorThemeKey => {
  if (!v) return 'parquet_blue';
  if (v.startsWith('#')) return 'parquet_blue';
  const k = v as FloorThemeKey;
  if (k === 'parquet_blue' || k === 'parquet_brown' || k === 'slate_dark' || k === 'navy_carpet' || k === 'teal_terrazzo') return k;
  return 'parquet_blue';
};

function getTheme(key: FloorThemeKey) {
  // Keep identical asset/background approach as FloorEditor.
  const themes = {
    parquet_blue: { bg: `url(${ASSET_BASE}floor_parquet_blue.svg)`, size: '240px 240px', repeat: 'repeat', pos: 'center' },
    parquet_brown: { bg: `url(${ASSET_BASE}floor_parquet_brown.svg)`, size: '240px 240px', repeat: 'repeat', pos: 'center' },
    slate_dark: { bg: `url(${ASSET_BASE}floor_slate_dark.svg)`, size: '240px 240px', repeat: 'repeat', pos: 'center' },
    navy_carpet: { bg: `url(${ASSET_BASE}floor_navy_carpet.svg)`, size: '240px 240px', repeat: 'repeat', pos: 'center' },
    teal_terrazzo: { bg: `url(${ASSET_BASE}floor_teal_terrazzo.svg)`, size: '240px 240px', repeat: 'repeat', pos: 'center' },
  } as const;
  return themes[key];
}

// Minimal fallbacks (only used if assetFile is missing)
function assetForTable(shape?: string, seats?: number): string {
  const s = String(shape || 'square').toLowerCase();
  const n = Number(seats || 0);
  if (s === 'round') return `${ASSET_BASE}${n >= 9 ? 'round_table_10.svg' : 'round_table4.svg'}`;
  if (s === 'booth') return `${ASSET_BASE}${n >= 6 ? 'large_booth.svg' : 'booth4.svg'}`;
  if (s === 'rect') return `${ASSET_BASE}${n >= 10 ? 'square_table10.svg' : n >= 6 ? 'square_table6.svg' : n >= 4 ? 'square_table4.svg' : 'square_table2.svg'}`;
  // square
  return `${ASSET_BASE}${n >= 10 ? 'square_table10.svg' : n >= 6 ? 'square_table6.svg' : n >= 4 ? 'square_table4.svg' : 'square_table2.svg'}`;
}

function assetForObject(type?: string, label?: string): string {
  const t = String(type || '').toLowerCase();
  if (t === 'door') return `${ASSET_BASE}door.svg`;
  if (t === 'wall') return `${ASSET_BASE}wall.svg`;
  if (t === 'divider') return `${ASSET_BASE}divider.svg`;
  if (t === 'chair') return `${ASSET_BASE}chair.svg`;
  if (t === 'bar') return `${ASSET_BASE}bar.svg`;
  if (t === 'plant') return `${ASSET_BASE}plant.svg`;
  // visual fallback
  if (label) return `${ASSET_BASE}${label}.svg`;
  return `${ASSET_BASE}divider.svg`;
}

export default function FloorMapRenderer({
  layout,
  mode,
  onTableClick,
  selectedTableId,
  selectedTableIds,
}: {
  layout: FloorLayoutLike;
  mode: 'view' | 'edit';
  onTableClick?: (tableId: string) => void;
  selectedTableId?: string | null;
  selectedTableIds?: string[] | null;
}) {
  const allowZoom = mode === 'edit';
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  // Refs used by a non-passive wheel listener (prevents React passive warnings for preventDefault)
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Track if the user dragged to pan (so we can swallow a click on tables/objects after dragging)
  const dragRef = useRef<{ moved: boolean } | null>(null);

  // Keep the editor defaults for now, to match its look.
  const cellSize = 60;
  const padPx = 10;

  const themeKey = useMemo(() => normalizeTheme((layout as any).floorColor), [layout?.id]);
  const theme = useMemo(() => getTheme(themeKey), [themeKey]);

  // Space-to-pan (same behavior as editor/live view)
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

  const clampZoom = (z: number) => Math.max(0.4, Math.min(2.5, z));

  const fitToScreen = () => {
    if (!canvasRef.current || !gridRef.current) return;

    const canvas = canvasRef.current;
    const grid = gridRef.current;

    // Measure the real rendered grid size (offsetWidth/offsetHeight are not affected by CSS transforms).
    const cs = getComputedStyle(grid);
    const marginX = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
    const marginY = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);

    const baseW = grid.offsetWidth + marginX;
    const baseH = grid.offsetHeight + marginY;
    if (!baseW || !baseH) return;

    // Account for canvas padding so the map is truly centered.
    const csCanvas = getComputedStyle(canvas);
    const padL = parseFloat(csCanvas.paddingLeft || '0') || 0;
    const padR = parseFloat(csCanvas.paddingRight || '0') || 0;
    const padT = parseFloat(csCanvas.paddingTop || '0') || 0;
    const padB = parseFloat(csCanvas.paddingBottom || '0') || 0;

    const inset = 24;
    const availW = Math.max(1, canvas.clientWidth - padL - padR - inset * 2);
    const availH = Math.max(1, canvas.clientHeight - padT - padB - inset * 2);

    const scale = clampZoom(Math.min(availW / baseW, availH / baseH, 1.2));
    setZoom(scale);

    const cx = Math.round(padL + inset + (availW - baseW * scale) / 2);
    const cy = Math.round(padT + inset + (availH - baseH * scale) / 2);
    setPan({ x: cx, y: cy });
  };

  useEffect(() => {
    // Fit once after first render
    requestAnimationFrame(fitToScreen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout?.id]);

  useEffect(() => {
    // Refit when the canvas resizes (responsive layout, drawer opening, etc.)
    if (!canvasRef.current) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitToScreen);
    });
    ro.observe(canvasRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout?.id]);

  const zoomAtPoint = (nextZoom: number, clientX: number, clientY: number) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ox = clientX - rect.left;
    const oy = clientY - rect.top;
    setPan((p) => {
      const dz = nextZoom / (zoomRef.current || 1);
      return { x: Math.round(ox - (ox - p.x) * dz), y: Math.round(oy - (oy - p.y) * dz) };
    });
    setZoom(nextZoom);
  };

  // Non-passive wheel handler (blocks browser zoom; enables internal zoom only in edit mode)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const isZoomGesture = !!(e.ctrlKey || (e as any).metaKey);
      if (!isZoomGesture) return;

      // Always block browser zoom on ctrl/cmd+wheel
      e.preventDefault();

      // View mode: no manual zoom
      if (!allowZoom) return;

      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const next = clampZoom((zoomRef.current || 1) * factor);
      zoomAtPoint(next, e.clientX, e.clientY);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel as any);
  }, [allowZoom]);

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;

    // View mode: allow grab-to-pan with left mouse on empty canvas (no Space required)
    if (mode === 'view') {
      if (e.button !== 0) return;
      // Don't pan when interacting with zoom controls/inputs.
      if (target?.closest('.fe-canvas-controls, button, a, input, textarea, select')) return;
      e.preventDefault();

      dragRef.current = { moved: false };
      const start = { x: e.clientX, y: e.clientY };
      const startPan = { ...pan };

      let activated = false;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        const dist = Math.abs(dx) + Math.abs(dy);

        if (!activated && dist > 4) {
          activated = true;
          if (dragRef.current) dragRef.current.moved = true;
          setIsPanning(true);
        }

        if (activated) {
          setPan({ x: startPan.x + dx, y: startPan.y + dy });
        }
      };
      const onUp = () => {
        if (activated) setIsPanning(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);

        // If it was just a click (no drag), clear the flag immediately.
        if (dragRef.current && !dragRef.current.moved) dragRef.current = null;
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return;
    }

    // Edit mode: Space-to-pan or middle mouse
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

  const touchPanRef = useRef<{ startX: number; startY: number; panX: number; panY: number; active: boolean } | null>(null);

  const onCanvasTouchStart = (e: React.TouchEvent) => {
    if (mode !== 'view') return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const target = e.target as HTMLElement | null;
    if (target?.closest('.table, .floor-object, .fe-canvas-controls, button, a, input, textarea, select')) return;
    e.preventDefault();
    setIsPanning(true);
    touchPanRef.current = { startX: t.clientX, startY: t.clientY, panX: pan.x, panY: pan.y, active: true };
  };

  const onCanvasTouchMove = (e: React.TouchEvent) => {
    if (mode !== 'view') return;
    const s = touchPanRef.current;
    if (!s || !s.active) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    e.preventDefault();
    setPan({ x: s.panX + (t.clientX - s.startX), y: s.panY + (t.clientY - s.startY) });
  };

  const onCanvasTouchEnd = () => {
    if (mode !== 'view') return;
    touchPanRef.current = null;
    setIsPanning(false);
  };

  const spanToPx = (span: number) => Math.max(1, Number(span) || 1) * cellSize;

  
  const normalizeTableStatus = (raw: string): 'empty' | 'occupied' | 'reserved' | 'dirty' => {
    const v = (raw || '').toLowerCase();
    if (v.includes('occup') || v === 'busy' || v === 'taken') return 'occupied';
    if (v.includes('reserv') || v.includes('book')) return 'reserved';
    if (v.includes('dirty') || v.includes('need')) return 'dirty';
    return 'empty';
  };


  const statusByTableId = useMemo(() => {
    const m = new Map<string, { status: string; guestName?: string | null; guestCount?: any; orderId?: string | null }>();
    (Array.isArray((layout as any).tableStatuses) ? (layout as any).tableStatuses : []).forEach((s: any) => {
      const tid = s && s.tableId ? String(s.tableId) : '';
      if (!tid) return;
      m.set(tid, {
        status: normalizeTableStatus(String(s.status || 'empty')),
        guestName: s.guestName ?? null,
        guestCount: s.guestCount ?? null,
        orderId: s.orderId ?? null,
      });
    });
    return m;
  }, [layout]);

  const statusByTableNumber = useMemo(() => {
    const m = new Map<number, { status: string; guestName?: string | null; guestCount?: any; orderId?: string | null }>();
    (Array.isArray((layout as any).tableStatuses) ? (layout as any).tableStatuses : []).forEach((s: any) => {
      const tn = Number(s && (s.tableNumber ?? 0));
      if (!Number.isFinite(tn) || tn <= 0) return;
      m.set(tn, {
        status: normalizeTableStatus(String(s.status || 'empty')),
        guestName: s.guestName ?? null,
        guestCount: s.guestCount ?? null,
        orderId: s.orderId ?? null,
      });
    });
    return m;
  }, [layout]);

  const getStatusFor = (t: FloorTableLike) => {
    const byId = t.id ? statusByTableId.get(String(t.id)) : undefined;
    if (byId) return byId;
    const tn = Number(t.tableNumber ?? 0);
    if (Number.isFinite(tn) && tn > 0) {
      const byNum = statusByTableNumber.get(tn);
      if (byNum) return byNum;
    }
    return { status: 'empty' };
  };

  return (
    <div
      className={`editor-canvas ${isPanning ? 'is-panning' : ''}`}
      ref={canvasRef}
      onMouseDown={onCanvasMouseDown}
      onTouchStart={onCanvasTouchStart}
      onTouchMove={onCanvasTouchMove}
      onTouchEnd={onCanvasTouchEnd}
      style={{ position: 'relative' }}
    >
      <div className="fe-canvas-controls">
        {allowZoom ? (
          <>
            <button
              className="btn-icon-small"
              onClick={() => {
                const rect = canvasRef.current?.getBoundingClientRect();
                zoomAtPoint(clampZoom(zoom * 1.1), (rect?.left || 0) + 40, (rect?.top || 0) + 40);
              }}
              title="Zoom in"
            >
              ＋
            </button>
            <button
              className="btn-icon-small"
              onClick={() => {
                const rect = canvasRef.current?.getBoundingClientRect();
                zoomAtPoint(clampZoom(zoom * 0.9), (rect?.left || 0) + 40, (rect?.top || 0) + 40);
              }}
              title="Zoom out"
            >
              －
            </button>
          </>
        ) : null}
        <button className="btn-icon-small" onClick={fitToScreen} title="Center">
          ⤢
        </button>
        {allowZoom ? <div className="fe-zoom-readout">{Math.round(zoom * 100)}%</div> : null}
        <div className="fe-hint">
          {mode === 'view' ? 'Drag to pan' : spacePressed ? 'Pan: drag' : 'Tip: hold Space to pan, Ctrl+wheel to zoom'}
        </div>
      </div>

      <div
        className="fe-grid"
        ref={gridRef}
        onClickCapture={(e) => {
          // If the user dragged to pan, swallow the click so a table click doesn't open the drawer.
          if (mode !== 'view') return;
          if (dragRef.current?.moved) {
            e.preventDefault();
            e.stopPropagation();
            dragRef.current = null;
          }
        }}
        style={{
          direction: 'ltr',
          gridTemplateColumns: `repeat(${layout.gridCols}, ${cellSize}px)`,
          gridTemplateRows: `repeat(${layout.gridRows}, ${cellSize}px)`,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          ['--cell' as any]: `${cellSize}px`,
          ['--floor-bg' as any]: theme.bg,
          ['--floor-bg-size' as any]: theme.size,
          ['--floor-bg-repeat' as any]: theme.repeat,
          ['--floor-bg-position' as any]: theme.pos,
        }}
      >
        {Array.from({ length: layout.gridRows * layout.gridCols }).map((_, i) => {
          const gridY = Math.floor(i / layout.gridCols);
          const gridX = i % layout.gridCols;

          const tableHere = layout.tables.find((t) => (
            gridX >= t.gridX && gridX < t.gridX + (t.spanX || 1) &&
            gridY >= t.gridY && gridY < t.gridY + (t.spanY || 1)
          ));

          const objects = layout.objects ?? [];
          const objectHere = objects.find((o) => (
            gridX >= o.gridX && gridX < o.gridX + (o.spanX || 1) &&
            gridY >= o.gridY && gridY < o.gridY + (o.spanY || 1)
          ));

          const isTopLeft = !!tableHere && tableHere.gridX === gridX && tableHere.gridY === gridY;
          const isObjTopLeft = !!objectHere && objectHere.gridX === gridX && objectHere.gridY === gridY;

          const idx = gridY * layout.gridCols + gridX;
          const active = (layout.gridMask?.[idx] ?? 1) === 1;

          return (
            <div
              key={i}
              className={`fe-grid-cell ${active ? 'active' : 'inactive'}`}
            >
              {isObjTopLeft && objectHere && (
                <div
                  className={`floor-object type-${objectHere.type}`}
                  style={{
                    width: `${spanToPx(objectHere.spanX)}px`,
                    height: `${spanToPx(objectHere.spanY)}px`,
                    transform: `rotate(${getItemRotation((objectHere as any).rotationDeg ?? objectHere.rotation ?? 0)}deg)`,
                    cursor: mode === 'view' ? 'default' : 'grab',
                  }}
                >
                  <img
                    className={`fe-asset fe-asset--${(objectHere.assetFile || '').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`}
                    style={{ transform: `scale(${getItemScale((objectHere as any).scale, 1)})` }}
                    src={objectHere.assetFile ? `${ASSET_BASE}${objectHere.assetFile}` : assetForObject(objectHere.type, objectHere.label)}
                    alt=""
                  />
                  {objectHere.label && <div className="obj-label">{objectHere.label}</div>}
                </div>
              )}

              {isTopLeft && tableHere && (() => {
                const st = getStatusFor(tableHere);
                const status = String(st.status || 'empty');
                const selected =
                  (selectedTableId && String(selectedTableId) === String(tableHere.id)) ||
                  (Array.isArray(selectedTableIds) &&
                    selectedTableIds.some((x) => String(x) === String(tableHere.id)));
                const showPill = mode === 'view';
                const pillText = (() => {
                  if (status === 'occupied') return 'תפוס';
                  if (status === 'reserved') return 'שמור';
                  if (status === 'dirty') return 'מלוכלך';
                  return 'פנוי';
                })();
                const count = st.guestCount != null && st.guestCount !== '' ? ` · ${st.guestCount}` : '';
                return (
                  <div
                    className={`table ${String(tableHere.shape || 'square')} ${selected ? 'selected' : ''}`}
                    onClick={() => onTableClick?.(tableHere.id)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: `${spanToPx(tableHere.spanX)}px`,
                      height: `${spanToPx(tableHere.spanY)}px`,
                      cursor: mode === 'view' ? 'pointer' : 'default',
                    }}
                  >
                    <div className="fe-table-visual" data-asset={tableHere.assetFile || ''}>
                      <img
                        className={`fe-asset fe-asset--${(tableHere.assetFile || '').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`}
                        style={{
                          transform: `rotate(${getItemRotation((tableHere as any).rotationDeg ?? tableHere.rotation ?? 0)}deg) scale(${getItemScale((tableHere as any).scale, 1)})`,
                        }}
                        src={tableHere.assetFile ? `${ASSET_BASE}${tableHere.assetFile}` : assetForTable(tableHere.shape, tableHere.seats)}
                        alt=""
                      />
                    </div>
                    <div className="fe-table-overlay">
                      <div className="table-label">{tableHere.name || (tableHere.tableNumber != null ? `Table ${tableHere.tableNumber}` : 'Table')}</div>
                      {tableHere.seats != null && <div className="table-seats">{tableHere.seats} seats</div>}
                    </div>
                    {showPill && (
                      <div className={`sbv-status-pill is-${status}`}>
                        <span className="sbv-dot" />
                        <span className="sbv-status-text">{pillText}{count}</span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
