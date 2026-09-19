/** Pure reconciliation for a successful layout PUT followed by an optional activation POST. */
export function reconcileSavedLayouts<T extends { id: string; isActive: boolean }>(
  layouts: readonly T[], saved: T, activated: boolean,
): T[] {
  return layouts.map(layout => layout.id === saved.id
    ? { ...saved, isActive: activated ? true : layout.isActive }
    : activated ? { ...layout, isActive: false } : layout);
}
