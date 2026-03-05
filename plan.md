# תוכנית: תמיכה בכמה קומות/חללים (Multi-Room/Floor Support)

## מצב קיים

### מה כבר קיים:
- **FloorLayout** - תכנון קומה עם שולחנות ואובייקטים על גריד. כבר יש תמיכה **בכמה layouts** (תכניות קומה) למסעדה
- **FloorSection** - interface קיים ב-`floor_service.ts` עם שם, גריד, סדר תצוגה - אבל **לא מנוצל** באמת בUI
- **שולחנות** - יש שדה `sectionId?` אופציונלי אבל לא מחובר לשום דבר
- **RestaurantLiveView** - יש `<select>` למעבר בין layouts אם יש יותר מאחד
- **FloorEditor** - טוען sections אבל סינון לפיהן לא עובד
- **מסך ארחות (host)** - מציג layout אחד פעיל, בלי אפשרות לבחור חלל
- **מסך מלצרים (waiter-map)** - מציג layout אחד פעיל
- **הזמנת מקום** - אין בחירת חלל/קומה

### מה חסר:
המערכת כבר תומכת טכנית ב-**כמה layouts** (שכל אחד מהם יכול לייצג קומה/חלל שונה), אבל הUI לא מנגיש את זה כראוי.

---

## תוכנית מימוש

### שלב 1: מודל נתונים - הוספת metadata ל-FloorLayout
**קובץ:** `services/floor_service.ts`

- הוספת שדות ל-`FloorLayout` interface:
  - `floorLabel?: string` - תווית תצוגה (למשל: "קומה 1", "גן", "בר", "מרפסת")
  - `displayOrder?: number` - סדר מיון

### שלב 2: FloorEditor - ניהול חללים
**קובץ:** `client/src/components/FloorEditor.tsx`

- עדכון טופס יצירת/עריכת layout להכיל שדה `floorLabel`
- הוספת `displayOrder` כדי לקבוע סדר tabs

### שלב 3: RestaurantLiveView - תצוגת tabs לחללים
**קובץ:** `client/src/components/RestaurantLiveView.tsx`

- החלפת ה-`<select>` ב-**tabs** ויזואליים (כפתורים) לכל layout/חלל
- הצגת שם החלל מ-`floorLabel` (או `name` כ-fallback)
- הצגת סטטיסטיקות לכל tab (כמה שולחנות תפוסים)

### שלב 4: מסך ארחות (Host) - tabs לחללים
**קובץ:** `templates/host_seating.eta`

- הוספת tabs מעל המפה לבחירת חלל/קומה
- טעינת כל ה-layouts ומעבר ביניהם
- שמירת הקשר: בחירת שולחן תשמור את ה-layout שממנו בא

### שלב 5: מסך מלצרים (Waiter Map) - tabs לחללים
**קובץ:** `templates/pos_waiter_map.eta`

- אותו דבר כמו host - tabs לכל layout/חלל
- לחיצה על שולחן תפוס פותחת את ההזמנה

### שלב 6: הזמנת מקום (Reservation) - בחירת חלל
**קובץ:** `templates/restaurant_detail.eta` + `routes/restaurants/reservation.controller.ts`

- הוספת dropdown/radio לבחירת חלל מועדף
- שמירת `preferredLayoutId` על ההזמנה (preference, לא binding)
- הצגת שם החלל בטופס ובאישור

### שלב 7: i18n - תרגומים
**קבצים:** `i18n/he.json`, `i18n/en.json`, `i18n/ka.json`

- מפתחות חדשים: `floor.tabs_label`, `floor.all_rooms`, `floor.room`, `reservation.preferred_room` וכו'

---

## קבצים שישתנו:

| קובץ | שינוי |
|---|---|
| `services/floor_service.ts` | הוספת `floorLabel`, `displayOrder` ל-FloorLayout |
| `client/src/components/FloorEditor.tsx` | שדות floorLabel, displayOrder בטופס |
| `client/src/components/RestaurantLiveView.tsx` | tabs במקום select, סטטיסטיקות per-tab |
| `templates/host_seating.eta` | tabs לחללים מעל המפה |
| `templates/pos_waiter_map.eta` | tabs לחללים |
| `templates/restaurant_detail.eta` | dropdown לבחירת חלל מועדף |
| `routes/restaurants/reservation.controller.ts` | שמירת preferredLayoutId |
| `database.ts` or models | הוספת preferredLayoutId ל-Reservation |
| `i18n/he.json`, `i18n/en.json`, `i18n/ka.json` | תרגומים חדשים |
| `public/css/` | CSS ל-tabs החדשים |
