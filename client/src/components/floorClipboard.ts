import { activeFootprint, bounds, type GridItem, type GridLayout } from './floorBatch';

/** Find a translation that preserves a copied arrangement and respects the destination floor. */
export function findPastePosition(layout: GridLayout, source: readonly GridItem[]):
  { dx: number; dy: number } | null {
  if (!source.length) return null;
  const box = bounds(source);
  if (box.right - box.left > layout.gridCols || box.bottom - box.top > layout.gridRows) return null;
  const occupied = [...layout.tables, ...(layout.objects ?? [])];
  const intersects = (a: GridItem, b: GridItem) =>
    a.gridX < b.gridX + b.spanX && a.gridX + a.spanX > b.gridX &&
    a.gridY < b.gridY + b.spanY && a.gridY + a.spanY > b.gridY;
  // Search row-major with an offset of one cell preferred, avoiding large intermediate arrays.
  const candidates: { x: number; y: number; cost: number }[] = [];
  for (let y = 0; y <= layout.gridRows - (box.bottom - box.top); y++) {
    for (let x = 0; x <= layout.gridCols - (box.right - box.left); x++) {
      candidates.push({ x, y, cost: Math.abs(x - box.left - 1) + Math.abs(y - box.top - 1) });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
  for (const candidate of candidates) {
    const dx = candidate.x - box.left, dy = candidate.y - box.top;
    if (source.every(item => {
      const placed = { ...item, gridX: item.gridX + dx, gridY: item.gridY + dy };
      return activeFootprint(layout, placed) && occupied.every(other => !intersects(placed, other));
    })) return { dx, dy };
  }
  return null;
}
