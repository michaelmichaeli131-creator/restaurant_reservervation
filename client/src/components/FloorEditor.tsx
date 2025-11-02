import { useState, useEffect } from 'react';
import './FloorEditor.css';

interface FloorTable {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
  spanX: number;
  spanY: number;
  seats: number;
  shape: 'square' | 'round' | 'rect' | 'booth';
}

interface FloorPlan {
  id?: string;
  restaurantId: string;
  name: string;
  gridRows: number;
  gridCols: number;
  tables: FloorTable[];
}

interface FloorEditorProps {
  restaurantId: string;
}

export default function FloorEditor({ restaurantId }: FloorEditorProps) {
  const [floorPlan, setFloorPlan] = useState<FloorPlan>({
    restaurantId,
    name: 'Main Floor',
    gridRows: 8,
    gridCols: 12,
    tables: []
  });

  const [selectedTable, setSelectedTable] = useState<FloorTable | null>(null);
  const [draggedItem, setDraggedItem] = useState<{ type: 'new' | 'existing', shape?: string, tableId?: string } | null>(null);

  // Load existing floor plan
  useEffect(() => {
    if (restaurantId) {
      fetch(`/api/floor-plans/${restaurantId}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) setFloorPlan(data);
        })
        .catch(err => console.error('Failed to load floor plan:', err));
    }
  }, [restaurantId]);

  const handleDragStart = (e: React.DragEvent, type: 'new' | 'existing', shape?: string, tableId?: string) => {
    setDraggedItem({ type, shape, tableId });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = (e: React.DragEvent, gridX: number, gridY: number) => {
    e.preventDefault();

    if (!draggedItem) return;

    if (draggedItem.type === 'new' && draggedItem.shape) {
      // Add new table
      const newTable: FloorTable = {
        id: `T${Date.now()}`,
        name: `Table ${floorPlan.tables.length + 1}`,
        gridX,
        gridY,
        spanX: draggedItem.shape === 'rect' || draggedItem.shape === 'booth' ? 2 : 1,
        spanY: 1,
        seats: draggedItem.shape === 'booth' ? 4 : 2,
        shape: draggedItem.shape as any
      };

      setFloorPlan(prev => ({
        ...prev,
        tables: [...prev.tables, newTable]
      }));
    } else if (draggedItem.type === 'existing' && draggedItem.tableId) {
      // Move existing table
      setFloorPlan(prev => ({
        ...prev,
        tables: prev.tables.map(t =>
          t.id === draggedItem.tableId ? { ...t, gridX, gridY } : t
        )
      }));
    }

    setDraggedItem(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const deleteTable = (tableId: string) => {
    setFloorPlan(prev => ({
      ...prev,
      tables: prev.tables.filter(t => t.id !== tableId)
    }));
    setSelectedTable(null);
  };

  const updateTable = (tableId: string, updates: Partial<FloorTable>) => {
    setFloorPlan(prev => ({
      ...prev,
      tables: prev.tables.map(t => t.id === tableId ? { ...t, ...updates } : t)
    }));
  };

  const savePlan = async () => {
    try {
      const response = await fetch(`/api/floor-plans/${restaurantId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(floorPlan)
      });

      if (response.ok) {
        alert('✅ Floor plan saved successfully!');
      } else {
        alert('❌ Failed to save floor plan');
      }
    } catch (err) {
      console.error('Save failed:', err);
      alert('❌ Error saving floor plan');
    }
  };

  return (
    <div className="floor-editor">
      <div className="editor-sidebar">
        <h2>🎨 Palette</h2>
        <div className="palette">
          <div
            className="palette-item"
            draggable
            onDragStart={(e) => handleDragStart(e, 'new', 'round')}
          >
            <div className="preview round">🪑</div>
            <span>2-Seat Round</span>
          </div>
          <div
            className="palette-item"
            draggable
            onDragStart={(e) => handleDragStart(e, 'new', 'square')}
          >
            <div className="preview square">🪑</div>
            <span>4-Seat Square</span>
          </div>
          <div
            className="palette-item"
            draggable
            onDragStart={(e) => handleDragStart(e, 'new', 'rect')}
          >
            <div className="preview rect">🪑</div>
            <span>6-Seat Rect</span>
          </div>
          <div
            className="palette-item"
            draggable
            onDragStart={(e) => handleDragStart(e, 'new', 'booth')}
          >
            <div className="preview booth">🛋️</div>
            <span>Booth</span>
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

        <button className="btn-save" onClick={savePlan}>
          💾 Save Layout
        </button>
      </div>

      <div className="editor-canvas">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${floorPlan.gridCols}, 60px)`,
            gridTemplateRows: `repeat(${floorPlan.gridRows}, 60px)`
          }}
        >
          {Array.from({ length: floorPlan.gridRows * floorPlan.gridCols }).map((_, i) => {
            const gridY = Math.floor(i / floorPlan.gridCols);
            const gridX = i % floorPlan.gridCols;

            const tableHere = floorPlan.tables.find(t =>
              gridX >= t.gridX && gridX < t.gridX + t.spanX &&
              gridY >= t.gridY && gridY < t.gridY + t.spanY
            );

            const isTopLeft = tableHere && tableHere.gridX === gridX && tableHere.gridY === gridY;

            return (
              <div
                key={i}
                className="grid-cell"
                onDrop={(e) => handleDrop(e, gridX, gridY)}
                onDragOver={handleDragOver}
              >
                {isTopLeft && (
                  <div
                    className={`table ${tableHere.shape} ${selectedTable?.id === tableHere.id ? 'selected' : ''}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, 'existing', undefined, tableHere.id)}
                    onClick={() => setSelectedTable(tableHere)}
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
  );
}
