import { useState, useEffect } from 'react';
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
  type: 'wall' | 'door' | 'bar' | 'plant' | 'divider' | 'booth' | 'sofa';
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
    shape?: string; // for tables
    objectType?: FloorObject['type'];
    tableId?: string;
    objectId?: string;
  } | null>(null);
  const [nextTableNumber, setNextTableNumber] = useState(1);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');

  // ------------------------------
  // Visual-only wall joints overlay
  // ------------------------------
  // Goal: make walls look "architectural" by rendering junction connectors
  // (L / T / +) where multiple wall segments meet. This is purely visual and
  // does not change the saved data model.
  const CELL_PX = 60;

  type JointDirs = {
    N?: boolean;
    E?: boolean;
    S?: boolean;
    W?: boolean;
  };

  type WallJoint = {
    key: string;
    gridX: number;
    gridY: number;
    dirs: JointDirs;
  };

  function computeWallJoints(layout: FloorLayout | null): WallJoint[] {
    if (!layout) return [];
    const objects = layout.objects ?? [];
    const walls = objects.filter(o => o.type === 'wall');
    if (walls.length === 0) return [];

    const joints = new Map<string, WallJoint>();

    const addDir = (x: number, y: number, dir: keyof JointDirs) => {
      const key = `${x},${y}`;
      const existing = joints.get(key) ?? { key, gridX: x, gridY: y, dirs: {} };
      existing.dirs[dir] = true;
      joints.set(key, existing);
    };

    for (const w of walls) {
      // Orientation by span (rotation is visual; data is still grid-aligned)
      const horizontal = w.spanX >= w.spanY;
      if (horizontal) {
        const y = w.gridY;
        const x0 = w.gridX;
        const x1 = w.gridX + w.spanX;
        addDir(x0, y, 'E');
        addDir(x1, y, 'W');
      } else {
        const x = w.gridX;
        const y0 = w.gridY;
        const y1 = w.gridY + w.spanY;
        addDir(x, y0, 'S');
        addDir(x, y1, 'N');
      }
    }

    // Only keep "real" junctions: 2+ directions.
    const result: WallJoint[] = [];
    for (const j of joints.values()) {
      const count = Object.values(j.dirs).filter(Boolean).length;
      if (count >= 2) result.push(j);
    }
    return result;
  }

  // Connectivity map for ALL wall endpoints (used for cap styling + snapping).
  function computeWallEndpointMap(layout: FloorLayout | null): Map<string, JointDirs> {
    const map = new Map<string, JointDirs>();
    if (!layout) return map;
    const objects = layout.objects ?? [];
    const walls = objects.filter(o => o.type === 'wall');
    if (walls.length === 0) return map;

    const addDir = (x: number, y: number, dir: keyof JointDirs) => {
      const key = `${x},${y}`;
      const existing = map.get(key) ?? {};
      (existing as any)[dir] = true;
      map.set(key, existing);
    };

    for (const w of walls) {
      const horizontal = w.spanX >= w.spanY;
      if (horizontal) {
        const y = w.gridY;
        const x0 = w.gridX;
        const x1 = w.gridX + w.spanX;
        addDir(x0, y, 'E');
        addDir(x1, y, 'W');
      } else {
        const x = w.gridX;
        const y0 = w.gridY;
        const y1 = w.gridY + w.spanY;
        addDir(x, y0, 'S');
        addDir(x, y1, 'N');
      }
    }

    return map;
  }

  function isJunction(endpointMap: Map<string, JointDirs>, x: number, y: number): boolean {
    const dirs = endpointMap.get(`${x},${y}`);
    if (!dirs) return false;
    return Object.values(dirs).filter(Boolean).length >= 2;
  }

  // Snap wall/door endpoints to other wall endpoints when moving existing objects.
  // This keeps walls "connected" visually and makes editing feel pro.
  function snapObjectToWalls(
    layout: FloorLayout,
    movingObj: FloorObject,
    proposedX: number,
    proposedY: number,
  ): { x: number; y: number } {
    const objects = layout.objects ?? [];
    const otherWalls = objects.filter(o => o.type === 'wall' && o.id !== movingObj.id);
    if (otherWalls.length === 0) return { x: proposedX, y: proposedY };

    type Seg = { kind: 'h' | 'v'; x0: number; y0: number; x1: number; y1: number };
    const segs: Seg[] = [];

    // Build wall segments (in grid units)
    for (const w of otherWalls) {
      const horizontal = w.spanX >= w.spanY;
      if (horizontal) {
        segs.push({ kind: 'h', x0: w.gridX, y0: w.gridY, x1: w.gridX + w.spanX, y1: w.gridY });
      } else {
        segs.push({ kind: 'v', x0: w.gridX, y0: w.gridY, x1: w.gridX, y1: w.gridY + w.spanY });
      }
    }

    // Collect candidate snap targets:
    // 1) endpoints
    // 2) projections onto segments (line snapping)
    // 3) intersections of H/V segments (corner snapping)
    const targets: Array<{ x: number; y: number }> = [];

    const pushTarget = (x: number, y: number) => {
      targets.push({ x, y });
    };

    for (const s of segs) {
      pushTarget(s.x0, s.y0);
      pushTarget(s.x1, s.y1);
    }

    // Intersections (corner snapping)
    const hSegs = segs.filter(s => s.kind === 'h');
    const vSegs = segs.filter(s => s.kind === 'v');
    for (const h of hSegs) {
      const hx0 = Math.min(h.x0, h.x1);
      const hx1 = Math.max(h.x0, h.x1);
      const hy = h.y0;
      for (const v of vSegs) {
        const vy0 = Math.min(v.y0, v.y1);
        const vy1 = Math.max(v.y0, v.y1);
        const vx = v.x0;
        if (vx >= hx0 && vx <= hx1 && hy >= vy0 && hy <= vy1) {
          pushTarget(vx, hy);
        }
      }
    }

    // Moving endpoints at proposed location.
    const movingSpanX = movingObj.spanX;
    const movingSpanY = movingObj.spanY;
    const movingIsHoriz = movingSpanX >= movingSpanY;
    const movingEndpoints = movingIsHoriz
      ? [
          { x: proposedX, y: proposedY },
          { x: proposedX + movingSpanX, y: proposedY },
        ]
      : [
          { x: proposedX, y: proposedY },
          { x: proposedX, y: proposedY + movingSpanY },
        ];

    // Line snapping: add projections of moving endpoints onto segments (if close enough)
    // We do it here so we can use the endpoint y/x for projection.
    for (const me of movingEndpoints) {
      for (const s of segs) {
        if (s.kind === 'h') {
          const y = s.y0;
          const xMin = Math.min(s.x0, s.x1);
          const xMax = Math.max(s.x0, s.x1);
          const clampedX = Math.min(xMax, Math.max(xMin, me.x));
          pushTarget(clampedX, y);
        } else {
          const x = s.x0;
          const yMin = Math.min(s.y0, s.y1);
          const yMax = Math.max(s.y0, s.y1);
          const clampedY = Math.min(yMax, Math.max(yMin, me.y));
          pushTarget(x, clampedY);
        }
      }
    }

    // --- Stage 7 snapping upgrades ---
    // 1) Parallel snapping: align to the same axis value of nearby walls
    // 2) Collision avoidance: prevent colinear overlapping segments (looks messy)

    type Move = { dx: number; dy: number; score: number };

    const SNAP_DIST = 1; // endpoint/line/corner snapping radius (grid units)
    const PARALLEL_DIST = 2; // a bit looser for "parallel" alignment

    const moves: Move[] = [];

    // Helper: build a segment for a wall-like object at a given (x,y)
    const segFor = (obj: FloorObject, x: number, y: number): Seg => {
      const horiz = obj.spanX >= obj.spanY;
      return horiz
        ? { kind: 'h', x0: x, y0: y, x1: x + obj.spanX, y1: y }
        : { kind: 'v', x0: x, y0: y, x1: x, y1: y + obj.spanY };
    };

    // Helper: colinear overlap check (allow touching at endpoints)
    const overlapsColinear = (a: Seg, b: Seg): boolean => {
      if (a.kind !== b.kind) return false;
      if (a.kind === 'h') {
        if (a.y0 !== b.y0) return false;
        const a0 = Math.min(a.x0, a.x1);
        const a1 = Math.max(a.x0, a.x1);
        const b0 = Math.min(b.x0, b.x1);
        const b1 = Math.max(b.x0, b.x1);
        const overlap = Math.min(a1, b1) - Math.max(a0, b0);
        return overlap > 0; // >0 means real overlap; 0 means just touching
      }
      // vertical
      if (a.x0 !== b.x0) return false;
      const a0 = Math.min(a.y0, a.y1);
      const a1 = Math.max(a.y0, a.y1);
      const b0 = Math.min(b.y0, b.y1);
      const b1 = Math.max(b.y0, b.y1);
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      return overlap > 0;
    };

    const wouldOverlapAny = (x: number, y: number): boolean => {
      const ms = segFor(movingObj, x, y);
      for (const s of segs) {
        if (overlapsColinear(ms, s)) return true;
      }
      return false;
    };

    // 1) Standard snapping (endpoint/line/corner): collect translation candidates
    for (const me of movingEndpoints) {
      for (const t of targets) {
        const dx = t.x - me.x;
        const dy = t.y - me.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= SNAP_DIST) {
          moves.push({ dx, dy, score: d });
        }
      }
    }

    // 2) Parallel snapping: align the moving segment to nearby segments of same orientation.
    const movingSeg = segFor(movingObj, proposedX, proposedY);
    for (const s of segs) {
      if (s.kind !== movingSeg.kind) continue;
      if (movingSeg.kind === 'h') {
        const dy = s.y0 - movingSeg.y0;
        const d = Math.abs(dy);
        if (d <= PARALLEL_DIST) {
          moves.push({ dx: 0, dy, score: d + 0.15 }); // slight penalty vs exact endpoint snaps
        }
      } else {
        const dx = s.x0 - movingSeg.x0;
        const d = Math.abs(dx);
        if (d <= PARALLEL_DIST) {
          moves.push({ dx, dy: 0, score: d + 0.15 });
        }
      }
    }

    if (moves.length === 0) return { x: proposedX, y: proposedY };

    // Choose the best move that does NOT create colinear overlaps.
    moves.sort((a, b) => a.score - b.score);

    const maxX = Math.max(0, layout.gridCols - movingSpanX);
    const maxY = Math.max(0, layout.gridRows - movingSpanY);

    for (const m of moves) {
      const x0 = Math.min(maxX, Math.max(0, proposedX + m.dx));
      const y0 = Math.min(maxY, Math.max(0, proposedY + m.dy));
      if (!wouldOverlapAny(x0, y0)) {
        return { x: x0, y: y0 };
      }
    }

    // If every snap candidate overlaps, fall back to clamped proposed position.
    return {
      x: Math.min(maxX, Math.max(0, proposedX)),
      y: Math.min(maxY, Math.max(0, proposedY)),
    };
  }

  // ----------------------------------------
  // Stage 8: Smart offset snapping + collisions
  // ----------------------------------------
  // In real restaurants, tables and furniture typically keep a small clearance
  // from walls (like the reference UI). This adds:
  // - Offset snapping: align an item's edge to be OFFSET cells away from a wall.
  // - Collision guard: prevent overlapping rectangles between tables/furniture.

  type Seg = { kind: 'h' | 'v'; x0: number; y0: number; x1: number; y1: number };

  function buildWallSegments(layout: FloorLayout): Seg[] {
    const objects = layout.objects ?? [];
    const walls = objects.filter(o => o.type === 'wall');
    const segs: Seg[] = [];
    for (const w of walls) {
      const horiz = w.spanX >= w.spanY;
      if (horiz) {
        segs.push({ kind: 'h', x0: w.gridX, y0: w.gridY, x1: w.gridX + w.spanX, y1: w.gridY });
      } else {
        segs.push({ kind: 'v', x0: w.gridX, y0: w.gridY, x1: w.gridX, y1: w.gridY + w.spanY });
      }
    }
    return segs;
  }

  function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function wouldCollide(
    layout: FloorLayout,
    ignoreKind: 'table' | 'object',
    ignoreId: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): boolean {
    const test = { x, y, w, h };
    // Tables collide with tables + non-wall objects.
    for (const t of layout.tables) {
      if (ignoreKind === 'table' && t.id === ignoreId) continue;
      if (rectsOverlap(test, { x: t.gridX, y: t.gridY, w: t.spanX, h: t.spanY })) return true;
    }

    const objects = layout.objects ?? [];
    for (const o of objects) {
      if (ignoreKind === 'object' && o.id === ignoreId) continue;
      // Allow walls to "pass through" other walls (they are handled separately).
      if (o.type === 'wall') continue;
      if (rectsOverlap(test, { x: o.gridX, y: o.gridY, w: o.spanX, h: o.spanY })) return true;
    }
    return false;
  }

  function clampToBounds(layout: FloorLayout, x: number, y: number, w: number, h: number): { x: number; y: number } {
    const maxX = Math.max(0, layout.gridCols - Math.max(1, w));
    const maxY = Math.max(0, layout.gridRows - Math.max(1, h));
    return {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(0, Math.min(maxY, y)),
    };
  }

  function snapRectToWallOffset(
    layout: FloorLayout,
    proposedX: number,
    proposedY: number,
    spanX: number,
    spanY: number,
  ): { x: number; y: number } {
    const segs = buildWallSegments(layout);
    if (segs.length === 0) return { x: proposedX, y: proposedY };

    const OFFSET = 1; // keep 1 grid cell clearance from walls
    const SNAP_DIST = 2; // how close we need to be to snap

    let best: { x: number; y: number; score: number } | null = null;

    const cx = proposedX + spanX / 2;
    const cy = proposedY + spanY / 2;

    for (const s of segs) {
      if (s.kind === 'h') {
        const yWall = s.y0;
        // distance from wall to nearest rect edge vertically
        const dTop = Math.abs(yWall - proposedY);
        const dBottom = Math.abs(yWall - (proposedY + spanY));
        const d = Math.min(dTop, dBottom);
        if (d > SNAP_DIST) continue;

        // Only consider if x-range overlaps wall range (with a little slack)
        const xMin = Math.min(s.x0, s.x1);
        const xMax = Math.max(s.x0, s.x1);
        const rectMin = proposedX;
        const rectMax = proposedX + spanX;
        const overlap = Math.min(xMax, rectMax) - Math.max(xMin, rectMin);
        if (overlap < 0.25) continue;

        // Choose side based on center
        const placeBelow = cy >= yWall;
        const y = placeBelow ? (yWall + OFFSET) : (yWall - OFFSET - spanY);
        const candidate = clampToBounds(layout, proposedX, y, spanX, spanY);
        const score = d + 0.25; // slight penalty vs other snaps
        if (!best || score < best.score) best = { x: candidate.x, y: candidate.y, score };
      } else {
        const xWall = s.x0;
        const dLeft = Math.abs(xWall - proposedX);
        const dRight = Math.abs(xWall - (proposedX + spanX));
        const d = Math.min(dLeft, dRight);
        if (d > SNAP_DIST) continue;

        const yMin = Math.min(s.y0, s.y1);
        const yMax = Math.max(s.y0, s.y1);
        const rectMin = proposedY;
        const rectMax = proposedY + spanY;
        const overlap = Math.min(yMax, rectMax) - Math.max(yMin, rectMin);
        if (overlap < 0.25) continue;

        const placeRight = cx >= xWall;
        const x = placeRight ? (xWall + OFFSET) : (xWall - OFFSET - spanX);
        const candidate = clampToBounds(layout, x, proposedY, spanX, spanY);
        const score = d + 0.25;
        if (!best || score < best.score) best = { x: candidate.x, y: candidate.y, score };
      }
    }

    if (!best) return { x: proposedX, y: proposedY };
    return { x: best.x, y: best.y };
  }

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
    opts?: { shape?: string; objectType?: FloorObject['type']; tableId?: string; objectId?: string }
  ) => {
    setDraggedItem({ kind, mode, ...opts });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = (e: React.DragEvent, gridX: number, gridY: number) => {
    e.preventDefault();

    if (!draggedItem || !currentLayout) return;

    // Drop NEW table
    if (draggedItem.kind === 'table' && draggedItem.mode === 'new' && draggedItem.shape) {
      // Apply Stage 8 snapping (offset-to-wall) and collision guard.
      const spanX = draggedItem.shape === 'rect' || draggedItem.shape === 'booth' ? 2 : 1;
      const spanY = 1;
      let pos = snapRectToWallOffset(currentLayout, gridX, gridY, spanX, spanY);
      pos = clampToBounds(currentLayout, pos.x, pos.y, spanX, spanY);
      // If placement collides, keep original drop position (clamped). If still collides, do not place.
      if (wouldCollide(currentLayout, 'table', '__new__', pos.x, pos.y, spanX, spanY)) {
        const fallback = clampToBounds(currentLayout, gridX, gridY, spanX, spanY);
        if (wouldCollide(currentLayout, 'table', '__new__', fallback.x, fallback.y, spanX, spanY)) {
          setDraggedItem(null);
          return;
        }
        pos = fallback;
      }

      const newTable: FloorTable = {
        id: `T${Date.now()}`,
        name: `Table ${nextTableNumber}`,
        tableNumber: nextTableNumber,
        gridX: pos.x,
        gridY: pos.y,
        spanX,
        spanY,
        seats: draggedItem.shape === 'booth' ? 4 : 2,
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
      if (!moving) {
        setDraggedItem(null);
        return;
      }
      // Offset snap to walls for a clean, spaced layout.
      let pos = snapRectToWallOffset(currentLayout, gridX, gridY, moving.spanX, moving.spanY);
      pos = clampToBounds(currentLayout, pos.x, pos.y, moving.spanX, moving.spanY);
      // Collision guard: if collides, keep original position.
      if (wouldCollide(currentLayout, 'table', moving.id, pos.x, pos.y, moving.spanX, moving.spanY)) {
        setDraggedItem(null);
        return;
      }

      setCurrentLayout({
        ...currentLayout,
        tables: currentLayout.tables.map(t =>
          t.id === moving.id ? { ...t, gridX: pos.x, gridY: pos.y } : t
        )
      });
    }

    // Drop NEW object
    else if (draggedItem.kind === 'object' && draggedItem.mode === 'new' && draggedItem.objectType) {
      const objects = currentLayout.objects ?? [];

      // reasonable defaults per object type
      const defaults: Record<string, { spanX: number; spanY: number; rotation?: 0|90|180|270; label?: string }> = {
        wall: { spanX: 3, spanY: 1, rotation: 0 },
        divider: { spanX: 2, spanY: 1, rotation: 0 },
        door: { spanX: 1, spanY: 1, rotation: 0, label: 'Door' },
        bar: { spanX: 3, spanY: 2, rotation: 0, label: 'Bar' },
        plant: { spanX: 1, spanY: 1, rotation: 0, label: '' },
        booth: { spanX: 2, spanY: 2, rotation: 0, label: 'Booth' },
        sofa: { spanX: 2, spanY: 1, rotation: 0, label: 'Sofa' },
      };

      const d = defaults[String(draggedItem.objectType)] ?? { spanX: 1, spanY: 1 };

      // Stage 8: snap furniture to wall offset, and avoid collisions.
      let pos = { x: gridX, y: gridY };
      if (draggedItem.objectType !== 'wall' && draggedItem.objectType !== 'door') {
        pos = snapRectToWallOffset(currentLayout, gridX, gridY, d.spanX, d.spanY);
        pos = clampToBounds(currentLayout, pos.x, pos.y, d.spanX, d.spanY);
        if (wouldCollide(currentLayout, 'object', '__new__', pos.x, pos.y, d.spanX, d.spanY)) {
          // Try raw drop as fallback; if still collides, cancel.
          const fallback = clampToBounds(currentLayout, gridX, gridY, d.spanX, d.spanY);
          if (wouldCollide(currentLayout, 'object', '__new__', fallback.x, fallback.y, d.spanX, d.spanY)) {
            setDraggedItem(null);
            return;
          }
          pos = fallback;
        }
      }

      const newObj: FloorObject = {
        id: `O${Date.now()}`,
        type: draggedItem.objectType,
        gridX: pos.x,
        gridY: pos.y,
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

    // Move EXISTING object (with smart snapping for walls/doors)
    else if (draggedItem.kind === 'object' && draggedItem.mode === 'existing' && draggedItem.objectId) {
      const objects = currentLayout.objects ?? [];
      const moving = objects.find(o => o.id === draggedItem.objectId);

      if (!moving) {
        setDraggedItem(null);
        return;
      }

      // Default placement is the drop cell.
      let nx = gridX;
      let ny = gridY;

      if (moving.type === 'wall' || moving.type === 'door') {
        // Use the advanced snapping logic (endpoint/line/corner/parallel + overlap guard).
        const snapped = snapObjectToWalls(currentLayout, moving, nx, ny);
        nx = snapped.x;
        ny = snapped.y;
      } else {
        // Furniture: keep clean clearance from walls + prevent overlaps with other items.
        const snapped = snapRectToWallOffset(currentLayout, nx, ny, moving.spanX, moving.spanY);
        nx = snapped.x;
        ny = snapped.y;
        const clamped = clampToBounds(currentLayout, nx, ny, moving.spanX, moving.spanY);
        nx = clamped.x;
        ny = clamped.y;
        if (wouldCollide(currentLayout, 'object', moving.id, nx, ny, moving.spanX, moving.spanY)) {
          setDraggedItem(null);
          return;
        }
      }

      setCurrentLayout({
        ...currentLayout,
        objects: objects.map(o => o.id === moving.id ? { ...o, gridX: nx, gridY: ny } : o)
      });
    }

    setDraggedItem(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
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

  // Precompute wall connectivity for styling (caps) and junction overlay.
  const wallEndpointMap = computeWallEndpointMap(currentLayout);
  const wallJoints = computeWallJoints(currentLayout);

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
            </div>
          )}

          <h2>🎨 Palette</h2>
          <div className="palette">
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'round' })}>
              <div className="preview round">🪑</div>
              <span>2-Seat Round</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square' })}>
              <div className="preview square">🪑</div>
              <span>4-Seat Square</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'rect' })}>
              <div className="preview rect">🪑</div>
              <span>6-Seat Rect</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'booth' })}>
              <div className="preview booth">🛋️</div>
              <span>Booth</span>
            </div>
          </div>

          <h2 style={{ marginTop: 18 }}>🏗️ Elements</h2>
          <div className="palette">
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'wall' })}>
              <div className="preview preview-obj preview-wall" aria-hidden="true" />
              <span>Wall</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'door' })}>
              <div className="preview preview-obj preview-door" aria-hidden="true" />
              <span>Door</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'bar' })}>
              <div className="preview preview-obj preview-bar" aria-hidden="true" />
              <span>Bar</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'booth' })}>
              <div className="preview preview-obj preview-booth" aria-hidden="true" />
              <span>Booth</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'sofa' })}>
              <div className="preview preview-obj preview-sofa" aria-hidden="true" />
              <span>Sofa</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'plant' })}>
              <div className="preview preview-obj preview-plant" aria-hidden="true" />
              <span>Plant</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider' })}>
              <div className="preview preview-obj preview-divider" aria-hidden="true" />
              <span>Divider</span>
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
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={selectedTable.seats}
                  onChange={(e) => updateTable(selectedTable.id, { seats: Number(e.target.value) })}
                />
              </label>
              <label>
                Shape:
                <select
                  value={selectedTable.shape}
                  onChange={(e) => updateTable(selectedTable.id, { shape: e.target.value as any })}
                >
                  <option value="round">Round</option>
                  <option value="square">Square</option>
                  <option value="rect">Rect</option>
                  <option value="booth">Booth</option>
                </select>
              </label>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ flex: 1 }}>
                  Width:
                  <input
                    type="number"
                    min="1"
                    max="4"
                    value={selectedTable.spanX}
                    onChange={(e) => updateTable(selectedTable.id, { spanX: Math.max(1, Math.min(4, Number(e.target.value))) })}
                  />
                </label>
                <label style={{ flex: 1 }}>
                  Height:
                  <input
                    type="number"
                    min="1"
                    max="3"
                    value={selectedTable.spanY}
                    onChange={(e) => updateTable(selectedTable.id, { spanY: Math.max(1, Math.min(3, Number(e.target.value))) })}
                  />
                </label>
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

        <div className="editor-canvas">
          <div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${currentLayout.gridCols}, 60px)`,
              gridTemplateRows: `repeat(${currentLayout.gridRows}, 60px)`
            }}
          >
            {/* Wall joints overlay */}
            {wallJoints.map((j) => {
              const dirs = j.dirs;
              const dirKeys = ['N', 'E', 'S', 'W'] as const;
              const active = dirKeys.filter(k => Boolean(dirs[k]));
              const cls = `wall-joint ${active.map(k => `d-${k.toLowerCase()}`).join(' ')}`;
              // grid has 10px padding in CSS
              const padding = 10;
              const size = 14;
              const left = padding + j.gridX * CELL_PX - size / 2;
              const top = padding + j.gridY * CELL_PX - size / 2;
              return (
                <div
                  key={j.key}
                  className={cls}
                  style={{ left, top, width: size, height: size }}
                />
              );
            })}
            {Array.from({ length: currentLayout.gridRows * currentLayout.gridCols }).map((_, i) => {
              const gridY = Math.floor(i / currentLayout.gridCols);
              const gridX = i % currentLayout.gridCols;

              const tableHere = currentLayout.tables.find(t =>
                gridX >= t.gridX && gridX < t.gridX + t.spanX &&
                gridY >= t.gridY && gridY < t.gridY + t.spanY
              );

              const objects = currentLayout.objects ?? [];
              const objectHere = objects.find(o =>
                gridX >= o.gridX && gridX < o.gridX + o.spanX &&
                gridY >= o.gridY && gridY < o.gridY + o.spanY
              );

                            const objOrient = objectHere ? (objectHere.spanX >= objectHere.spanY ? 'orient-h' : 'orient-v') : '';

const isTopLeft = tableHere && tableHere.gridX === gridX && tableHere.gridY === gridY;
              const isObjTopLeft = objectHere && objectHere.gridX === gridX && objectHere.gridY === gridY;

              return (
                <div
                  key={i}
                  className="grid-cell"
                  onDrop={(e) => handleDrop(e, gridX, gridY)}
                  onDragOver={handleDragOver}
                >
                  {isObjTopLeft && objectHere && (
                    <div
                      className={`floor-object type-${objectHere.type} ${(['wall','door'].includes(objectHere.type) ? objOrient : '')} ${selectedObject?.id === objectHere.id ? 'selected' : ''}`}
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
                      {objectHere.type === 'wall' && (() => {
                        const horizontal = objectHere.spanX >= objectHere.spanY;
                        const sx = objectHere.gridX;
                        const sy = objectHere.gridY;
                        const ex = horizontal ? objectHere.gridX + objectHere.spanX : objectHere.gridX;
                        const ey = horizontal ? objectHere.gridY : objectHere.gridY + objectHere.spanY;
                        const startIsJ = isJunction(wallEndpointMap, sx, sy);
                        const endIsJ = isJunction(wallEndpointMap, ex, ey);
                        return (
                          <div className="obj-wall">
                            <span className={`obj-wall-cap left ${startIsJ ? 'cap-hidden' : ''}`} />
                            <span className="obj-wall-body" />
                            <span className={`obj-wall-cap right ${endIsJ ? 'cap-hidden' : ''}`} />
                          </div>
                        );
                      })()}
                      {objectHere.type === 'door' && (
                        <div className="obj-door">
                          <span className="obj-door-frame" />
                          <span className="obj-door-swing" />
                        </div>
                      )}
                      {!(objectHere.type === 'wall' || objectHere.type === 'door') && (
                        <div className="obj-furniture" aria-hidden="true" />
                      )}
                      {objectHere.label && <div className="obj-label">{objectHere.label}</div>}
                    </div>
                  )}
                  {isTopLeft && (
                    <div
                      className={`table ${tableHere.shape} ${selectedTable?.id === tableHere.id ? 'selected' : ''}`}
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
                      <div className="table-badge">{tableHere.tableNumber}</div>
                      <div className="table-meta">
                        <div className="table-name">{tableHere.name}</div>
                        <div className="table-seats">{tableHere.seats} seats</div>
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
