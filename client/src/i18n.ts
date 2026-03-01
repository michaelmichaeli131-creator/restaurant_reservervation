// Client-side translation utility
// Reads translations from embedded data or fetches from server

type Translations = Record<string, any>;

// Default language is English
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
    // Fallback to default (EN) translations
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

// Default English translations (fallback)
function getDefaultTranslations(): Translations {
  return {
    common: {
      btn_save: 'Save',
      btn_cancel: 'Cancel',
      btn_delete: 'Delete',
    },
    floor: {
      loading: 'Loading floor plans…',
      empty_state: 'No floor plans found',
      btn_save_layout: 'Save layout',
      error: {
        enter_name: 'Please enter a layout name',
        create: 'Failed to create layout',
        delete: 'Delete failed',
      },
      status: {
        empty: 'Empty',
        occupied: 'Occupied',
        reserved: 'Reserved',
        dirty: 'Dirty',
      },
    },
  };
}
