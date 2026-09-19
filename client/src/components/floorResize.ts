import { activeFootprint, type GridItem, type GridLayout } from './floorBatch.ts';

export type ResizeDirection = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type ResizeBox = Pick<GridItem, 'gridX' | 'gridY' | 'spanX' | 'spanY'>;

export function resizeByKeyboard(box: ResizeBox, direction: ResizeDirection, amount: number): ResizeBox {
  const west = direction.includes('w'), north = direction.includes('n');
  const horizontal = west || direction.includes('e');
  const vertical = north || direction.includes('s');
  const spanX = horizontal ? Math.max(1, box.spanX + amount) : box.spanX;
  const spanY = vertical ? Math.max(1, box.spanY + amount) : box.spanY;
  return {
    gridX: west ? box.gridX + box.spanX - spanX : box.gridX,
    gridY: north ? box.gridY + box.spanY - spanY : box.gridY,
    spanX, spanY,
  };
}

export function canResize(
  layout: GridLayout,
  kind: 'table' | 'object',
  id: string,
  candidate: ResizeBox,
): boolean {
  if (!activeFootprint(layout, { ...candidate, id })) return false;
  const collides = (other: GridItem) =>
    candidate.gridX < other.gridX + other.spanX &&
    candidate.gridX + candidate.spanX > other.gridX &&
    candidate.gridY < other.gridY + other.spanY &&
    candidate.gridY + candidate.spanY > other.gridY;
  // Table and object ids live in separate namespaces: compare kind as well as id.
  return layout.tables.every(item => (kind === 'table' && item.id === id) || !collides(item)) &&
    (layout.objects ?? []).every(item => (kind === 'object' && item.id === id) || !collides(item));
}
