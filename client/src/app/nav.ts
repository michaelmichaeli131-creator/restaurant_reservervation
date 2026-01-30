export type AppRouteKey = 'layout' | 'live' | 'shifts' | 'settings';

export const NAV_ITEMS: Array<{
  key: AppRouteKey;
  label: string;
  icon: string;
}> = [
  { key: 'layout', label: 'Layout', icon: '🧩' },
  { key: 'live', label: 'Live', icon: '🟢' },
  { key: 'shifts', label: 'Shifts', icon: '🗓️' },
  { key: 'settings', label: 'More', icon: '⚙️' },
];
