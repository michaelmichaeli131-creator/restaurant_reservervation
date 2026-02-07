// src/routes/restaurants/_utils/misc.ts
export function photoStrings(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p: any) => (typeof p === "string" ? p : String(p?.dataUrl || "")))
    .filter(Boolean);
}

export function asOk(x: unknown): boolean {
  if (typeof x === "boolean") return x;
  if (x && typeof x === "object" && "ok" in (x as any)) return !!(x as any).ok;
  return !!x;
}
