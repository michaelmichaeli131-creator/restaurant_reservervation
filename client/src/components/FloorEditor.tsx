import { useState, useEffect, useRef } from 'react';
import './FloorEditor.css';
import { t } from '../i18n';

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
  createdAt: number;
  updatedAt: number;
}

interface FloorSection {
  id: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  displayOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface FloorEditorProps {
  restaurantId: string;
}

export default function FloorEditor({ restaurantId }: FloorEditorProps) {
  const [layouts, setLayouts] = useState<FloorLayout[]>([]);
  const [currentLayout, setCurrentLayout] = useState<FloorLayout | null>(null);
  const [sections, setSections] = useState<FloorSection[]>([]);
  const [activeSection, setActiveSection] = useState<FloorSection | null>(null);

  const [selectedTable, setSelectedTable] = useState<FloorTable | null>(null);
  const [selectedObject, setSelectedObject] = useState<FloorObject | null>(null);
  const [draggedItem, setDraggedItem] = useState<{
    kind: 'table' | 'object';
    mode: 'new' | 'existing';

    // tables
    shape?: string; // 'square' | 'round' | 'booth' | 'rect'
    seats?: number;

    // objects
    objectType?: FloorObject['type'];
    spanX?: number;
    spanY?: number;
    rotation?: 0 | 90 | 180 | 270;
    label?: string;

    // existing IDs
    tableId?: string;
    objectId?: string;
  } | null>(null);
  const [nextTableNumber, setNextTableNumber] = useState(1);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');
  const [showOnlyActiveSection, setShowOnlyActiveSection] = useState(false);
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false); 

  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Vite serves files from /public at the app base URL.
  // Using BASE_URL keeps it working if the app is hosted under a sub-path.
  const ASSET_BASE = `${import.meta.env.BASE_URL}floor_assets/`;
  const CELL_PX = 60;
  const GRID_PAD_PX = 10;

  const tableSpanBySeats = (seats: number) => {
    const n = Number(seats || 0);
    if (n <= 2) return { spanX: 2, spanY: 1 };       // 2 squares
    if (n <= 4) return { spanX: 2, spanY: 2 };       // 4 squares
    if (n <= 6) return { spanX: 3, spanY: 2 };       // 6 squares
    if (n <= 8) return { spanX: 4, spanY: 2 };       // 8 squares
    return { spanX: 5, spanY: 2 };                   // 10 squares
  };

  const boothSpanBySeats = (seats: number) => {
    const n = Number(seats || 0);
    if (n <= 2) return { spanX: 2, spanY: 1 };
    // 4-seat booth = 4 squares in a row (nice visually)
    return { spanX: 4, spanY: 1 };
  };

  const defaultSpanForNewTable = (shape: string, seats: number) => {
    const s = String(shape || 'square').toLowerCase();
    if (s === 'booth') return boothSpanBySeats(seats);
    return tableSpanBySeats(seats);
  };

  const defaultSpanForNewObject = (type: FloorObject['type']) => {
    switch (type) {
      case 'chair': return { spanX: 1, spanY: 1 };
      case 'door': return { spanX: 1, spanY: 1 };
      case 'bar': return { spanX: 5, spanY: 1 }; // 5 squares
      case 'cyclic_partition': return { spanX: 2, spanY: 2 };
      case 'divider': return { spanX: 2, spanY: 1 };
      case 'wall': return { spanX: 4, spanY: 1 };
      case 'plant': return { spanX: 1, spanY: 1 };
      default: return { spanX: 1, spanY: 1 };
    }
  };

  const scaleForTable = (shape: string, seats: number) => {
    const s = String(shape || 'rect').toLowerCase();
    const n = Number(seats || 0);
    if (s === 'booth') return n <= 4 ? 1.15 : 1.35;
    if (n <= 2) return 0.75;
    if (n <= 4) return 1.0;
    if (n <= 6) return 1.5;
    if (n <= 8) return 1.75;
    return 2.0;
  };

  const scaleForObject = (type: string) => {
    const t = String(type || '').toLowerCase();
    if (t === 'bar') return 1.8;
    return 1.0;
  };

const assetForTable = (shape: string, seats: number) => {
    const s = String(shape || 'rect').toLowerCase();
    const n = Number(seats || 0);
    if (s === 'round') return n >= 9 ? `${ASSET_BASE}round_table_10.svg` : `${ASSET_BASE}round_table4.svg`;
    if (s === 'booth') return n >= 6 ? `${ASSET_BASE}large_booth.svg` : `${ASSET_BASE}booth4.svg`;
    const targets = [2, 4, 6, 8, 10];
    const nearest = targets.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), 4);
    return `${ASSET_BASE}square_table${nearest}.svg`;
  };


    const assetForObject = (type: FloorObject['type'], spanX: number, spanY: number) => {
      if (type === 'door') return `${ASSET_BASE}door.svg`;
      if (type === 'bar') return `${ASSET_BASE}bar.svg`;
      if (type === 'plant') return `${ASSET_BASE}plant.svg`;
      if (type === 'chair') return `${ASSET_BASE}chair.svg`;
      if (type === 'cyclic_partition') return `${ASSET_BASE}cyclic_partition.svg`;
      // wall/divider
      if ((spanX || 1) === 1 && (spanY || 1) === 1) return `${ASSET_BASE}corner_partitaion.svg`;
      if ((spanX || 1) > (spanY || 1)) return `${ASSET_BASE}horizintal_partitaion.svg`;
      return `${ASSET_BASE}vertical_partition.svg`;
    };


  // Load all layouts
  useEffect(() => {
    if (!restaurantId) return;

    fetch(`/api/floor-layouts/${restaurantId}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        setLayouts(data);
        const active = data.find((l: FloorLayout) => l.isActive);
        setCurrentLayout(active || data[0] || null);

        const allTables = data.flatMap((l: FloorLayout) => l.tables);
        const maxNum = Math.max(...allTables.map((t: FloorTable) => t.tableNumber), 0);
        setNextTableNumber(maxNum + 1);
      })
      .catch(err => console.error('Failed to load layouts:', err));

    fetch(`/api/floor-sections/${restaurantId}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        setSections(data);
        if (data.length > 0) {
          setActiveSection(data[0]);
        }
      })
      .catch(err => console.error('Failed to load sections:', err));
  }, [restaurantId]);

  // Canvas keyboard helpers (Space = pan)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(true);
      }
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


  const createNewLayout = async () => {
    if (!newLayoutName.trim()) {
      alert(t('floor.error.enter_name', 'Please enter a layout name'));
      return;
    }

    try {
      const response = await fetch(`/api/floor-layouts/${restaurantId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: newLayoutName,
          gridRows: 8,
          gridCols: 12,
          tables: [],
          objects: [],
          isActive: layouts.length === 0,
        })
      });

      if (response.ok) {
        const newLayout = await response.json();
        setLayouts([...layouts, newLayout]);
        setCurrentLayout(newLayout);
        setNewLayoutName('');
        setIsCreateModalOpen(false);
      } else {
        const errorData = await response.json().catch(() => null);
        const errorMsg = errorData?.error || t('floor.error.server', 'Server error: {status} {statusText}').replace('{status}', String(response.status)).replace('{statusText}', response.statusText);
        alert(t('floor.error.create', 'Error creating layout: {error}').replace('{error}', errorMsg));
      }
    } catch (err) {
      console.error('Create layout failed:', err);
      alert(t('floor.error.create', 'Error creating layout: {error}').replace('{error}', err instanceof Error ? err.message : String(err)));
    }
  };

  const deleteLayout = async (layoutId: string) => {
    if (!confirm(t('floor.confirm.delete_layout', 'Are you sure you want to delete this layout?'))) return;

    try {
      const response = await fetch(`/api/floor-layouts/${restaurantId}/${layoutId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.ok) {
        const updated = layouts.filter(l => l.id !== layoutId);
        setLayouts(updated);
        if (currentLayout?.id === layoutId) {
          setCurrentLayout(updated[0] || null);
        }
      } else {
        const data = await response.json();
        alert(data.error || t('floor.error.delete', 'Delete failed'));
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert(t('floor.error.delete_general', 'Error deleting layout'));
    }
  };

  const duplicateLayout = async (layoutId: string) => {
    const name = prompt(t('floor.prompt.duplicate_name', 'Enter name for duplicated layout:'));
    if (!name) return;

    try {
      const response = await fetch(`/api/floor-layouts/${restaurantId}/${layoutId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name })
      });

      if (response.ok) {
        const newLayout = await response.json();
        setLayouts([...layouts, newLayout]);
        setCurrentLayout(newLayout);
      } else {
        alert(t('floor.error.duplicate', 'Error duplicating layout'));
      }
    } catch (err) {
      console.error('Duplicate failed:', err);
      alert(t('floor.error.duplicate', 'Error duplicating layout'));
    }
  };

  const setActiveLayout = async (layoutId: string) => {
    try {
      const response = await fetch(`/api/floor-layouts/${restaurantId}/${layoutId}/activate`, {
        method: 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        setLayouts(layouts.map(l => ({
          ...l,
          isActive: l.id === layoutId
        })));
      }
    } catch (err) {
      console.error('Set active failed:', err);
    }
  };

  const handleDragStart = (
    e: React.DragEvent,
    kind: 'table' | 'object',
    mode: 'new' | 'existing',
    opts?: { shape?: string; seats?: number; objectType?: FloorObject['type']; spanX?: number; spanY?: number; rotation?: 0|90|180|270; label?: string; tableId?: string; objectId?: string }
  ) => {
    setDraggedItem({ kind, mode, ...opts });
    setHoverCell(null);
    e.dataTransfer.effectAllowed = 'move';
  };

  // ===== Smart snapping (Stage 5 polish) =====
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const clampToGrid = (x: number, y: number, spanX: number, spanY: number) => {
    if (!currentLayout) return { x, y };
    return {
      x: clamp(x, 0, Math.max(0, currentLayout.gridCols - spanX)),
      y: clamp(y, 0, Math.max(0, currentLayout.gridRows - spanY)),
    };
  };

  const snapToNearbyWalls = (x: number, y: number, spanX: number, spanY: number) => {
    if (!currentLayout) return { x, y };
    const objects = currentLayout.objects ?? [];
    const walls = objects.filter(o => o.type === 'wall' || o.type === 'divider');
    if (!walls.length) return { x, y };

    const want = { x, y };
    const candidates: { x: number; y: number; score: number }[] = [];

    // Helper: add candidate with Manhattan distance score
    const add = (cx: number, cy: number) => {
      const c = clampToGrid(cx, cy, spanX, spanY);
      const score = Math.abs(c.x - want.x) + Math.abs(c.y - want.y);
      candidates.push({ ...c, score });
    };

    // Snap to closest wall edge if overlapping in the perpendicular axis.
    walls.forEach(w => {
      const wx1 = w.gridX;
      const wy1 = w.gridY;
      const wx2 = w.gridX + (w.spanX || 1); // exclusive
      const wy2 = w.gridY + (w.spanY || 1);

      // If we overlap X-range, we can snap above/below the wall
      const overlapsX = (x + spanX) > wx1 && x < wx2;
      if (overlapsX) {
        add(x, wy1 - spanY); // above
        add(x, wy2);         // below
      }
      // If we overlap Y-range, we can snap left/right of the wall
      const overlapsY = (y + spanY) > wy1 && y < wy2;
      if (overlapsY) {
        add(wx1 - spanX, y); // left
        add(wx2, y);         // right
      }
    });

    if (!candidates.length) return { x, y };
    candidates.sort((a, b) => a.score - b.score);
    // Only snap if it's a small adjustment (keeps control in user's hands)
    if (candidates[0].score <= 1) return { x: candidates[0].x, y: candidates[0].y };
    return { x, y };
  };

  
  const clampZoom = (z: number) => Math.max(0.35, Math.min(2.5, z));

  const fitToScreen = () => {
    if (!canvasRef.current || !currentLayout) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const cellPx = 60;
    const gridW = (currentLayout.gridCols * cellPx) + 20; // grid padding
    const gridH = (currentLayout.gridRows * cellPx) + 20;

    const scale = clampZoom(Math.min((rect.width - 40) / gridW, (rect.height - 40) / gridH, 1.2));
    setZoom(scale);

    // center
    const panX = Math.round((rect.width - gridW * scale) / 2);
    const panY = Math.round(20);
    setPan({ x: panX, y: panY });
  };

  const zoomAtPoint = (nextZoom: number, clientX: number, clientY: number) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ox = clientX - rect.left;
    const oy = clientY - rect.top;

    setPan((p) => {
      const z = zoom;
      const dz = nextZoom / z;

      // keep the point under cursor stable: newPan = cursor - (cursor - pan) * dz
      const nx = Math.round(ox - (ox - p.x) * dz);
      const ny = Math.round(oy - (oy - p.y) * dz);
      return { x: nx, y: ny };
    });
    setZoom(nextZoom);
  };

  const onCanvasWheel = (e: React.WheelEvent) => {
    // Ctrl/Meta + wheel -> zoom. Otherwise let the browser scroll naturally.
    if (!(e.ctrlKey || (e as any).metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY;
    const next = clampZoom(zoom * (delta > 0 ? 0.9 : 1.1));
    zoomAtPoint(next, e.clientX, e.clientY);
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    // Middle mouse OR Space+Left mouse -> pan
    const isMiddle = e.button === 1;
    const isSpaceLeft = spacePressed && e.button === 0;
    if (!isMiddle && !isSpaceLeft) return;

    e.preventDefault();
    setIsPanning(true);
    const start = { x: e.clientX, y: e.clientY };
    const startPan = { ...pan };

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      setPan({ x: startPan.x + dx, y: startPan.y + dy });
    };
    const onUp = () => {
      setIsPanning(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };


  const computeAlignmentSnap = (
    x: number,
    y: number,
    spanX: number,
    spanY: number,
    exclude?: { kind: 'table' | 'object'; id?: string }
  ) => {
    if (!currentLayout) return { x, y, guides: { v: [] as number[], h: [] as number[] } };

    const others: Array<{ left: number; top: number; right: number; bottom: number; cx2: number; cy2: number }> = [];

    // Collect other items (tables + objects) in grid units
    for (const t of currentLayout.tables) {
      if (exclude?.kind === 'table' && exclude?.id && t.id === exclude.id) continue;
      others.push({
        left: t.gridX,
        top: t.gridY,
        right: t.gridX + (t.spanX || 1),
        bottom: t.gridY + (t.spanY || 1),
        cx2: (t.gridX * 2) + (t.spanX || 1),
        cy2: (t.gridY * 2) + (t.spanY || 1),
      });
    }
    for (const o of (currentLayout.objects ?? [])) {
      if (exclude?.kind === 'object' && exclude?.id && o.id === exclude.id) continue;
      others.push({
        left: o.gridX,
        top: o.gridY,
        right: o.gridX + (o.spanX || 1),
        bottom: o.gridY + (o.spanY || 1),
        cx2: (o.gridX * 2) + (o.spanX || 1),
        cy2: (o.gridY * 2) + (o.spanY || 1),
      });
    }

    const myLeft = x;
    const myTop = y;
    const myRight = x + spanX;
    const myBottom = y + spanY;
    const myCx2 = (x * 2) + spanX;
    const myCy2 = (y * 2) + spanY;

    // threshold in grid units (<= 1 cell)
    const thr = 1;

    let bestDx: number | null = null;
    let bestDy: number | null = null;
    const guides = { v: [] as number[], h: [] as number[] };

    const considerDx = (dx: number, guideX: number) => {
      if (Math.abs(dx) > thr) return;
      if (bestDx === null || Math.abs(dx) < Math.abs(bestDx)) {
        bestDx = dx;
        guides.v = [guideX];
      }
    };
    const considerDy = (dy: number, guideY: number) => {
      if (Math.abs(dy) > thr) return;
      if (bestDy === null || Math.abs(dy) < Math.abs(bestDy)) {
        bestDy = dy;
        guides.h = [guideY];
      }
    };

    for (const it of others) {
      // Left align
      considerDx(it.left - myLeft, it.left);
      // Right align
      considerDx(it.right - myRight, it.right);
      // Center align (only if integer shift possible)
      const dx2 = it.cx2 - myCx2; // in half-units
      if (dx2 % 2 === 0) considerDx(dx2 / 2, it.cx2 / 2);

      // Top align
      considerDy(it.top - myTop, it.top);
      // Bottom align
      considerDy(it.bottom - myBottom, it.bottom);
      const dy2 = it.cy2 - myCy2;
      if (dy2 % 2 === 0) considerDy(dy2 / 2, it.cy2 / 2);
    }

    return {
      x: bestDx !== null ? x + bestDx : x,
      y: bestDy !== null ? y + bestDy : y,
      guides,
    };
  };

  const computeSnap = (
    x: number,
    y: number,
    spanX: number,
    spanY: number,
    kind: 'table' | 'object',
    subtype?: string,
    disableSnap?: boolean,
    exclude?: { kind: 'table' | 'object'; id?: string }
  ) => {
    // Always clamp
    const base = clampToGrid(x, y, spanX, spanY);

    if (disableSnap) return { x: base.x, y: base.y, guides: { v: [] as number[], h: [] as number[] } };

    // For furniture that visually "wants" to hug a wall (booth / bar / door), snap to nearby walls.
    const wantsWallSnap =
      (kind === 'table' && String(subtype).toLowerCase() === 'booth') ||
      (kind === 'object' && (subtype === 'bar' || subtype === 'door'));

    const wallSnapped = wantsWallSnap ? snapToNearbyWalls(base.x, base.y, spanX, spanY) : base;

    // Alignment snap to other items
    const aligned = computeAlignmentSnap(wallSnapped.x, wallSnapped.y, spanX, spanY, exclude);

    // Clamp again after alignment
    const clamped = clampToGrid(aligned.x, aligned.y, spanX, spanY);
    return { x: clamped.x, y: clamped.y, guides: aligned.guides };
  };

const snapPlacement = (x: number, y: number, spanX: number, spanY: number, kind: 'table' | 'object', subtype?: string, disableSnap?: boolean, exclude?: { kind: 'table' | 'object'; id?: string }) => {
    return computeSnap(x, y, spanX, spanY, kind, subtype, disableSnap, exclude);
  };

  const clientPointToGridCell = (clientX: number, clientY: number) => {
    if (!currentLayout) return null;
    // Use the transformed grid's bounding box so zoom/pan works reliably.
    const gridEl = document.querySelector('.grid') as HTMLDivElement | null;
    if (!gridEl) return null;

    const rect = gridEl.getBoundingClientRect();
    const xPx = (clientX - rect.left) / zoom - GRID_PAD_PX;
    const yPx = (clientY - rect.top) / zoom - GRID_PAD_PX;

    const gx = Math.floor(xPx / CELL_PX);
    const gy = Math.floor(yPx / CELL_PX);
    if (Number.isNaN(gx) || Number.isNaN(gy)) return null;
    if (gx < 0 || gy < 0 || gx >= currentLayout.gridCols || gy >= currentLayout.gridRows) return null;
    return { x: gx, y: gy };
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    if (!draggedItem || !currentLayout) return;

    const target = hoverCell ?? clientPointToGridCell(e.clientX, e.clientY);
    if (!target) return;
    const gridX = target.x;
    const gridY = target.y;

    // Shift = temporarily disable smart snapping
    const disableSnap = Boolean((e as any).shiftKey);

    // Drop NEW table
    if (draggedItem.kind === 'table' && draggedItem.mode === 'new' && draggedItem.shape) {
      const seats = Number(draggedItem.seats ?? (draggedItem.shape === 'booth' ? 4 : (draggedItem.shape === 'round' ? 4 : 2)));
      const span = defaultSpanForNewTable(String(draggedItem.shape), seats);
      const initialSpanX = span.spanX;
      const initialSpanY = span.spanY;
      const snapped = snapPlacement(gridX, gridY, initialSpanX, initialSpanY, 'table', draggedItem.shape, disableSnap);

      const newTable: FloorTable = {
        id: `T${Date.now()}`,
        name: `Table ${nextTableNumber}`,
        tableNumber: nextTableNumber,
        gridX: snapped.x,
        gridY: snapped.y,
        spanX: initialSpanX,
        spanY: initialSpanY,
        seats,
        shape: draggedItem.shape as any,
        sectionId: activeSection?.id
      };

      setCurrentLayout({
        ...currentLayout,
        tables: [...currentLayout.tables, newTable]
      });
      setNextTableNumber(nextTableNumber + 1);
      setSelectedObject(null);
      setSelectedTable(newTable);
    }

    // Move EXISTING table
    else if (draggedItem.kind === 'table' && draggedItem.mode === 'existing' && draggedItem.tableId) {
      const moving = currentLayout.tables.find(t => t.id === draggedItem.tableId);
      if (!moving) return;
      const snapped = snapPlacement(gridX, gridY, moving.spanX || 1, moving.spanY || 1, 'table', moving.shape, disableSnap, { kind: 'table', id: moving.id });
      setCurrentLayout({
        ...currentLayout,
        tables: currentLayout.tables.map(t =>
          t.id === draggedItem.tableId ? { ...t, gridX: snapped.x, gridY: snapped.y } : t
        )
      });
    }

    // Drop NEW object
    else if (draggedItem.kind === 'object' && draggedItem.mode === 'new' && draggedItem.objectType) {
      const objects = currentLayout.objects ?? [];

      // reasonable defaults per object type (sizes are in grid-squares)
      const d0 = defaultSpanForNewObject(draggedItem.objectType);
      const d = {
        spanX: draggedItem.spanX ?? d0.spanX,
        spanY: draggedItem.spanY ?? d0.spanY,
        rotation: 0 as 0|90|180|270,
        label: draggedItem.label ?? (draggedItem.objectType === 'door' ? 'Door' : draggedItem.objectType === 'bar' ? 'Bar' : ''),
      };

      const snapped = snapPlacement(gridX, gridY, d.spanX, d.spanY, 'object', draggedItem.objectType, disableSnap);
      const newObj: FloorObject = {
        id: `O${Date.now()}`,
        type: draggedItem.objectType,
        gridX: snapped.x,
        gridY: snapped.y,
        spanX: d.spanX,
        spanY: d.spanY,
        rotation: d.rotation,
        label: d.label,
      };

      setCurrentLayout({
        ...currentLayout,
        objects: [...objects, newObj],
      });
      setSelectedTable(null);
      setSelectedObject(newObj);
    }

    // Move EXISTING object
    else if (draggedItem.kind === 'object' && draggedItem.mode === 'existing' && draggedItem.objectId) {
      const objects = currentLayout.objects ?? [];
      const moving = objects.find(o => o.id === draggedItem.objectId);
      if (!moving) return;
      const snapped = snapPlacement(gridX, gridY, moving.spanX || 1, moving.spanY || 1, 'object', moving.type, disableSnap, { kind: 'object', id: moving.id });
      setCurrentLayout({
        ...currentLayout,
        objects: objects.map(o => o.id === draggedItem.objectId ? { ...o, gridX: snapped.x, gridY: snapped.y } : o)
      });
    }

    setDraggedItem(null);
    setHoverCell(null);

  };

  const handleGridDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cell = clientPointToGridCell(e.clientX, e.clientY);
    if (cell) setHoverCell(cell);
  };

  const handleGridDragLeave = () => {
    setHoverCell(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Update hover cell from mouse position (works even when grid is transformed)
    const cell = clientPointToGridCell(e.clientX, e.clientY);
    if (cell) setHoverCell(cell);
  };

  const deleteTable = (tableId: string) => {
    if (!currentLayout) return;
    setCurrentLayout({
      ...currentLayout,
      tables: currentLayout.tables.filter(t => t.id !== tableId)
    });
    setSelectedTable(null);
  };

  const deleteObject = (objectId: string) => {
    if (!currentLayout) return;
    const objects = currentLayout.objects ?? [];
    setCurrentLayout({
      ...currentLayout,
      objects: objects.filter(o => o.id !== objectId),
    });
    setSelectedObject(null);
  };

  const updateObject = (objectId: string, updates: Partial<FloorObject>) => {
    if (!currentLayout) return;
    const objects = currentLayout.objects ?? [];
    setCurrentLayout({
      ...currentLayout,
      objects: objects.map(o => o.id === objectId ? { ...o, ...updates } : o),
    });
  };

  const updateTable = (tableId: string, updates: Partial<FloorTable>) => {
    if (!currentLayout) return;
    setCurrentLayout({
      ...currentLayout,
      tables: currentLayout.tables.map(t => t.id === tableId ? { ...t, ...updates } : t)
    });
  };

  const saveCurrentLayout = async () => {
    if (!currentLayout) return;

    try {
      const response = await fetch(`/api/floor-layouts/${restaurantId}/${currentLayout.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(currentLayout)
      });

      if (response.ok) {
        alert('✅ ' + t('floor.success.save', 'Layout saved successfully!'));
        setLayouts(layouts.map(l => l.id === currentLayout.id ? currentLayout : l));
      } else {
        const data = await response.json();
        alert('❌ ' + t('floor.error.save', 'Error saving: {error}').replace('{error}', data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('Save failed:', err);
      alert('❌ ' + t('floor.error.save', 'Error saving: {error}').replace('{error}', err instanceof Error ? err.message : String(err)));
    }
  };

  if (!currentLayout) {
    return (
      <div className="floor-editor-empty">
        <h2>{t('floor.empty_state', 'No floor layouts found. Please create a floor layout first.')}</h2>
        <p>{t('floor.empty_hint', 'Create your first floor layout to get started.')}</p>
        <button className="btn-primary" onClick={() => setIsCreateModalOpen(true)}>
          ➕ {t('floor.btn_create_new', 'Create New Layout')}
        </button>

        {isCreateModalOpen && (
          <div className="modal-overlay" onClick={() => setIsCreateModalOpen(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>{t('floor.btn_create_new', 'Create New Layout')}</h3>
              <input
                type="text"
                placeholder={t('floor.placeholder.layout_name', 'Layout name (e.g., Main Floor, Patio)')}
                value={newLayoutName}
                onChange={(e) => setNewLayoutName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createNewLayout()}
                autoFocus
              />
              <div className="modal-actions">
                <button onClick={createNewLayout} className="btn-primary">{t('common.btn_add', 'Create')}</button>
                <button onClick={() => setIsCreateModalOpen(false)} className="btn-secondary">{t('common.btn_cancel', 'Cancel')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="floor-editor">
      {/* Horizontal layout tabs at the top */}
      <div className="layout-tabs-bar">
        <div className="layout-tabs">
          {layouts.map((layout) => (
            <button
              key={layout.id}
              className={`layout-tab ${currentLayout.id === layout.id ? 'active' : ''} ${layout.isActive ? 'is-active' : ''}`}
              onClick={() => setCurrentLayout(layout)}
              title={layout.isActive ? 'Active layout (shown in live view)' : ''}
            >
              {layout.name}
              {layout.isActive && <span className="active-badge">★</span>}
            </button>
          ))}
        </div>
        <div className="layout-actions">
          <button className="btn-icon-small" onClick={() => setIsCreateModalOpen(true)} title="New Layout">
            ➕
          </button>
          <button className="btn-icon-small" onClick={() => duplicateLayout(currentLayout.id)} title="Duplicate">
            📋
          </button>
          {!currentLayout.isActive && (
            <button className="btn-icon-small" onClick={() => setActiveLayout(currentLayout.id)} title="Set as Active">
              ⭐
            </button>
          )}
          {layouts.length > 1 && (
            <button className="btn-icon-small btn-danger" onClick={() => deleteLayout(currentLayout.id)} title="Delete">
              🗑️
            </button>
          )}
        </div>
      </div>

      <div className="editor-content">
        <div className="editor-sidebar">
          {sections.length > 0 && (
            <div className="sections-tabs">
              <h3>Sections</h3>
              <div className="tabs">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    className={`tab ${activeSection?.id === section.id ? 'active' : ''}`}
                    onClick={() => setActiveSection(section)}
                  >
                    {section.name}
                  </button>
                ))}
              </div>
              <label className="fe-toggle">
                <input
                  type="checkbox"
                  checked={showOnlyActiveSection}
                  onChange={(e) => setShowOnlyActiveSection(e.target.checked)}
                />
                <span>Show only active section</span>
              </label>
            </div>
          )}

          <h2>🎨 Palette</h2>
          <div className="palette">
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 2 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('square', 2)} alt="" /></div>
              <span>Square Table · 2 (2 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 4 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('square', 4)} alt="" /></div>
              <span>Square Table · 4 (4 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'rect', seats: 6 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('rect', 6)} alt="" /></div>
              <span>Rect Table · 6 (6 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'rect', seats: 8 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('rect', 8)} alt="" /></div>
              <span>Rect Table · 8 (8 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'rect', seats: 10 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('rect', 10)} alt="" /></div>
              <span>Rect Table · 10 (10 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'round', seats: 4 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('round', 4)} alt="" /></div>
              <span>Round Table · 4 (4 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'round', seats: 10 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('round', 10)} alt="" /></div>
              <span>Round Table · 10 (10 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'booth', seats: 2 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('booth', 2)} alt="" /></div>
              <span>Sofa Booth · 2 (2 cells)</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'booth', seats: 4 })}>
              <div className="preview"><img className="preview-img" src={assetForTable('booth', 4)} alt="" /></div>
              <span>Sofa Booth · 4 (4 cells)</span>
            </div>
          </div>

<h2 style={{ marginTop: 18 }}>🏗️ Elements</h2>
          <div className="palette">
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'plant', label: 'chair', spanX: 1, spanY: 1 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('plant', 1, 1, 'chair')} alt="" /></div>
              <span>Chair (1 cell)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'bar', label: 'Bar', spanX: 5, spanY: 1 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('bar', 5, 1)} alt="" /></div>
              <span>Bar · 5 (5 cells)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'door', label: 'Door', spanX: 1, spanY: 1 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('door', 1, 1)} alt="" /></div>
              <span>Door (1 cell)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider', label: 'Partition', spanX: 4, spanY: 1 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 4, 1, 'Partition')} alt="" /></div>
              <span>Partition · Horizontal (4 cells)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider', label: 'Partition', spanX: 1, spanY: 4 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 1, 4, 'Partition')} alt="" /></div>
              <span>Partition · Vertical (4 cells)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider', label: 'cyclic', spanX: 2, spanY: 2 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 2, 2, 'cyclic')} alt="" /></div>
              <span>Round Partition (4 cells)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'wall', label: 'Wall', spanX: 6, spanY: 1 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('wall', 6, 1, 'Wall')} alt="" /></div>
              <span>Wall · Horizontal (6 cells)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'wall', label: 'Wall', spanX: 1, spanY: 6 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('wall', 1, 6, 'Wall')} alt="" /></div>
              <span>Wall · Vertical (6 cells)</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'plant', label: 'Plant', spanX: 1, spanY: 1 })}>
              <div className="preview"><img className="preview-img" src={assetForObject('plant', 1, 1, 'Plant')} alt="" /></div>
              <span>Plant (1 cell)</span>
            </div>
          </div>

{selectedTable && (
            <div className="properties-panel">
              <h3>Selected: {selectedTable.name}</h3>
              <label>
                Name:
                <input
                  type="text"
                  value={selectedTable.name}
                  onChange={(e) => updateTable(selectedTable.id, { name: e.target.value })}
                />
              </label>
              <label>
                Seats:
                <select
                  value={selectedTable.seats}
                  onChange={(e) => {
                    const seats = Number(e.target.value);
                    const span = defaultSpanForNewTable(String(selectedTable.shape), seats);
                    updateTable(selectedTable.id, { seats, spanX: span.spanX, spanY: span.spanY });
                  }}
                >
                  {[2,4,6,8,10].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button className="btn-danger" onClick={() => deleteTable(selectedTable.id)}>
                🗑️ Delete
              </button>
            </div>
          )}

          {selectedObject && (
            <div className="properties-panel">
              <h3>Selected: {selectedObject.type}</h3>
              <label>
                Label:
                <input
                  type="text"
                  value={selectedObject.label ?? ''}
                  onChange={(e) => updateObject(selectedObject.id, { label: e.target.value })}
                />
              </label>
              <div className="row" style={{ display: 'flex', gap: 8 }}>
                <label style={{ flex: 1 }}>
                  W:
                  <input
                    type="number"
                    min="1"
                    max="12"
                    value={selectedObject.spanX}
                    onChange={(e) => updateObject(selectedObject.id, { spanX: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </label>
                <label style={{ flex: 1 }}>
                  H:
                  <input
                    type="number"
                    min="1"
                    max="12"
                    value={selectedObject.spanY}
                    onChange={(e) => updateObject(selectedObject.id, { spanY: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </label>
              </div>
              <label>
                Rotation:
                <select
                  value={selectedObject.rotation ?? 0}
                  onChange={(e) => updateObject(selectedObject.id, { rotation: Number(e.target.value) as any })}
                >
                  <option value={0}>0°</option>
                  <option value={90}>90°</option>
                  <option value={180}>180°</option>
                  <option value={270}>270°</option>
                </select>
              </label>
              <button className="btn-danger" onClick={() => deleteObject(selectedObject.id)}>
                🗑️ Delete
              </button>
            </div>
          )}

          <button className="btn-save" onClick={saveCurrentLayout}>
            💾 Save Layout
          </button>
        </div>

        <div className={`editor-canvas ${isPanning ? "is-panning" : ""}`} ref={canvasRef} onWheel={onCanvasWheel} onMouseDown={onCanvasMouseDown}>
          
          <div className="fe-canvas-controls">
            <button className="btn-icon-small" onClick={() => zoomAtPoint(clampZoom(zoom * 1.1), (canvasRef.current?.getBoundingClientRect().left || 0) + 40, (canvasRef.current?.getBoundingClientRect().top || 0) + 40)} title="Zoom in">＋</button>
            <button className="btn-icon-small" onClick={() => zoomAtPoint(clampZoom(zoom * 0.9), (canvasRef.current?.getBoundingClientRect().left || 0) + 40, (canvasRef.current?.getBoundingClientRect().top || 0) + 40)} title="Zoom out">－</button>
            <button className="btn-icon-small" onClick={fitToScreen} title="Fit to screen">⤢</button>
            <div className="fe-zoom-readout">{Math.round(zoom * 100)}%</div>
            <div className="fe-hint">{spacePressed ? 'Pan: drag' : 'Tip: hold Space to pan, Ctrl+wheel to zoom'}</div>
          </div>
<div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${currentLayout.gridCols}, 60px)`,
              gridTemplateRows: `repeat(${currentLayout.gridRows}, 60px)`,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0'
            }}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragLeave={() => setHoverCell(null)}
          >
            {(() => {
              // Drop preview: shows where the dragged item will land (with snapping)
              if (!hoverCell || !draggedItem || !currentLayout) return null;
              const cellPx = 60;
              const padPx = 10;

              const spanFromDragged = () => {
                if (draggedItem.kind === 'table') {
                  if (draggedItem.mode === 'new') {
                    const sh = String(draggedItem.shape || 'square');
                    const seats = Number(draggedItem.seats ?? (sh === 'booth' ? 4 : (sh === 'round' ? 4 : 2)));
                    const span = defaultSpanForNewTable(sh, seats);
                    return { spanX: span.spanX, spanY: span.spanY, subtype: sh };
                  }
                  const t = currentLayout.tables.find(tt => tt.id === draggedItem.tableId);
                  if (t) return { spanX: t.spanX || 1, spanY: t.spanY || 1, subtype: t.shape };
                }
                if (draggedItem.kind === 'object') {
                  if (draggedItem.mode === 'new') {
                    const tp = draggedItem.objectType as any;
                    const d0 = tp ? defaultSpanForNewObject(tp) : { spanX: 1, spanY: 1 };
                    const spanX = draggedItem.spanX ?? d0.spanX;
                    const spanY = draggedItem.spanY ?? d0.spanY;
                    return { spanX, spanY, subtype: draggedItem.objectType };
                  }
                  const o = (currentLayout.objects ?? []).find(oo => oo.id === draggedItem.objectId);
                  if (o) return { spanX: o.spanX || 1, spanY: o.spanY || 1, subtype: o.type };
                }
                return { spanX: 1, spanY: 1, subtype: '' };
              };

              const { spanX, spanY, subtype } = spanFromDragged();
              // Use snapping logic (same as onDrop). Shift disables snap.
              const snapped = snapPlacement(hoverCell.x, hoverCell.y, spanX, spanY, draggedItem.kind, String(subtype), false, draggedItem.mode === 'existing' ? { kind: draggedItem.kind, id: draggedItem.kind === 'table' ? draggedItem.tableId : draggedItem.objectId } : undefined);
              const left = padPx + snapped.x * cellPx;
              const top = padPx + snapped.y * cellPx;

              return (
                <>
                  {snapped.guides.v.map((gx, idx) => (
                    <div key={`pv-v-${idx}`} className="fe-guide-line v" style={{ left: 10 + gx * cellPx }} />
                  ))}
                  {snapped.guides.h.map((gy, idx) => (
                    <div key={`pv-h-${idx}`} className="fe-guide-line h" style={{ top: 10 + gy * cellPx }} />
                  ))}
                  <div
                  className="fe-drop-preview"
                  style={{
                    left,
                    top,
                    width: spanX * cellPx,
                    height: spanY * cellPx,
                  }}
                />
                </>
              );
            })()}

            {Array.from({ length: currentLayout.gridRows * currentLayout.gridCols }).map((_, i) => {
              const gridY = Math.floor(i / currentLayout.gridCols);
              const gridX = i % currentLayout.gridCols;

              const tableHere = currentLayout.tables.find(t => {
                if (showOnlyActiveSection && activeSection && String(t.sectionId || '') !== String(activeSection.id)) return false;
                return (
                  gridX >= t.gridX && gridX < t.gridX + t.spanX &&
                  gridY >= t.gridY && gridY < t.gridY + t.spanY
                );
              });

              const objects = currentLayout.objects ?? [];
              const objectHere = objects.find(o =>
                gridX >= o.gridX && gridX < o.gridX + o.spanX &&
                gridY >= o.gridY && gridY < o.gridY + o.spanY
              );

              const isTopLeft = tableHere && tableHere.gridX === gridX && tableHere.gridY === gridY;
              const isObjTopLeft = objectHere && objectHere.gridX === gridX && objectHere.gridY === gridY;

              return (
                <div
                  key={i}
                  className="grid-cell"
                >
                  {isObjTopLeft && objectHere && (
                    <div
                      className={`floor-object type-${objectHere.type} ${selectedObject?.id === objectHere.id ? 'selected' : ''}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, 'object', 'existing', { objectId: objectHere.id })}
                      onClick={() => {
                        setSelectedTable(null);
                        setSelectedObject(objectHere);
                      }}
                      style={{
                        width: objectHere.spanX === 2 ? 'calc(200% + 2px)' : objectHere.spanX === 3 ? 'calc(300% + 4px)' : objectHere.spanX === 4 ? 'calc(400% + 6px)' : '100%',
                        height: objectHere.spanY === 2 ? 'calc(200% + 2px)' : objectHere.spanY === 3 ? 'calc(300% + 4px)' : '100%',
                        transform: `rotate(${objectHere.rotation ?? 0}deg)`,
                      }}
                    >
                      <img className="fe-asset" style={{ transform: `scale(${scaleForObject(objectHere.type)})` }} src={assetForObject(objectHere.type, objectHere.spanX, objectHere.spanY)} alt="" />
                      {objectHere.label && <div className="obj-label">{objectHere.label}</div>}
                    </div>
                  )}
                  {isTopLeft && (
                    <div
                      className={`table ${tableHere.shape} ${selectedTable?.id === tableHere.id ? 'selected' : ''} ${(!showOnlyActiveSection && activeSection && String(tableHere.sectionId || '') && String(tableHere.sectionId || '') !== String(activeSection.id)) ? 'dimmed' : ''}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, 'table', 'existing', { tableId: tableHere.id })}
                      onClick={() => {
                        setSelectedObject(null);
                        setSelectedTable(tableHere);
                      }}
                      style={{
                        width: tableHere.spanX === 2 ? 'calc(200% + 2px)' : '100%',
                        height: tableHere.spanY === 2 ? 'calc(200% + 2px)' : '100%'
                      }}
                    >
                      <div className="fe-table-visual">
                        <img className="fe-asset" style={{ transform: `scale(${scaleForTable(tableHere.shape, tableHere.seats)})` }} src={assetForTable(tableHere.shape, tableHere.seats)} alt="" />
                      </div>
                      <div className="fe-table-overlay">
                        <div className="table-label">{tableHere.name}</div>
                        <div className="table-seats">{tableHere.seats} seats</div>
                        {tableHere.sectionId && sections.length > 0 && (
                          <div className="table-section">
                            {sections.find(s => String(s.id) === String(tableHere.sectionId))?.name || 'Section'}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {isCreateModalOpen && (
        <div className="modal-overlay" onClick={() => setIsCreateModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create New Layout</h3>
            <input
              type="text"
              placeholder="Layout name (e.g., Main Floor, Patio)"
              value={newLayoutName}
              onChange={(e) => setNewLayoutName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createNewLayout()}
              autoFocus
            />
            <div className="modal-actions">
              <button onClick={createNewLayout} className="btn-primary">Create</button>
              <button onClick={() => setIsCreateModalOpen(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
