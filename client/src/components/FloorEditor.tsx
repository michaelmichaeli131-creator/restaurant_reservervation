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
  scale?: number; // 1.0 default
  rotationDeg?: number; // multiples of 45
  // Critical: without assetFile we fall back to default rendering.
  assetFile?: string; // e.g. "square_table6.svg"
  kind?: 'table';
  sectionId?: string;
}

interface FloorObject {
  id: string;
  type: 'wall' | 'door' | 'bar' | 'plant' | 'divider' | 'chair' | 'visual';
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  rotationDeg?: number; // multiples of 45
  scale?: number; // 1.0 default
  rotation?: number; // degrees (legacy 0/90/180/270)
  label?: string;
  assetFile?: string; // e.g. "door.svg"
  kind?: 'object' | 'visualOnly';
}

interface FloorLayout {
  id: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  gridMask?: number[]; // 1=active cell, 0=inactive
  floorColor?: string; // floor theme key (kept as string for backwards compatibility)
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
    shape?: string; // for tables
    seats?: number; // for new tables
    spanX?: number; // for new items
    spanY?: number; // for new items
    objectType?: FloorObject['type'];
    objectLabel?: string;
    objectKind?: 'object' | 'visualOnly';
    assetFile?: string; // e.g. "square_table6.svg"
    rotation?: number; // degrees (multiples of 45)
    tableId?: string;
    objectId?: string;
  } | null>(null);
  const [nextTableNumber, setNextTableNumber] = useState(1);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');
  const [showOnlyActiveSection, setShowOnlyActiveSection] = useState(false);
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);

  const [cellSize, setCellSize] = useState(60);

  type FloorThemeKey = 'parquet_blue' | 'parquet_brown' | 'slate_dark' | 'navy_carpet' | 'teal_terrazzo';

  const FLOOR_THEMES: Record<FloorThemeKey, { label: string; bg: string; size: string; repeat: string; pos: string }> = {
    parquet_blue: {
      label: 'Blue parquet',
      bg: `url(${`/floor_assets/floor_parquet_blue.svg`})`,
      size: '240px 240px',
      repeat: 'repeat',
      pos: 'center',
    },
    parquet_brown: {
      label: 'Brown parquet',
      bg: `url(${`/floor_assets/floor_parquet_brown.svg`})`,
      size: '240px 240px',
      repeat: 'repeat',
      pos: 'center',
    },
    slate_dark: {
      label: 'Dark slate',
      bg: `url(${`/floor_assets/floor_slate_dark.svg`})`,
      size: '240px 240px',
      repeat: 'repeat',
      pos: 'center',
    },
    navy_carpet: {
      label: 'Deep navy',
      bg: `url(${`/floor_assets/floor_navy_carpet.svg`})`,
      size: '240px 240px',
      repeat: 'repeat',
      pos: 'center',
    },
    teal_terrazzo: {
      label: 'Muted teal',
      bg: `url(${`/floor_assets/floor_teal_terrazzo.svg`})`,
      size: '240px 240px',
      repeat: 'repeat',
      pos: 'center',
    },
  };

  const normalizeTheme = (v?: string): FloorThemeKey => {
    // Backwards compatibility: previous versions stored hex colors.
    if (!v) return 'parquet_blue';
    if (v.startsWith('#')) return 'parquet_blue';
    if ((v as FloorThemeKey) in FLOOR_THEMES) return v as FloorThemeKey;
    return 'parquet_blue';
  };

  const [floorTheme, setFloorTheme] = useState<FloorThemeKey>('parquet_blue');

  // Center the map inside the scrollable canvas whenever grid size / cell size changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentLayout) return;

    // Wait for DOM layout
    requestAnimationFrame(() => {
      const gridW = currentLayout.gridCols * cellSize + 48; // + 2*24px margin (see CSS)
      const gridH = currentLayout.gridRows * cellSize + 48;

      const targetLeft = Math.max(0, (gridW - canvas.clientWidth) / 2);
      const targetTop  = Math.max(0, (gridH - canvas.clientHeight) / 2);

      canvas.scrollLeft = targetLeft;
      canvas.scrollTop  = targetTop;
    });
  }, [currentLayout?.id, currentLayout?.gridCols, currentLayout?.gridRows, cellSize]);

  const [shapeMode, setShapeMode] = useState(false);
  // Sync floor theme from the loaded layout
  useEffect(() => {
    if (!currentLayout) return;
    setFloorTheme(normalizeTheme((currentLayout as any).floorColor));
  }, [currentLayout?.id]);

  const [isPainting, setIsPainting] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false); 

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const paintValueRef = useRef<0 | 1 | null>(null);

  // Always load assets from the server static path.
  // Requirement: /floor_assets/<file>.svg
  const ASSET_BASE = `/floor_assets/`;
  const GRID_PAD_PX = 10;

  // Compute pixel size for an item that spans N cells, accounting for the
  // ~2px total border between adjacent cells (each cell has a 1px border).
  const spanToPx = (span: number) => {
    const s = Math.max(1, Number(span) || 1);
    return s * cellSize;
  };

  // Cell-based sizing: total cells ~= seats for tables/booths.
  // The editor renders items by spanX/spanY in grid cells.
      const spansForTable = (shape: string, seats: number) => {
    const s = String(shape || 'square').toLowerCase();
    const n = Number(seats || 0);

    // Booths
    if (s === 'booth') {
      // large_booth6: 6×2 (user request). booth4 remains 2×2.
      if (n >= 6) return { spanX: 6, spanY: 2 };
      return { spanX: 2, spanY: 2 };
    }

    // Round tables
    if (s === 'round') {
      // round_table_10: 3×3 (user request)
      if (n >= 9) return { spanX: 3, spanY: 3 };
      // round_table4: 2×2
      return { spanX: 2, spanY: 2 };
    }

    // Square/rect tables
    if (n <= 2) return { spanX: 2, spanY: 1 };
    if (n <= 4) return { spanX: 2, spanY: 2 };

    // For 6/8/10-seat square tables, keep width but reduce length to 2 cells (2×2)
    // to avoid overly long tables (user request).
    return { spanX: 2, spanY: 2 };
  };

  const scaleForTable = (shape: string, seats: number, assetFile?: string) => {
    // Keep assets inside their allocated cell-span (no overflow).
    // Use small, asset-specific nudges only where needed.
    const af = String(assetFile || '').toLowerCase();

    // Reported as too large -> clamp down so it never bleeds outside its span.
    if (af === 'large_booth.svg') return 0.88;
    if (af === 'round_table_10.svg') return 0.88;

    // Visually fill their full span but remain fully visible.
    if (af === 'round_table4.svg') return 1.06;
    if (af === 'square_table2.svg') return 1.06;

    return 1.0;
  };

  

  const getItemScale = (itemScale?: number, fallback = 1) => {
    const v = Number(itemScale);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(0.5, Math.min(1.6, v));
  };

  const getItemRotation = (deg?: number) => {
    const v = Number(deg);
    if (!Number.isFinite(v)) return 0;
    // snap to 45-degree steps
    return Math.round(v / 45) * 45;
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
  const assetForObject = (type: FloorObject['type'], spanX: number, spanY: number, label?: string) => {
    const lab = String(label || '').toLowerCase();

    // Prefer explicit label->file mapping (stable, matches the asset names).
    const direct: Record<string, string> = {
      bar: 'bar.svg',
      chair: 'chair.svg',
      plant: 'plant.svg',
      door: 'door.svg',
      floor_brown: 'floor_brown.svg',
      corner_partitaion: 'corner_partitaion.svg',
      cyclic: 'cyclic_partition.svg',
      cyclic_partition: 'cyclic_partition.svg',
      horizintal_partitaion: 'horizintal_partitaion.svg',
      vertical_partition: 'vertical_partition.svg',
    };

    if (direct[lab]) return `${ASSET_BASE}${direct[lab]}`;

    // Backward compatible fallbacks by type
    if (type === 'door') return `${ASSET_BASE}door.svg`;
    if (type === 'bar') return `${ASSET_BASE}bar.svg`;
    if (type === 'plant') return `${ASSET_BASE}plant.svg`;

    // Orientation fallback for walls/dividers when label is not set
    if ((spanX || 1) === 1 && (spanY || 1) === 1) return `${ASSET_BASE}corner_partitaion.svg`;
    if ((spanX || 1) > (spanY || 1)) return `${ASSET_BASE}horizintal_partitaion.svg`;
    return `${ASSET_BASE}vertical_partition.svg`;
  };


    const ensureMask = (l: FloorLayout): FloorLayout => {
    const rows = Number(l.gridRows || 0);
    const cols = Number(l.gridCols || 0);
    const size = Math.max(0, rows * cols);
    const base = Array.isArray((l as any).gridMask) ? (l as any).gridMask.slice(0, size) : [];
    while (base.length < size) base.push(1);
    return { ...l, gridMask: base, floorColor: (l as any).floorColor || 'parquet_blue' };
  };

  const maskAllows = (x: number, y: number, spanX: number, spanY: number) => {
    if (!currentLayout?.gridMask) return true;
    const cols = currentLayout.gridCols;
    for (let yy = y; yy < y + spanY; yy++) {
      for (let xx = x; xx < x + spanX; xx++) {
        if (xx < 0 || yy < 0 || xx >= cols || yy >= currentLayout.gridRows) return false;
        const idx = yy * cols + xx;
        if (currentLayout.gridMask[idx] !== 1) return false;
      }
    }
    return true;
  };

// Load all layouts
  useEffect(() => {
    if (!restaurantId) return;

    fetch(`/api/floor-layouts/${restaurantId}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        setLayouts(data);
        const active = data.find((l: FloorLayout) => l.isActive);
        setCurrentLayout(active ? ensureMask(active) : (data[0] ? ensureMask(data[0]) : null));

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
          gridMask: Array.from({ length: 8 * 12 }, () => 1),
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
    opts?: {
      shape?: string;
      seats?: number;
      spanX?: number;
      spanY?: number;
      rotation?: number; // degrees (multiples of 45)
      objectType?: FloorObject['type'];
      objectLabel?: string;
      tableId?: string;
      objectId?: string;
    }
  ) => {
    setDraggedItem({ kind, mode, ...opts });
    setHoverCell(null);
    e.dataTransfer.effectAllowed = 'move';
    try {
      const img = new Image();
      img.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22%3E%3C/svg%3E';
      e.dataTransfer.setDragImage(img, 0, 0);
    } catch {}
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
    const cellPx = cellSize;
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

    // Convert viewport point -> grid cell robustly even when zoom/pan are applied.
    // We derive the effective scale from the rendered grid bounding box.
    const gridEl = gridRef.current;
    if (!gridEl) return null;

    const rect = gridEl.getBoundingClientRect();
    const gridW = currentLayout.gridCols * cellSize;
    const gridH = currentLayout.gridRows * cellSize;

    const scaleX = rect.width / Math.max(1, gridW);
    const scaleY = rect.height / Math.max(1, gridH);

    const xLocal = (clientX - rect.left) / scaleX;
    const yLocal = (clientY - rect.top) / scaleY;

    let gx = Math.floor(xLocal / cellSize);
    const gy = Math.floor(yLocal / cellSize);

    // In RTL layouts, CSS grid columns are laid out from right-to-left.
    // Convert logical x so drop/drag matches the visual position.
    const dir = getComputedStyle(gridEl).direction;
    if (dir === 'rtl') {
      gx = (currentLayout.gridCols - 1) - gx;
    }

    if (Number.isNaN(gx) || Number.isNaN(gy)) return null;
    if (gx < 0 || gy < 0 || gx >= currentLayout.gridCols || gy >= currentLayout.gridRows) return null;
    return { x: gx, y: gy };
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();

    if (!draggedItem || !currentLayout) return;

    const target = clientPointToGridCell(e.clientX, e.clientY);
    if (!target) return;
    const gridX = target.x;
    const gridY = target.y;

    // Shift = temporarily disable smart snapping
    const disableSnap = Boolean((e as any).shiftKey);

    // Drop NEW table
    if (draggedItem.kind === 'table' && draggedItem.mode === 'new' && draggedItem.shape) {
      const seats = Number(draggedItem.seats ?? (draggedItem.shape === 'booth' ? 4 : 2));
      const sp = (draggedItem.spanX && draggedItem.spanY)
        ? { spanX: draggedItem.spanX, spanY: draggedItem.spanY }
        : spansForTable(draggedItem.shape, seats);

      const snapped = snapPlacement(gridX, gridY, sp.spanX, sp.spanY, 'table', draggedItem.shape, disableSnap);

      if (!maskAllows(snapped.x, snapped.y, sp.spanX, sp.spanY)) {
        alert('Cannot place item outside the restaurant shape');
        return;
      }

      const newTable: FloorTable = {
        id: `T${Date.now()}`,
        name: `Table ${nextTableNumber}`,
        tableNumber: nextTableNumber,
        gridX: snapped.x,
        gridY: snapped.y,
        spanX: sp.spanX,
        spanY: sp.spanY,
        seats,
        shape: draggedItem.shape as any,
        assetFile: draggedItem.assetFile,
        kind: 'table',
        sectionId: activeSection?.id,
        scale: 1,
        rotationDeg: 0
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

      if (!maskAllows(snapped.x, snapped.y, moving.spanX || 1, moving.spanY || 1)) {
        alert('Cannot move item outside the restaurant shape');
        return;
      }
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

      // Prefer explicit palette-provided sizing. Fallback to old defaults.
      const defaults: Record<string, { spanX: number; spanY: number; rotation?: 0|90|180|270; label?: string }> = {
        wall: { spanX: 4, spanY: 1, rotation: 0, label: 'wall_h' },
        divider: { spanX: 2, spanY: 1, rotation: 0, label: 'partition' },
        door: { spanX: 1, spanY: 1, rotation: 0, label: 'Door' },
        bar: { spanX: 5, spanY: 1, rotation: 0, label: 'Bar' },
        plant: { spanX: 1, spanY: 1, rotation: 0, label: '' },
      };

      const d = defaults[String(draggedItem.objectType)] ?? { spanX: 1, spanY: 1 };
      const sp = {
        spanX: Math.max(1, Number(draggedItem.spanX ?? d.spanX) || 1),
        spanY: Math.max(1, Number(draggedItem.spanY ?? d.spanY) || 1),
      };

      const snapped = snapPlacement(gridX, gridY, sp.spanX, sp.spanY, 'object', draggedItem.objectType, disableSnap);

      if (!maskAllows(snapped.x, snapped.y, sp.spanX, sp.spanY)) {
        alert('Cannot place item outside the restaurant shape');
        return;
      }
      const newObj: FloorObject = {
        id: `O${Date.now()}`,
        type: draggedItem.objectType,
        gridX: snapped.x,
        gridY: snapped.y,
        spanX: sp.spanX,
        spanY: sp.spanY,
        rotation: (draggedItem.rotation ?? d.rotation) as any,
        label: draggedItem.objectLabel ?? d.label,
        assetFile: draggedItem.assetFile,
        kind: draggedItem.objectKind ?? 'object',
        scale: 1,
        rotationDeg: 0,
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

      if (!maskAllows(snapped.x, snapped.y, moving.spanX || 1, moving.spanY || 1)) {
        alert('Cannot move item outside the restaurant shape');
        return;
      }
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
              onClick={() => setCurrentLayout(ensureMask(layout))}
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

          <h2>🧩 Assets</h2>

          <h3 className="fe-subtitle">Seating</h3>
          <div className="palette">
            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'rect', seats: 5, spanX: 5, spanY: 2, assetFile: 'bar.svg' })}
            >
              <div className="preview"><img className="preview-img" src={`${ASSET_BASE}bar.svg`} alt="" /></div>
              <span>bar.svg • 5 (5×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'booth', seats: 4, spanX: 2, spanY: 2, assetFile: 'booth4.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('booth', 4)} alt="" /></div>
              <span>booth4.svg • 4 (2×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'booth', seats: 6, spanX: 6, spanY: 2, assetFile: 'large_booth.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('booth', 6)} alt="" /></div>
              <span>large_booth.svg • 6 (6×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'chair', spanX: 1, spanY: 1, objectLabel: 'chair', assetFile: 'chair.svg', objectKind: 'object' })}
            >
              <div className="preview"><img className="preview-img" src={`${ASSET_BASE}chair.svg`} alt="" /></div>
              <span>chair.svg • 1 (1×1)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'plant', spanX: 1, spanY: 1, objectLabel: 'plant', assetFile: 'plant.svg', objectKind: 'object' })}
            >
              <div className="preview"><img className="preview-img" src={`${ASSET_BASE}plant.svg`} alt="" /></div>
              <span>plant.svg • 1 (1×1)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'round', seats: 4, spanX: 2, spanY: 2, assetFile: 'round_table4.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('round', 4)} alt="" /></div>
              <span>round_table4.svg • 4 (2×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'round', seats: 10, spanX: 3, spanY: 3, assetFile: 'round_table_10.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('round', 10)} alt="" /></div>
              <span>round_table_10.svg • 10 (3×3)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 2, spanX: 2, spanY: 1, assetFile: 'square_table2.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('square', 2)} alt="" /></div>
              <span>square_table2.svg • 2 (2×1)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 4, spanX: 2, spanY: 2, assetFile: 'square_table4.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('square', 4)} alt="" /></div>
              <span>square_table4.svg • 4 (2×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 6, spanX: 2, spanY: 2, assetFile: 'square_table6.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('square', 6)} alt="" /></div>
              <span>square_table6.svg • 6 (2×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 8, spanX: 2, spanY: 2, assetFile: 'square_table8.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('square', 8)} alt="" /></div>
              <span>square_table8.svg • 8 (2×2)</span>
            </div>

            <div
              className="palette-item"
              draggable
              onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats: 10, spanX: 2, spanY: 2, assetFile: 'square_table10.svg' })}
            >
              <div className="preview"><img className="preview-img" src={assetForTable('square', 10)} alt="" /></div>
              <span>square_table10.svg • 10 (2×2)</span>
            </div>
          </div>

          <h3 className="fe-subtitle" style={{ marginTop: 14 }}>Visual only</h3>
          <div className="palette">
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'visual', spanX: 1, spanY: 1, objectLabel: 'corner_partitaion', assetFile: 'corner_partitaion.svg', objectKind: 'visualOnly' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 1, 1, 'corner_partitaion')} alt="" /></div>
              <span>corner_partitaion.svg</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'visual', spanX: 2, spanY: 2, objectLabel: 'cyclic_partition', assetFile: 'cyclic_partition.svg', objectKind: 'visualOnly' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 2, 2, 'cyclic_partition')} alt="" /></div>
              <span>cyclic_partition.svg</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'door', spanX: 1, spanY: 1, objectLabel: 'door', assetFile: 'door.svg', objectKind: 'visualOnly' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('door', 1, 1, 'door')} alt="" /></div>
              <span>door.svg</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'visual', spanX: 1, spanY: 1, objectLabel: 'floor_brown', assetFile: 'floor_brown.svg', objectKind: 'visualOnly' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 1, 1, 'floor_brown')} alt="" /></div>
              <span>floor_brown.svg</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'visual', spanX: 4, spanY: 1, objectLabel: 'horizintal_partitaion', assetFile: 'horizintal_partitaion.svg', objectKind: 'visualOnly' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 4, 1, 'horizintal_partitaion')} alt="" /></div>
              <span>horizintal_partitaion.svg</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'visual', spanX: 1, spanY: 4, objectLabel: 'vertical_partition', assetFile: 'vertical_partition.svg', objectKind: 'visualOnly' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 1, 4, 'vertical_partition')} alt="" /></div>
              <span>vertical_partition.svg</span>
            </div>
          </div>

          
          <div className="properties-panel">
            <h3>Map</h3>
            <label>
              Cell size: {cellSize}px
              <input
                type="range"
                min="40"
                max="110"
                value={cellSize}
                onChange={(e) => setCellSize(Number(e.target.value))}
              />
            </label>

            <label>
              Floor:
              <select
                value={floorTheme}
                onChange={(e) => {
                  const k = normalizeTheme(String(e.target.value || 'parquet_blue'));
                  setFloorTheme(k);
                  if (currentLayout) setCurrentLayout({ ...currentLayout, floorColor: k });
                }}
              >
                {(Object.keys(FLOOR_THEMES) as FloorThemeKey[]).map((k) => (
                  <option key={k} value={k}>{FLOOR_THEMES[k].label}</option>
                ))}
              </select>
            </label>
            <div className="row" style={{ display: 'flex', gap: 8 }}
            >
              <button
                className="btn-icon-small"
                onClick={() => {
                  setShapeMode(v => !v);
                  setSelectedTable(null);
                  setSelectedObject(null);
                }}
              >
                {shapeMode ? '✅ Done shape' : '✏️ Edit shape'}
              </button>
              <button
                className="btn-icon-small"
                onClick={() => {
                  if (!currentLayout) return;
                  const size = currentLayout.gridRows * currentLayout.gridCols;
                  setCurrentLayout({ ...currentLayout, gridMask: Array.from({ length: size }, () => 1) });
                }}
                title="Reset shape"
              >
                ↺ Reset
              </button>
              <button
                className="btn-icon-small"
                onClick={() => {
                  if (!currentLayout?.gridMask) return;
                  setCurrentLayout({
                    ...currentLayout,
                    gridMask: currentLayout.gridMask.map(v => (v === 1 ? 0 : 1)),
                  });
                }}
                title="Invert shape"
              >
                ⇄ Invert
              </button>
            </div>
            {shapeMode && (
              <div className="fe-hint" style={{ marginTop: 8 }}
              >
                Paint the restaurant shape: click/drag cells to enable/disable.
              </div>
            )}
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
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={selectedTable.seats}
                  onChange={(e) => {
                    const seats = Math.max(1, Number(e.target.value) || 1);
                    const sp = spansForTable(selectedTable.shape, seats);
                    updateTable(selectedTable.id, { seats, spanX: sp.spanX, spanY: sp.spanY });
                  }}
                />
              
<label>
  Size:
  <input
    type="range"
    min="0.6"
    max="1.4"
    step="0.05"
    value={(selectedTable as any).scale ?? 1}
    onChange={(e) => updateTable(selectedTable.id, { scale: Number(e.target.value) })}
  />
  <span style={{ marginInlineStart: 8 }}>{Math.round((((selectedTable as any).scale ?? 1) as number) * 100)}%</span>
</label>

<div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
  <span style={{ opacity: .85 }}>Rotate:</span>
  <button
    className="btn-icon-small"
    onClick={() => updateTable(selectedTable.id, { rotationDeg: getItemRotation(((selectedTable as any).rotationDeg ?? 0) - 45) })}
    title="Rotate -45°"
  >↺</button>
  <div style={{ minWidth: 44, textAlign: 'center' }}>{getItemRotation((selectedTable as any).rotationDeg ?? 0)}°</div>
  <button
    className="btn-icon-small"
    onClick={() => updateTable(selectedTable.id, { rotationDeg: getItemRotation(((selectedTable as any).rotationDeg ?? 0) + 45) })}
    title="Rotate +45°"
  >↻</button>
</div>

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
  Size:
  <input
    type="range"
    min="0.6"
    max="1.4"
    step="0.05"
    value={(selectedObject as any).scale ?? 1}
    onChange={(e) => updateObject(selectedObject.id, { scale: Number(e.target.value) })}
  />
  <span style={{ marginInlineStart: 8 }}>{Math.round((((selectedObject as any).scale ?? 1) as number) * 100)}%</span>
</label>

<div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
  <span style={{ opacity: .85 }}>Rotate:</span>
  <button
    className="btn-icon-small"
    onClick={() => updateObject(selectedObject.id, { rotationDeg: getItemRotation((((selectedObject as any).rotationDeg ?? selectedObject.rotation ?? 0) as number) - 45) })}
    title="Rotate -45°"
  >↺</button>
  <div style={{ minWidth: 44, textAlign: 'center' }}>{getItemRotation((selectedObject as any).rotationDeg ?? selectedObject.rotation ?? 0)}°</div>
  <button
    className="btn-icon-small"
    onClick={() => updateObject(selectedObject.id, { rotationDeg: getItemRotation((((selectedObject as any).rotationDeg ?? selectedObject.rotation ?? 0) as number) + 45) })}
    title="Rotate +45°"
  >↻</button>
</div>
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
          {(() => {
            const ft = FLOOR_THEMES[floorTheme];
            return (
              <div
                className="fe-grid" ref={gridRef}
                style={{
              gridTemplateColumns: `repeat(${currentLayout.gridCols}, ${cellSize}px)`,
              gridTemplateRows: `repeat(${currentLayout.gridRows}, ${cellSize}px)`,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              ['--cell' as any]: `${cellSize}px`,
                  ['--floor-bg' as any]: ft.bg,
                  ['--floor-bg-size' as any]: ft.size,
                  ['--floor-bg-repeat' as any]: ft.repeat,
                  ['--floor-bg-position' as any]: ft.pos,
                }}
                onDragOver={shapeMode ? undefined : handleDragOver}
                onDrop={shapeMode ? undefined : handleDrop}
                onDragLeave={() => setHoverCell(null)}
              >
            {(() => {
              // Drop preview: shows where the dragged item will land (with snapping)
              if (!hoverCell || !draggedItem || !currentLayout) return null;
              const cellPx = cellSize;
              const padPx = 10;

              const spanFromDragged = () => {
                if (draggedItem.kind === 'table') {
                  if (draggedItem.mode === 'new') {
                    const sh = String(draggedItem.shape || 'square');
                    const seats = Number(draggedItem.seats ?? (sh === 'booth' ? 4 : 2));
                    const sp = (draggedItem.spanX && draggedItem.spanY)
                      ? { spanX: draggedItem.spanX, spanY: draggedItem.spanY }
                      : spansForTable(sh, seats);
                    return { spanX: sp.spanX, spanY: sp.spanY, subtype: sh };
                  }
                  const t = currentLayout.tables.find(tt => tt.id === draggedItem.tableId);
                  if (t) return { spanX: t.spanX || 1, spanY: t.spanY || 1, subtype: t.shape };
                }
                if (draggedItem.kind === 'object') {
                  if (draggedItem.mode === 'new') {
                    const d = {
                      spanX: Math.max(1, Number(draggedItem.spanX ?? 1) || 1),
                      spanY: Math.max(1, Number(draggedItem.spanY ?? 1) || 1),
                    };
                    return { spanX: d.spanX, spanY: d.spanY, subtype: draggedItem.objectType };
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
                    <div key={`pv-v-${idx}`} className="fe-guide-line v" style={{ left: padPx + gx * cellPx }} />
                  ))}
                  {snapped.guides.h.map((gy, idx) => (
                    <div key={`pv-h-${idx}`} className="fe-guide-line h" style={{ top: padPx + gy * cellPx }} />
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
                  className={`fe-grid-cell ${(() => { const idx = gridY * currentLayout.gridCols + gridX; const active = (currentLayout.gridMask?.[idx] ?? 1) === 1; return active ? "active" : "inactive"; })()}` }
                  onMouseDown={(e) => {
                    if (!shapeMode || !currentLayout) return;
                    e.preventDefault();
                    setIsPainting(true);
                    const idx = gridY * currentLayout.gridCols + gridX;
                    const size = currentLayout.gridRows * currentLayout.gridCols;
                    const m = (currentLayout.gridMask ?? Array.from({ length: size }, () => 1)).slice();
                    const newVal = (m[idx] === 1 ? 0 : 1) as 0 | 1;
                    paintValueRef.current = newVal;
                    m[idx] = newVal;
                    setCurrentLayout({ ...currentLayout, gridMask: m });
                  }}
                  onMouseEnter={(e) => {
                    if (!shapeMode || !isPainting || !currentLayout) return;
                    e.preventDefault();
                    const targetVal = paintValueRef.current;
                    if (targetVal == null) return;
                    const idx = gridY * currentLayout.gridCols + gridX;
                    const size = currentLayout.gridRows * currentLayout.gridCols;
                    const m = (currentLayout.gridMask ?? Array.from({ length: size }, () => 1)).slice();
                    if (m[idx] !== targetVal) {
                      m[idx] = targetVal;
                      setCurrentLayout({ ...currentLayout, gridMask: m });
                    }
                  }}
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
                        width: `${spanToPx(objectHere.spanX)}px`,
                        height: `${spanToPx(objectHere.spanY)}px`,
                        transform: `rotate(${getItemRotation((objectHere as any).rotationDeg ?? objectHere.rotation ?? 0)}deg)`,
                      }}
                    >
                      <img
                        className={`fe-asset fe-asset--${(objectHere.assetFile || "").replace(/[^a-z0-9]+/gi,"_").toLowerCase()}`}
                        style={{ transform: `scale(${getItemScale((objectHere as any).scale, scaleForObject(objectHere.type))})` }}
                        src={objectHere.assetFile ? `${ASSET_BASE}${objectHere.assetFile}` : assetForObject(objectHere.type, objectHere.spanX, objectHere.spanY, objectHere.label)}
                        alt=""
                      />
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
                        width: `${spanToPx(tableHere.spanX)}px`,
                        height: `${spanToPx(tableHere.spanY)}px`,
                      }}
                    >
                      <div className="fe-table-visual" data-asset={tableHere.assetFile || ""}>
                        <img
                          className={`fe-asset fe-asset--${(tableHere.assetFile || "").replace(/[^a-z0-9]+/gi,"_").toLowerCase()}`}
                          style={{ transform: `rotate(${getItemRotation((tableHere as any).rotationDeg ?? 0)}deg) scale(${getItemScale((tableHere as any).scale, scaleForTable(tableHere.shape, tableHere.seats, tableHere.assetFile))})` }}
                          src={tableHere.assetFile ? `${ASSET_BASE}${tableHere.assetFile}` : assetForTable(tableHere.shape, tableHere.seats)}
                          alt=""
                        />
                        {/* No auto-chairs: chairs are independent assets in the palette */}
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
            );
          })()}
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
