// src/services/staff_permissions.ts
// ---------------------------------
// מיפוי הרשאות ברירת מחדל לפי תפקיד עובד במסעדה,
// + פונקציות עזר לעבודה עם הרשאות.
//
// הקובץ לא נוגע ב-KV – רק לוגיקה טהורה.

import type { StaffRole, StaffPermission } from "../database.ts";

/**
 * ברירת מחדל של הרשאות לפי תפקיד.
 * הבעלים תמיד יוכל לעדכן/להוסיף/להוריד הרשאות אלו דרך ה-UI.
 */
export function defaultPermissionsForRole(role: StaffRole): StaffPermission[] {
  switch (role) {
    case "waiter":
      return [
        "pos.waiter",
        "host.seating",
        "reservations.view",
      ];

    case "host":
      return [
        "host.seating",
        "reservations.view",
        "reservations.manage",
      ];

    case "kitchen":
      return [
        "pos.kitchen",
      ];

    case "shift_manager":
      return [
        "pos.waiter",
        "pos.kitchen",
        "host.seating",
        "reservations.view",
        "reservations.manage",
        "shifts.view",
        "shifts.manage",
      ];

    case "manager":
      return [
        "pos.waiter",
        "pos.kitchen",
        "host.seating",
        "reservations.view",
        "reservations.manage",
        "floor.view",
        "floor.edit",
        "shifts.view",
        "shifts.manage",
        "inventory.view",
        "inventory.manage",
        "reports.view",
        "menu.manage",
      ];

    case "chef":
      return [
        "pos.kitchen",
      ];

    case "bartender":
      // בהמשך אפשר להפריד למסך בר ייעודי
      return [
        "pos.kitchen",
      ];

    case "busser":
      return [
        "pos.waiter",
        "host.seating",
      ];

    default:
      // ברירת מחדל זהירה לתפקידים עתידיים/לא מוכרים
      return [
        "reservations.view",
      ];
  }
}

/**
 * האם הרשאות מסוימות מכילות הרשאה ספציפית.
 * שימושי ל־guards בראוטרים.
 */
export function hasPermission(
  permissions: StaffPermission[] | undefined | null,
  required: StaffPermission,
): boolean {
  if (!permissions || !permissions.length) return false;
  return permissions.includes(required);
}

/**
 * האם יש לפחות אחת מקבוצת הרשאות (OR).
 */
export function hasAnyPermission(
  permissions: StaffPermission[] | undefined | null,
  required: StaffPermission[],
): boolean {
  if (!permissions || !permissions.length) return false;
  for (const p of required) {
    if (permissions.includes(p)) return true;
  }
  return false;
}

/**
 * האם יש את כל הרשאות הקלט (AND).
 */
export function hasAllPermissions(
  permissions: StaffPermission[] | undefined | null,
  required: StaffPermission[],
): boolean {
  if (!permissions || !permissions.length) return false;
  for (const p of required) {
    if (!permissions.includes(p)) return false;
  }
  return true;
}
