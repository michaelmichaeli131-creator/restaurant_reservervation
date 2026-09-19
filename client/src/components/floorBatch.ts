// Pure grid-geometry operations: one layout update per group action (one Undo step).
export type GridItem = { id: string; gridX: number; gridY: number; spanX: number; spanY: number };
export type SelectionKey = `table:${string}` | `object:${string}`;
export type GridLayout<T extends GridItem = GridItem, O extends GridItem = GridItem> = {
  gridCols: number; gridRows: number; gridMask?: number[]; tables: T[]; objects?: O[];
};
export type Axis = 'x' | 'y';
export type Alignment = 'start' | 'center' | 'end';

type Picked = { key: SelectionKey; item: GridItem };
export function selectedItems(layout: GridLayout, keys: readonly SelectionKey[]): Picked[] {
  const wanted = new Set(keys);
  return [
    ...layout.tables.filter(t => wanted.has(`table:${t.id}`)).map(item => ({ key: `table:${item.id}` as SelectionKey, item })),
    ...(layout.objects ?? []).filter(o => wanted.has(`object:${o.id}`)).map(item => ({ key: `object:${item.id}` as SelectionKey, item })),
  ];
}
export function bounds(items: readonly GridItem[]) {
  return {
    left: Math.min(...items.map(t => t.gridX)),
    top: Math.min(...items.map(t => t.gridY)),
    right: Math.max(...items.map(t => t.gridX + t.spanX)),
    bottom: Math.max(...items.map(t => t.gridY + t.spanY)),
  };
}
export function activeFootprint(layout: GridLayout, item: GridItem): boolean {
  if (!Number.isInteger(item.gridX) || !Number.isInteger(item.gridY) ||
      item.gridX < 0 || item.gridY < 0 || item.spanX < 1 || item.spanY < 1 ||
      item.gridX + item.spanX > layout.gridCols || item.gridY + item.spanY > layout.gridRows) return false;
  if (!layout.gridMask) return true;
  for (let y = item.gridY; y < item.gridY + item.spanY; y++) {
    for (let x = item.gridX; x < item.gridX + item.spanX; x++) {
      if (layout.gridMask[y * layout.gridCols + x] !== 1) return false;
    }
  }
  return true;
}
function change<T extends GridItem, O extends GridItem>(layout: GridLayout<T, O>, picked: readonly Picked[],
  updates: Map<SelectionKey, { gridX: number; gridY: number }>): GridLayout<T, O> | null {
  if (!picked.length || !updates.size) return null;
  for (const { key, item } of picked) {
    const next = updates.get(key);
    if (next && !activeFootprint(layout, { ...item, ...next })) return null;
  }
  const tables = layout.tables.map(item => ({ ...item, ...(updates.get(`table:${item.id}`) ?? {}) }));
  const objects = (layout.objects ?? []).map(item => ({ ...item, ...(updates.get(`object:${item.id}`) ?? {}) }));
  if (tables.every((item, i) => item.gridX === layout.tables[i].gridX && item.gridY === layout.tables[i].gridY) &&
    objects.every((item, i) => item.gridX === layout.objects?.[i].gridX && item.gridY === layout.objects?.[i].gridY)) return null;
  return { ...layout, tables, objects };
}
export function moveSelection<T extends GridItem, O extends GridItem>(layout: GridLayout<T, O>,
  keys: readonly SelectionKey[], dx: number, dy: number): GridLayout<T, O> | null {
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) return null;
  const picked = selectedItems(layout, keys);
  const updates = new Map(picked.map(({ key, item }) => [key, { gridX: item.gridX + dx, gridY: item.gridY + dy }] as const));
  return change(layout, picked, updates);
}
export function alignSelection<T extends GridItem, O extends GridItem>(layout: GridLayout<T, O>,
  keys: readonly SelectionKey[], axis: Axis, alignment: Alignment): GridLayout<T, O> | null {
  const picked = selectedItems(layout, keys);
  if (picked.length < 2) return null;
  const b = bounds(picked.map(p => p.item));
  const start = axis === 'x' ? b.left : b.top;
  const end = axis === 'x' ? b.right : b.bottom;
  const updates = new Map(picked.map(({ key, item }) => {
    const size = axis === 'x' ? item.spanX : item.spanY;
    const position = alignment === 'start' ? start : alignment === 'end' ? end - size : Math.round((start + end - size) / 2);
    return [key, { gridX: axis === 'x' ? position : item.gridX, gridY: axis === 'y' ? position : item.gridY }] as const;
  }));
  return change(layout, picked, updates);
}
export function distributeSelection<T extends GridItem, O extends GridItem>(layout: GridLayout<T, O>,
  keys: readonly SelectionKey[], axis: Axis): GridLayout<T, O> | null {
  const picked = selectedItems(layout, keys).sort((a, b) => {
    const aStart = axis === 'x' ? a.item.gridX : a.item.gridY;
    const bStart = axis === 'x' ? b.item.gridX : b.item.gridY;
    return aStart - bStart || a.key.localeCompare(b.key);
  });
  if (picked.length < 3) return null;
  const getStart = (p: Picked) => axis === 'x' ? p.item.gridX : p.item.gridY;
  const getSize = (p: Picked) => axis === 'x' ? p.item.spanX : p.item.spanY;
  const occupied = picked.reduce((sum, p) => sum + getSize(p), 0);
  const available = getStart(picked[picked.length - 1]) + getSize(picked[picked.length - 1]) - getStart(picked[0]);
  if (occupied > available) return null;
  const gap = (available - occupied) / (picked.length - 1);
  let cursor = getStart(picked[0]) + getSize(picked[0]);
  const updates = new Map<SelectionKey, { gridX: number; gridY: number }>();
  for (let i = 1; i < picked.length - 1; i++) {
    const p = picked[i];
    const position = Math.round(cursor + gap);
    updates.set(p.key, { gridX: axis === 'x' ? position : p.item.gridX, gridY: axis === 'y' ? position : p.item.gridY });
    cursor = position + getSize(p);
  }
  return change(layout, picked, updates);
}
