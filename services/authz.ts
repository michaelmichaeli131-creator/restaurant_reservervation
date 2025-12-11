// src/services/authz.ts
// --------------------------------------------------------
// שכבת הרשאות: בעל מסעדה / עובד מאושר / הרשאות ספציפיות.
// משמשת להגנה על כל הראוטרים שקשורים למסעדה מסוימת.
//
// פונקציות מרכזיות:
// - getStaffMembership()
// - userHasPermission()
// - requireRestaurantAccess()
// - requirePermission()
// --------------------------------------------------------

import { kv } from "../database.ts";
import type {
  User,
  StaffMember,
  StaffPermission,
} from "../database.ts";
import { hasPermission, hasAnyPermission } from "./staff_permissions.ts";

// Helper ליצירת מפתח KV זהה לזה של staff
function staffKey(restaurantId: string, userId: string) {
  return ["staff", restaurantId, userId];
}

/**
 * החזרת employment (רשומת StaffMember) עבור משתמש במסעדה.
 * מחפש לפי המפתח הקבוע: staff/<restaurantId>/<userId>
 */
export async function getStaffMembership(
  restaurantId: string,
  userId: string,
): Promise<StaffMember | null> {
  const res = await kv.get<StaffMember>(staffKey(restaurantId, userId));
  return res.value ?? null;
}

/**
 * בדיקת האם משתמש הוא הבעלים של המסעדה.
 */
export function isRestaurantOwner(user: User | null, restaurantId: string): boolean {
  if (!user) return false;
  // נבדוק ownerId ברמת הראוטר עם getRestaurant
  return user.role === "owner";
}

/**
 * בדיקה אם המשתמש הוא עובד מאושר במסעדה.
 */
export async function isApprovedStaff(
  userId: string,
  restaurantId: string,
): Promise<boolean> {
  const m = await getStaffMembership(restaurantId, userId);
  return !!m && m.approvalStatus === "approved" && m.status === "active";
}

/**
 * בדיקה אם למשתמש יש ההרשאה הנדרשת במסעדה.
 * אם המשתמש הוא בעל המסעדה → תמיד true.
 */
export async function userHasPermission(
  user: User | null,
  restaurantId: string,
  permission: StaffPermission,
): Promise<boolean> {
  if (!user) return false;

  // בעל מסעדה — גישה מלאה
  if (user.role === "owner") return true;

  if (user.role !== "staff") return false;

  const membership = await getStaffMembership(restaurantId, user.id);
  if (!membership) return false;

  if (membership.approvalStatus !== "approved") return false;

  return hasPermission(membership.permissions || [], permission);
}

/**
 * בדיקה אם יש לפחות אחת מקבוצת הרשאות.
 */
export async function userHasAnyPermission(
  user: User | null,
  restaurantId: string,
  permissions: StaffPermission[],
): Promise<boolean> {
  if (!user) return false;
  if (user.role === "owner") return true;

  const membership = await getStaffMembership(restaurantId, user.id);
  if (!membership) return false;
  if (membership.approvalStatus !== "approved") return false;

  return hasAnyPermission(membership.permissions || [], permissions);
}

/**
 * Middleware: דורש שהמשתמש יהיה בעלים או עובד מאושר של המסעדה.
 */
export async function requireRestaurantAccess(
  ctx: any,
  restaurantId: string,
) {
  const user = ctx.state.user as User | null;
  if (!user) {
    ctx.response.status = 401;
    ctx.response.body = "Not authenticated";
    return false;
  }

  // Owner — תמיד יכול
  if (user.role === "owner") return true;

  // Staff — חייב membership מאושר
  const membership = await getStaffMembership(restaurantId, user.id);
  if (!membership || membership.approvalStatus !== "approved") {
    ctx.response.status = 403;
    ctx.response.body = "No restaurant access";
    return false;
  }

  return true;
}

/**
 * Middleware: דורש הרשאה ספציפית.
 */
export async function requirePermission(
  ctx: any,
  restaurantId: string,
  permission: StaffPermission,
) {
  const user = ctx.state.user as User | null;

  if (!(await userHasPermission(user, restaurantId, permission))) {
    ctx.response.status = 403;
    ctx.response.body = "Permission denied";
    return false;
  }

  return true;
}
