export type AssetCategory = 'tables' | 'chairs' | 'architecture' | 'decor';
export type FloorAsset = {
  id: string;
  category: AssetCategory;
  kind: 'table' | 'object';
  file: string;
  nameHe: string;
  nameEn: string;
  nameKa?: string;
  spanX: number;
  spanY: number;
  shape?: 'rect' | 'booth' | 'round' | 'square';
  seats?: number;
  objectType?: 'chair' | 'plant' | 'door' | 'visual';
  objectKind?: 'object' | 'visualOnly';
};
export const FLOOR_ASSETS: readonly FloorAsset[] = [
  { id: 'bar', category: 'tables', kind: 'table', file: 'bar.svg', nameHe: 'בר · 5 מקומות', nameEn: 'Bar · 5 seats', nameKa: 'ბარი · 5 ადგილი', spanX: 5, spanY: 2, shape: 'rect', seats: 5 },
  { id: 'booth4', category: 'tables', kind: 'table', file: 'booth4.svg', nameHe: 'ספה · 4 מקומות', nameEn: 'Booth · 4 seats', nameKa: 'დივანი · 4 ადგილი', spanX: 2, spanY: 2, shape: 'booth', seats: 4 },
  { id: 'booth6', category: 'tables', kind: 'table', file: 'large_booth.svg', nameHe: 'ספה · 6 מקומות', nameEn: 'Booth · 6 seats', nameKa: 'დივანი · 6 ადგილი', spanX: 6, spanY: 2, shape: 'booth', seats: 6 },
  { id: 'round4', category: 'tables', kind: 'table', file: 'round_table4.svg', nameHe: 'עגול · 4 מקומות', nameEn: 'Round · 4 seats', nameKa: 'მრგვალი · 4 ადგილი', spanX: 2, spanY: 2, shape: 'round', seats: 4 },
  { id: 'round10', category: 'tables', kind: 'table', file: 'round_table_10.svg', nameHe: 'עגול · 10 מקומות', nameEn: 'Round · 10 seats', nameKa: 'მრგვალი · 10 ადგილი', spanX: 3, spanY: 3, shape: 'round', seats: 10 },
  ...([2, 4, 6, 8, 10] as const).map(seats => ({
    id: 'square' + seats, category: 'tables' as const, kind: 'table' as const,
    file: 'square_table' + seats + '.svg', nameHe: 'שולחן · ' + seats + ' מקומות',
    nameEn: 'Table · ' + seats + ' seats', nameKa: 'მაგიდა · ' + seats + ' ადგილი', spanX: 2, spanY: seats === 2 ? 1 : 2,
    shape: 'square' as const, seats,
  })),
  { id: 'chair', category: 'chairs', kind: 'object', file: 'chair.svg', nameHe: 'כיסא', nameEn: 'Chair', nameKa: 'სკამი', spanX: 1, spanY: 1, objectType: 'chair', objectKind: 'object' },
  { id: 'door', category: 'architecture', kind: 'object', file: 'door.svg', nameHe: 'דלת', nameEn: 'Door', nameKa: 'კარი', spanX: 1, spanY: 1, objectType: 'door', objectKind: 'visualOnly' },
  { id: 'corner', category: 'architecture', kind: 'object', file: 'corner_partitaion.svg', nameHe: 'מחיצה פינתית', nameEn: 'Corner partition', nameKa: 'კუთხის ტიხარი', spanX: 1, spanY: 1, objectType: 'visual', objectKind: 'visualOnly' },
  { id: 'curved', category: 'architecture', kind: 'object', file: 'cyclic_partition.svg', nameHe: 'מחיצה מעוגלת', nameEn: 'Curved partition', nameKa: 'მრგვალი ტიხარი', spanX: 2, spanY: 2, objectType: 'visual', objectKind: 'visualOnly' },
  { id: 'horizontal', category: 'architecture', kind: 'object', file: 'horizintal_partitaion.svg', nameHe: 'מחיצה אופקית', nameEn: 'Horizontal partition', nameKa: 'ჰორიზონტალური ტიხარი', spanX: 4, spanY: 1, objectType: 'visual', objectKind: 'visualOnly' },
  { id: 'vertical', category: 'architecture', kind: 'object', file: 'vertical_partition.svg', nameHe: 'מחיצה אנכית', nameEn: 'Vertical partition', nameKa: 'ვერტიკალური ტიხარი', spanX: 1, spanY: 4, objectType: 'visual', objectKind: 'visualOnly' },
  { id: 'plant', category: 'decor', kind: 'object', file: 'plant.svg', nameHe: 'צמח', nameEn: 'Plant', nameKa: 'მცენარე', spanX: 1, spanY: 1, objectType: 'plant', objectKind: 'object' },
  { id: 'floor', category: 'decor', kind: 'object', file: 'floor_brown.svg', nameHe: 'עיטור רצפה', nameEn: 'Floor decoration', nameKa: 'იატაკის დეკორი', spanX: 1, spanY: 1, objectType: 'visual', objectKind: 'visualOnly' },
];
export function filterFloorAssets(query: string, category: AssetCategory | 'all'): FloorAsset[] {
  const q = query.trim().toLocaleLowerCase();
  return FLOOR_ASSETS.filter(asset => (category === 'all' || asset.category === category) &&
    (!q || [asset.nameHe, asset.nameEn, asset.file, asset.id, String(asset.seats ?? '')].some(v => v.toLocaleLowerCase().includes(q))));
}
