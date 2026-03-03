// client/src/i18n.ts
// Lightweight i18n used by the React apps (Host/Waiter/Editor).
// Default language must be English (en). Supported: en/he/ka.

type Translations = Record<string, any>;

let currentLang: 'en' | 'he' | 'ka' = 'en';
let translations: Translations = {
  common: {
    btn_refresh: 'Retry',
    btn_save: 'Save',
    btn_cancel: 'Cancel',
    btn_delete: 'Delete',
  },
  floor: {
    loading: 'Loading floor plan...',
    hints: {
      controls: 'Drag to pan, Ctrl+wheel to zoom',
    },
    status: {
      empty: 'Empty',
      occupied: 'Occupied',
      reserved: 'Reserved',
      dirty: 'Dirty',
    },
  },
};

function deepGet(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function deepSet(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function normalizeLang(raw?: string | null): 'en' | 'he' | 'ka' {
  const v = (raw || '').toLowerCase();
  if (v.startsWith('he') || v === 'iw' || v === 'heb') return 'he';
  if (v.startsWith('ka') || v.startsWith('ge')) return 'ka';
  return 'en';
}

export function getLang(): 'en' | 'he' | 'ka' {
  return currentLang;
}

// Backward-compat alias: some components expect this older name.
export function getCurrentLang(): 'en' | 'he' | 'ka' {
  return currentLang;
}

export function setLang(lang: 'en' | 'he' | 'ka'): void {
  currentLang = lang;
  try {
    localStorage.setItem('sb_lang', lang);
  } catch {
    // ignore
  }
}

export async function initI18n(preferred?: string): Promise<void> {
  const lang = normalizeLang(
    preferred ||
      (typeof window !== 'undefined' ? (window as any).SB_LANG : null) ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('sb_lang') : null) ||
      (typeof navigator !== 'undefined' ? navigator.language : null),
  );

  currentLang = lang;

  try {
    const res = await fetch(`/api/i18n/${lang}`, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`i18n HTTP ${res.status}`);
    const data = (await res.json()) as Translations;
    translations = data || translations;
  } catch {
    // Keep the default EN fallbacks.
  }
}

export function t(key: string, params?: Record<string, any>): string {
  const raw = deepGet(translations, key);
  let str = typeof raw === 'string' ? raw : undefined;

  // Fallback to embedded default translations.
  if (!str) {
    const fallback = deepGet(
      {
        common: translations.common,
        floor: translations.floor,
      },
      key,
    );
    str = typeof fallback === 'string' ? fallback : undefined;
  }

  // Last-resort: return key.
  if (!str) str = key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }

  return str;
}

export function inject(key: string, value: any): void {
  deepSet(translations, key, value);
}
