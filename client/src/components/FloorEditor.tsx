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
  // Stored as JSON; keep union flexible for new asset types.
  type: 'wall' | 'door' | 'bar' | 'plant' | 'divider' | 'chair';
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
    seats?: number; // for tables
    objectType?: FloorObject['type'];
    variant?: string; // for objects (stored as label)
    tableId?: string;
    objectId?: string;
  } | null>(null);
  const [nextTableNumber, setNextTableNumber] = useState(1);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');
  const [showOnlyActiveSection, setShowOnlyActiveSection] = useState(false);
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);

  const ASSET_BASE = '/static/floor_assets/';

  // =============================================================
  // Asset architecture (clean & consistent)
  // - One source of truth for default sizes (grid spans)
  // - Visual size follows logical size (no extra ad-hoc scaling)
  // - Variants are stored in object.label (e.g., wall_h / wall_v)
  // =============================================================
  const BASE_TABLE_UNIT = 2; // Table for 2 = 2x2. Table for 4 = 4x4, etc.

  const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

  const tableSpanFor = (shape: string, seats: number) => {
    const s = String(shape || 'square').toLowerCase();
    const n = Math.max(2, Number(seats || 2));

    // Requested ratio: 4-seat table length = 2x of 2-seat. So spans scale linearly by (seats/2).
    const k = Math.max(1, n / 2);

    if (s === 'booth') {
      // Sofas / booths: wide, not perfectly square.
      const w = clampInt(BASE_TABLE_UNIT * k, 2, 12);
      const h = clampInt(Math.max(2, BASE_TABLE_UNIT), 2, 6);
      return { spanX: w, spanY: h };
    }

    const span = clampInt(BASE_TABLE_UNIT * k, 2, 12);
    return { spanX: span, spanY: span };
  };

  const objectSpanFor = (type: FloorObject['type'], variant?: string) => {
    const v = String(variant || '').toLowerCase();
    if (type === 'bar') return { spanX: 5, spanY: 2 };
    if (type === 'door') return { spanX: 1, spanY: 1 };
    if (type === 'plant') return { spanX: 1, spanY: 1 };
    if (type === 'chair') return { spanX: 1, spanY: 1 };

    if (type === 'wall') {
      if (v === 'wall_v') return { spanX: 1, spanY: 6 };
      return { spanX: 6, spanY: 1 }; // wall_h default
    }

    // divider variants
    if (type === 'divider') {
      if (v === 'divider_round') return { spanX: 2, spanY: 2 };
      if (v === 'divider_corner') return { spanX: 1, spanY: 1 };
      if (v === 'divider_v') return { spanX: 1, spanY: 5 };
      return { spanX: 5, spanY: 1 }; // divider_h default
    }

    return { spanX: 1, spanY: 1 };
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


  const assetForObject = (type: FloorObject['type'], spanX: number, spanY: number, variant?: string) => {
    if (type === 'door') return `${ASSET_BASE}door.svg`;
    if (type === 'bar') return `${ASSET_BASE}bar.svg`;
    if (type === 'plant') return `${ASSET_BASE}plant.svg`;
    if (type === 'chair') return `${ASSET_BASE}chair.svg`;

    // Walls are drawn with clean CSS (more consistent, crisp, and scalable)
    if (type === 'wall') return '';

    // Divider variants
    const v = String(variant || '').toLowerCase();
    if (v === 'divider_round') return `${ASSET_BASE}cyclic_partition.svg`;
    if (v === 'divider_corner') return `${ASSET_BASE}corner_partitaion.svg`;
    if (v === 'divider_v') return `${ASSET_BASE}vertical_partition.svg`;
    if (v === 'divider_h') return `${ASSET_BASE}horizintal_partitaion.svg`;

    // Fallback based on aspect
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
    opts?: { shape?: string; seats?: number; objectType?: FloorObject['type']; variant?: string; tableId?: string; objectId?: string }
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

  const snapPlacement = (x: number, y: number, spanX: number, spanY: number, kind: 'table' | 'object', subtype?: string, disableSnap?: boolean) => {
    // Always clamp
    const base = clampToGrid(x, y, spanX, spanY);
    if (disableSnap) return base;
    // For furniture that visually "wants" to hug a wall (booth / bar), snap to nearby walls.
    const wantsWallSnap = (kind === 'table' && String(subtype).toLowerCase() === 'booth') || (kind === 'object' && (subtype === 'bar' || subtype === 'door'));
    if (wantsWallSnap) return snapToNearbyWalls(base.x, base.y, spanX, spanY);
    return base;
  };

  const handleDrop = (e: React.DragEvent, gridX: number, gridY: number) => {
    e.preventDefault();

    if (!draggedItem || !currentLayout) return;

    // Shift = temporarily disable smart snapping
    const disableSnap = Boolean((e as any).shiftKey);

    // Drop NEW table
    if (draggedItem.kind === 'table' && draggedItem.mode === 'new' && draggedItem.shape) {
      const seats = Number(draggedItem.seats || (draggedItem.shape === 'booth' ? 4 : 2));
      const { spanX: initialSpanX, spanY: initialSpanY } = tableSpanFor(draggedItem.shape, seats);
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
      const snapped = snapPlacement(gridX, gridY, moving.spanX || 1, moving.spanY || 1, 'table', moving.shape, disableSnap);
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

      const variant = draggedItem.variant;
      const d = objectSpanFor(draggedItem.objectType, variant);
      const snapped = snapPlacement(gridX, gridY, d.spanX, d.spanY, 'object', draggedItem.objectType, disableSnap);
      const newObj: FloorObject = {
        id: `O${Date.now()}`,
        type: draggedItem.objectType,
        gridX: snapped.x,
        gridY: snapped.y,
        spanX: d.spanX,
        spanY: d.spanY,
        rotation: 0,
        label: variant || '',
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
      const snapped = snapPlacement(gridX, gridY, moving.spanX || 1, moving.spanY || 1, 'object', moving.type, disableSnap);
      setCurrentLayout({
        ...currentLayout,
        objects: objects.map(o => o.id === draggedItem.objectId ? { ...o, gridX: snapped.x, gridY: snapped.y } : o)
      });
    }

    setDraggedItem(null);
    setHoverCell(null);
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
            {/* Square tables */}
            {[2,4,6,8,10].map((seats) => (
              <div key={`sq-${seats}`} className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'square', seats })}>
                <div className="preview"><img className="preview-img" src={assetForTable('square', seats)} alt="" /></div>
                <span>Square · {seats}</span>
              </div>
            ))}

            {/* Round tables */}
            {[4,10].map((seats) => (
              <div key={`rd-${seats}`} className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'round', seats })}>
                <div className="preview"><img className="preview-img" src={assetForTable('round', seats)} alt="" /></div>
                <span>Round · {seats}</span>
              </div>
            ))}

            {/* Sofas (implemented as booths) */}
            {[2,4].map((seats) => (
              <div key={`sofa-${seats}`} className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'table', 'new', { shape: 'booth', seats })}>
                <div className="preview"><img className="preview-img" src={assetForTable('booth', seats)} alt="" /></div>
                <span>Sofa · {seats}</span>
              </div>
            ))}
          </div>

          <h2 style={{ marginTop: 18 }}>🏗️ Elements</h2>
          <div className="palette">
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'bar' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('bar', 5, 2)} alt="" /></div>
              <span>Bar · 5</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'chair' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('chair', 1, 1)} alt="" /></div>
              <span>Chair</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'door' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('door', 1, 1)} alt="" /></div>
              <span>Door</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider', variant: 'divider_h' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 5, 1, 'divider_h')} alt="" /></div>
              <span>Partition</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider', variant: 'divider_round' })}>
              <div className="preview"><img className="preview-img" src={assetForObject('divider', 2, 2, 'divider_round')} alt="" /></div>
              <span>Round Partition</span>
            </div>

            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'wall', variant: 'wall_h' })}>
              <div className="preview fe-wall-preview" />
              <span>Wall · Horizontal</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'wall', variant: 'wall_v' })}>
              <div className="preview fe-wall-preview fe-wall-preview-v" />
              <span>Wall · Vertical</span>
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
            {(() => {
              // Drop preview: shows where the dragged item will land (with snapping)
              if (!hoverCell || !draggedItem || !currentLayout) return null;
              const cellPx = 60;
              const padPx = 10;

              const spanFromDragged = () => {
                if (draggedItem.kind === 'table') {
                  if (draggedItem.mode === 'new') {
                    const sh = String(draggedItem.shape || 'square');
                    return { spanX: (sh === 'rect' || sh === 'booth') ? 2 : 1, spanY: 1, subtype: sh };
                  }
                  const t = currentLayout.tables.find(tt => tt.id === draggedItem.tableId);
                  if (t) return { spanX: t.spanX || 1, spanY: t.spanY || 1, subtype: t.shape };
                }
                if (draggedItem.kind === 'object') {
                  if (draggedItem.mode === 'new') {
                    const defaults: Record<string, { spanX: number; spanY: number }> = {
                      wall: { spanX: 3, spanY: 1 },
                      divider: { spanX: 2, spanY: 1 },
                      door: { spanX: 1, spanY: 1 },
                      bar: { spanX: 3, spanY: 2 },
                      plant: { spanX: 1, spanY: 1 },
                    };
                    const d = defaults[String(draggedItem.objectType)] || { spanX: 1, spanY: 1 };
                    return { spanX: d.spanX, spanY: d.spanY, subtype: draggedItem.objectType };
                  }
                  const o = (currentLayout.objects ?? []).find(oo => oo.id === draggedItem.objectId);
                  if (o) return { spanX: o.spanX || 1, spanY: o.spanY || 1, subtype: o.type };
                }
                return { spanX: 1, spanY: 1, subtype: '' };
              };

              const { spanX, spanY, subtype } = spanFromDragged();
              // Use snapping logic (same as onDrop). Shift disables snap.
              const snapped = snapPlacement(hoverCell.x, hoverCell.y, spanX, spanY, draggedItem.kind, String(subtype), false);
              const left = padPx + snapped.x * cellPx;
              const top = padPx + snapped.y * cellPx;

              return (
                <div
                  className="fe-drop-preview"
                  style={{
                    left,
                    top,
                    width: spanX * cellPx,
                    height: spanY * cellPx,
                  }}
                />
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
                  onDrop={(e) => handleDrop(e, gridX, gridY)}
                  onDragOver={handleDragOver}
                  onDragEnter={() => setHoverCell({ x: gridX, y: gridY })}
                  onDragLeave={() => setHoverCell(null)}
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
                        width: `calc(${(objectHere.spanX || 1) * 100}% + ${Math.max(0, (objectHere.spanX || 1) - 1) * 2}px)`,
                        height: `calc(${(objectHere.spanY || 1) * 100}% + ${Math.max(0, (objectHere.spanY || 1) - 1) * 2}px)`,
                        transform: `rotate(${objectHere.rotation ?? 0}deg)`,
                      }}
                    >
                      {objectHere.type === 'wall' ? (
                        <div className={`fe-wall ${String(objectHere.label || 'wall_h')}`} />
                      ) : (
                        <img className="fe-asset" src={assetForObject(objectHere.type, objectHere.spanX, objectHere.spanY, objectHere.label)} alt="" />
                      )}
                      {objectHere.label && !/^wall_|^divider_/.test(String(objectHere.label)) && <div className="obj-label">{objectHere.label}</div>}
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
                        width: `calc(${(tableHere.spanX || 1) * 100}% + ${Math.max(0, (tableHere.spanX || 1) - 1) * 2}px)`,
                        height: `calc(${(tableHere.spanY || 1) * 100}% + ${Math.max(0, (tableHere.spanY || 1) - 1) * 2}px)`,
                      }}
                    >
                      <div className="fe-table-visual">
                        <img className="fe-asset" src={assetForTable(tableHere.shape, tableHere.seats)} alt="" />
                        {tableHere.shape !== 'booth' && (
                          <div className="fe-chairs" aria-hidden="true">
                            {Array.from({ length: Math.min(10, Math.max(0, tableHere.seats)) }).map((_, idx, arr) => {
                              const n = arr.length || 1;
                              const a = (Math.PI * 2 * idx) / n;
                              const x = 50 + 44 * Math.cos(a);
                              const y = 50 + 44 * Math.sin(a);
                              const deg = (a * 180 / Math.PI) + 90;
                              return (
                                <div
                                  key={idx}
                                  className="fe-chair"
                                  style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -50%) rotate(${deg}deg)` }}
                                />
                              );
                            })}
                          </div>
                        )}
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
