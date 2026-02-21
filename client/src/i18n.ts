// Client-side translation utility
// Reads translations from embedded data or fetches from server

type Translations = Record<string, any>;

let currentLang = 'en';
let translations: Translations = {};

// Initialize with embedded translations or fetch from server
export async function initI18n(lang: string = 'en') {
  currentLang = lang;

  try {
    // Fetch translations from server
    const response = await fetch(`/api/i18n/${lang}`);
    if (response.ok) {
      translations = await response.json();
    }
  } catch (error) {
    console.warn('Failed to load translations:', error);
    // Fallback to default translations
    translations = getDefaultTranslations();
  }
}

// Get translation by key (supports dot notation like 'floor.btn_save')
export function t(key: string, fallback?: string): string {
  const keys = key.split('.');
  let value: any = translations;

  for (const k of keys) {
    if (value && typeof value === 'object') {
      value = value[k];
    } else {
      return fallback || `(${key})`;
    }
  }

  return typeof value === 'string' ? value : (fallback || `(${key})`);
}

// Get current language
export function getCurrentLang(): string {
  return currentLang;
}

// Default Hebrew translations (fallback)
function getDefaultTranslations(): Translations {
  return {
    common: {
      btn_save: 'שמור',
      btn_cancel: 'ביטול',
      btn_delete: 'מחק',
    },
    floor: {
      loading: 'טוען תכניות רצפה...',
      empty_state: 'לא נמצאו תכניות רצפה',
      btn_save_layout: 'שמור תכנית',
      error: {
        enter_name: 'אנא הזן שם תכנית',
        create: 'שגיאה ביצירת תכנית',
        delete: 'מחיקה נכשלה',
      },
      status: {
        empty: 'פנוי',
        occupied: 'תפוס',
        reserved: 'שמור',
        dirty: 'מלוכלך',
      },
    },
  };
}
