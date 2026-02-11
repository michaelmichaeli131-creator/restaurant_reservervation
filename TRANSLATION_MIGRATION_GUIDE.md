# Translation Migration Guide

This guide shows you how to migrate hardcoded strings to use the i18n system.

## What's Been Done

✅ **Translation files created** (`i18n/he.json`, `i18n/en.json`, `i18n/ka.json`)
✅ **owner_dashboard.eta updated** - All buttons now use translation keys
✅ **React i18n utility created** (`client/src/i18n.ts`)

## What Needs To Be Done

📋 **120+ hardcoded strings** in templates and React components need migration

---

## Pattern 1: Server-Side Templates (.eta files)

### Before:
```html
<button>שמור</button>
<h2>ניהול עובדים</h2>
```

### After:
```html
<button><%= tt('common.btn_save', 'שמור') %></button>
<h2><%= tt('owner.staff.manage_title', 'ניהול עובדים') %></h2>
```

### Examples from Codebase:

**templates/owner/staff.eta** (lines to update):
```html
<!-- Line 347 -->
BEFORE: ➕ הוסף עובד
AFTER:  <%= tt('owner.staff.btn_add', '➕ הוסף עובד') %>

<!-- Line 480 -->
BEFORE: הפעל
AFTER:  <%= tt('owner.staff.btn_activate', 'הפעל') %>

<!-- Line 483 -->
BEFORE: השבת
AFTER:  <%= tt('owner.staff.btn_deactivate', 'השבת') %>

<!-- Table headers (lines 394-399) -->
BEFORE: <th>שם</th><th>תפקיד</th><th>אימייל</th>
AFTER:  <th><%= tt('owner.staff.tbl.name', 'שם') %></th>
        <th><%= tt('owner.staff.tbl.role', 'תפקיד') %></th>
        <th><%= tt('owner.staff.tbl.email', 'אימייל') %></th>
```

**templates/pos_waiter.eta** (lines to update):
```html
<!-- Line 37 -->
BEFORE: תפריט
AFTER:  <%= tt('pos.menu.title', 'תפריט') %>

<!-- Line 82-86 (status labels) -->
BEFORE: התקבל | בהכנה | מוכן | הוגש | בוטל
AFTER:  <%= tt('pos.status.received', 'התקבל') %>
        <%= tt('pos.status.in_progress', 'בהכנה') %>
        <%= tt('pos.status.ready', 'מוכן') %>
        <%= tt('pos.status.served', 'הוגש') %>
        <%= tt('pos.status.cancelled', 'בוטל') %>

<!-- Line 124 -->
BEFORE: סגירת שולחן / הוצאת חשבון
AFTER:  <%= tt('pos.waiter.btn_close_order', 'סגירת שולחן / הוצאת חשבון') %>
```

**templates/pos_kitchen.eta** (lines to update):
```html
<!-- Line 11 -->
BEFORE: מסך מטבח —
AFTER:  <%= tt('pos.kitchen.title', 'מסך מטבח —') %>

<!-- Line 20 -->
BEFORE: הזמנות מטבח
AFTER:  <%= tt('pos.kitchen.orders_title', 'הזמנות מטבח') %>
```

---

## Pattern 2: React Components (.tsx files)

### Step 1: Import the translation utility

```typescript
import { t } from '../i18n';
```

### Step 2: Replace hardcoded strings

**FloorEditor.tsx** examples:

```typescript
// Line 86 - BEFORE:
alert('Please enter a layout name');

// AFTER:
alert(t('floor.error.enter_name', 'Please enter a layout name'));

// Line 113 - BEFORE:
alert(`Failed to create layout: ${errorMsg}`);

// AFTER:
alert(t('floor.error.create', 'Error creating layout: {error}').replace('{error}', errorMsg));

// Line 142 - BEFORE:
alert('Error deleting layout');

// AFTER:
alert(t('floor.error.delete_general', 'Error deleting layout'));

// Line 299 (button text) - BEFORE:
<button>Cancel</button>

// AFTER:
<button>{t('common.btn_cancel', 'Cancel')}</button>

// Line 412 - BEFORE:
<button className="btn-save">Save Layout</button>

// AFTER:
<button className="btn-save">{t('floor.btn_save_layout', 'Save Layout')}</button>
```

**RestaurantLiveView.tsx** examples:

```typescript
// Line 142 - BEFORE:
return <div className="live-view-loading">Loading floor layouts...</div>;

// AFTER:
return <div className="live-view-loading">{t('floor.loading', 'Loading floor layouts...')}</div>;

// Line 148 - BEFORE:
return <div className="live-view-error">No floor layouts found. Please create a floor layout first.</div>;

// AFTER:
return <div className="live-view-error">{t('floor.empty_state', 'No floor layouts found. Please create a floor layout first.')}</div>;

// STATUS_LABELS (lines 52-57) - BEFORE:
const STATUS_LABELS = {
  empty: 'Empty',
  occupied: 'Occupied',
  reserved: 'Reserved',
  dirty: 'Dirty',
};

// AFTER:
const STATUS_LABELS = {
  empty: t('floor.status.empty', 'Empty'),
  occupied: t('floor.status.occupied', 'Occupied'),
  reserved: t('floor.status.reserved', 'Reserved'),
  dirty: t('floor.status.dirty', 'Dirty'),
};
```

### Step 3: Initialize translations

In your main app component:

```typescript
import { initI18n } from './i18n';

useEffect(() => {
  // Get language from cookie or browser
  const lang = document.cookie.match(/lang=([^;]+)/)?.[1] || 'he';
  initI18n(lang);
}, []);
```

---

## Translation Keys Reference

All keys are available in `i18n/he.json`, `i18n/en.json`, `i18n/ka.json`.

### Common Keys:
```
common.btn_save        → שמור | Save | შენახვა
common.btn_cancel      → ביטול | Cancel | გაუქმება
common.btn_delete      → מחק | Delete | წაშლა
common.btn_edit        → ערוך | Edit | რედაქტირება
common.btn_close       → סגור | Close | დახურვა
common.people_unit     → סועדים | Guests | სტუმარი
```

### Owner Keys:
```
owner.dashboard.btn_waiter    → מסך מלצרים | Waiter Screen | ...
owner.dashboard.btn_kitchen   → מסך מטבח | Kitchen Screen | ...
owner.staff.manage_title      → ניהול עובדים | Staff Management | ...
owner.staff.btn_add           → הוסף עובד | Add Employee | ...
owner.menu.categories         → קטגוריות | Categories | ...
```

### POS Keys:
```
pos.menu.title          → תפריט | Menu | მენიუ
pos.status.received     → התקבל | Received | მიღებული
pos.status.in_progress  → בהכנה | In Progress | მიმდინარეობს
pos.status.ready        → מוכן | Ready | მზადაა
pos.waiter.btn_close_order → סגירת שולחן / הוצאת חשבון | Close Table / Issue Bill | ...
```

### Floor Keys:
```
floor.loading           → טוען תכניות רצפה... | Loading floor layouts... | ...
floor.empty_state       → לא נמצאו תכניות רצפה | No floor layouts found | ...
floor.btn_save_layout   → שמור תכנית | Save Layout | ...
floor.error.enter_name  → אנא הזן שם תכנית | Please enter a layout name | ...
floor.status.empty      → פנוי | Empty | ცარიელი
floor.status.occupied   → תפוס | Occupied | დაკავებული
```

---

## Files Requiring Updates

### High Priority (user-facing):
1. ✅ `templates/owner_dashboard.eta` - **DONE**
2. `templates/owner/staff.eta` - ~15 strings
3. `templates/pos_waiter.eta` - ~20 strings
4. `templates/pos_kitchen.eta` - ~8 strings
5. `templates/host_seating.eta` - ~5 strings
6. `client/src/components/FloorEditor.tsx` - ~15 strings
7. `client/src/components/RestaurantLiveView.tsx` - ~5 strings

### Medium Priority:
8. `templates/owner_menu.eta` - ~10 strings
9. `templates/owner/owner_bills.eta` - ~5 strings
10. `templates/pos_bar.eta` - ~8 strings
11. `templates/owner_inventory_*.eta` - ~20 strings each

### Low Priority:
12. Various auth/review/restaurant templates

---

## Testing Translations

1. **Hebrew (default)** - Should work automatically
2. **English** - Visit `/lang/en` then navigate to any page
3. **Georgian** - Visit `/lang/ka` then navigate to any page

Check that all text updates dynamically based on language selection.

---

## Quick Commands

```bash
# Find all hardcoded Hebrew strings in templates
grep -r "ניהול\|הוסף\|עריכ\|מחק\|שמור" templates/

# Find all hardcoded English strings in React
grep -r "alert\|'Delete'\|'Cancel'\|'Save'" client/src/

# Test language switching
curl http://localhost:8000/lang/en
curl http://localhost:8000/lang/he
curl http://localhost:8000/lang/ka
```

---

## Next Steps

1. Update each file following the patterns above
2. Test each page in all three languages
3. Adjust translations in JSON files if needed
4. Consider adding more languages by creating new `i18n/xx.json` files

**Estimated time**: ~2-3 hours to migrate all 120+ strings
