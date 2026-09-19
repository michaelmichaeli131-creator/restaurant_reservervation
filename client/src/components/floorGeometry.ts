export function proportionalSize(w: number, h: number, nextW: number, nextH: number, maxW: number, maxH: number) {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const unit = gcd(w, h);
  const x = w / unit, y = h / unit;
  const factor = Math.abs(nextW / w - 1) >= Math.abs(nextH / h - 1) ? nextW / w : nextH / h;
  const count = Math.max(1, Math.min(Math.round(unit * factor), Math.floor(maxW / x), Math.floor(maxH / y)));
  return { spanX: x * count, spanY: y * count };
}
export type Footprint = { id: string; gridX: number; gridY: number; spanX: number; spanY: number };
export function overlaps(a: Footprint, b: Footprint) {
  return a.id !== b.id && a.gridX < b.gridX + b.spanX && a.gridX + a.spanX > b.gridX &&
    a.gridY < b.gridY + b.spanY && a.gridY + a.spanY > b.gridY;
}
