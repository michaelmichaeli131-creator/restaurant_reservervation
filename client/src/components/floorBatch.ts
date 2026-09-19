// Pure grid-geometry operations: one layout update per group action (one Undo step).
export type GridItem = { id: string; gridX: number; gridY: number; spanX: number; spanY: number; locked?: boolean; groupId?: string };
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
  if (!picked.length || !updates.size || picked.some(p => p.item.locked)) return null;
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

/** Select every item touched by an inclusive grid-cell marquee, including mixed item types. */
export function selectInRectangle(layout: GridLayout, x1: number, y1: number, x2: number, y2: number): SelectionKey[] {
  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const right = Math.max(x1, x2) + 1, bottom = Math.max(y1, y2) + 1;
  return [
    ...layout.tables.filter(t => t.gridX < right && t.gridX + t.spanX > left &&
      t.gridY < bottom && t.gridY + t.spanY > top).map(t => `table:${t.id}` as SelectionKey),
    ...(layout.objects ?? []).filter(o => o.gridX < right && o.gridX + o.spanX > left &&
      o.gridY < bottom && o.gridY + o.spanY > top).map(o => `object:${o.id}` as SelectionKey),
  ];
}
/** Find a single offset for an entire copied group, without leaving the mask or overlapping existing items. */
export function findCopyOffset(layout: GridLayout, keys: readonly SelectionKey[]): { dx: number; dy: number } | null {
  const picked = selectedItems(layout, keys);
  if (!picked.length || picked.some(p => p.item.locked)) return null;
  const existing = [...layout.tables, ...(layout.objects ?? [])];
  const intersects = (a: GridItem, b: GridItem) => a.gridX < b.gridX + b.spanX &&
    a.gridX + a.spanX > b.gridX && a.gridY < b.gridY + b.spanY && a.gridY + a.spanY > b.gridY;
  // Prefer one cell diagonally, then nearby offsets, including negative ones.
  const candidates: { dx: number; dy: number }[] = [];
  for (let radius = 1; radius <= Math.max(layout.gridCols, layout.gridRows); radius++) {
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) candidates.push({ dx, dy });
    }
  }
  candidates.sort((a, b) => {
    const ra = Math.max(Math.abs(a.dx), Math.abs(a.dy)), rb = Math.max(Math.abs(b.dx), Math.abs(b.dy));
    return ra - rb || (a.dx === 1 && a.dy === 1 ? -1 : 0) - (b.dx === 1 && b.dy === 1 ? -1 : 0) ||
      Math.abs(a.dx) + Math.abs(a.dy) - Math.abs(b.dx) - Math.abs(b.dy);
  });
  for (const offset of candidates) {
    const copies = picked.map(({ item }) => ({ ...item, gridX: item.gridX + offset.dx, gridY: item.gridY + offset.dy }));
    if (copies.every(copy => activeFootprint(layout, copy) &&
      existing.every(item => !intersects(copy, item)))) return offset;
  }
  return null;
}

/** Include all members of each selected persistent group, across tables and furniture. */
export function expandGroupSelection(layout: GridLayout, keys: readonly SelectionKey[]): SelectionKey[] {
  const picked = selectedItems(layout, keys);
  const groupIds = new Set(picked.map(p => p.item.groupId).filter((id): id is string => Boolean(id)));
  const all = [...layout.tables.map(t => ({ key: `table:${t.id}` as SelectionKey, item: t })),
    ...(layout.objects ?? []).map(o => ({ key: `object:${o.id}` as SelectionKey, item: o }))];
  return [...new Set([...keys, ...all.filter(p => p.item.groupId && groupIds.has(p.item.groupId)).map(p => p.key)])];
}
