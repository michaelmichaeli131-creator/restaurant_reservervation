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

  // --- Canvas interaction (Stage E1): pan/zoom foundation ---
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number; px: number; py: number } | null>(null);

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const zoomBy = (delta: number) => {
    setZoom(z => clamp(Number((z + delta).toFixed(3)), 0.35, 2.2));
  };

  const centerView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
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
      const newTable: FloorTable = {
        id: `T${Date.now()}`,
        name: `Table ${nextTableNumber}`,
        tableNumber: nextTableNumber,
        gridX,
        gridY,
        spanX: draggedItem.shape === 'rect' || draggedItem.shape === 'booth' ? 2 : 1,
        spanY: 1,
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
      setCurrentLayout({
        ...currentLayout,
        tables: currentLayout.tables.map(t =>
          t.id === draggedItem.tableId ? { ...t, gridX, gridY } : t
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
      };

      const d = defaults[String(draggedItem.objectType)] ?? { spanX: 1, spanY: 1 };

      const newObj: FloorObject = {
        id: `O${Date.now()}`,
        type: draggedItem.objectType,
        gridX,
        gridY,
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
      setCurrentLayout({
        ...currentLayout,
        objects: objects.map(o => o.id === draggedItem.objectId ? { ...o, gridX, gridY } : o)
      });
    }

    setDraggedItem(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleCanvasWheel = (e: React.WheelEvent) => {
    // Trackpads often send pinch-zoom as ctrlKey+wheel
    if (e.ctrlKey) {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      zoomBy(dir * 0.08);
    }
  };

  const startPan = (e: React.MouseEvent) => {
    // Pan with middle click OR holding Space OR holding Shift
    // (keeps normal left-click selection working)
    if (e.button === 1 || e.shiftKey || (e as any).nativeEvent?.code === 'Space') {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
    }
  };

  const movePan = (e: React.MouseEvent) => {
    if (!isPanning || !panStart) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    setPan({ x: panStart.px + dx, y: panStart.py + dy });
  };

  const endPan = () => {
    setIsPanning(false);
    setPanStart(null);
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
        {/* Canvas on the left, palette/inspector on the right (target UX) */}
        <div
          className="editor-canvas"
          onWheel={handleCanvasWheel}
          onMouseDown={startPan}
          onMouseMove={movePan}
          onMouseUp={endPan}
          onMouseLeave={endPan}
        >
          <div className="canvas-hud" aria-label="Floor editor controls">
            <button className="hud-btn" onClick={() => zoomBy(0.1)} title="Zoom in">＋</button>
            <button className="hud-btn" onClick={() => zoomBy(-0.1)} title="Zoom out">－</button>
            <button className="hud-btn" onClick={centerView} title="Center view">⌖</button>
            <div className="hud-zoom">{Math.round(zoom * 100)}%</div>
          </div>

          <div className="grid-viewport">
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${currentLayout.gridCols}, 60px)`,
                gridTemplateRows: `repeat(${currentLayout.gridRows}, 60px)`,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
              }}
            >
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
                        <div className="obj-icon">
                          {objectHere.type === 'wall' ? '🧱' : objectHere.type === 'door' ? '🚪' : objectHere.type === 'bar' ? '🍸' : objectHere.type === 'plant' ? '🪴' : '➖'}
                        </div>
                        {objectHere.label && <div className="obj-label">{objectHere.label}</div>}
                      </div>
                    )}
                    {isTopLeft && tableHere && (
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
                        <div className="table-label">{tableHere.name}</div>
                        <div className="table-seats">{tableHere.seats} seats</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

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
              <div className="preview" style={{ fontSize: 16 }}>🧱</div>
              <span>Wall</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'door' })}>
              <div className="preview" style={{ fontSize: 16 }}>🚪</div>
              <span>Door</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'bar' })}>
              <div className="preview" style={{ fontSize: 16 }}>🍸</div>
              <span>Bar</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'plant' })}>
              <div className="preview" style={{ fontSize: 16 }}>🪴</div>
              <span>Plant</span>
            </div>
            <div className="palette-item" draggable onDragStart={(e) => handleDragStart(e, 'object', 'new', { objectType: 'divider' })}>
              <div className="preview" style={{ fontSize: 16 }}>➖</div>
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
