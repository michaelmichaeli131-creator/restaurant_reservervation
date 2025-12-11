// src/services/staff_db.ts
// --------------------------------------------------------
// שכבת DB לעובדי מסעדה (StaffMember):
// - יצירת עובד ע"י בעל המסעדה (מאושר מראש)
// - יצירת עובד בהרשמה עצמית (pending)
// - יצירת עובד מאושר מתוך בקשת הצטרפות (signup approval)
// - רשימות עובדים למסעדה
// - עדכון סטטוס / הרשאות
// --------------------------------------------------------

import { kv } from "../database.ts";
import type {
  StaffMember,
  StaffRole,
  StaffPermission,
  StaffApprovalStatus,
} from "../database.ts";
import { defaultPermissionsForRole } from "./staff_permissions.ts";

const now = () => Date.now();

/* ─────────────── Key helpers ─────────────── */

// הערך המלא של העובד לפי מסעדה+משתמש
function staffMainKey(restaurantId: string, userId: string) {
  return ["staff", restaurantId, userId] as const;
}

// אינדקס לפי staffId → { restaurantId, userId }
function staffIdKey(staffId: string) {
  return ["staff_by_id", staffId] as const;
}

// אינדקס: כל העובדים במסעדה
function staffByRestaurantKey(restaurantId: string, staffId: string) {
  return ["staff_by_restaurant", restaurantId, staffId] as const;
}

// אינדקס: כל המסעדות שבהן משתמש הוא עובד
function staffByUserKey(userId: string, staffId: string) {
  return ["staff_by_user", userId, staffId] as const;
}

/* ─────────────── יצירה ─────────────── */

/**
 * יצירת עובד ע"י בעל המסעדה:
 * - approvalStatus = "approved"
 * - permissions = ברירת מחדל לפי role או מה שהבעלים ביקש
 */
export async function createStaffByOwner(data: {
  restaurantId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: StaffRole;
  hourlyRate?: number;
  hireDate?: number;
  permissionsOverride?: StaffPermission[]; // אופציונלי: הבעלים קובע ידנית
}): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const ts = now();

  const staff: StaffMember = {
    id,
    restaurantId: data.restaurantId,
    userId: data.userId,
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email.toLowerCase(),
    phone: data.phone?.trim(),
    role: data.role,
    hourlyRate: data.hourlyRate,
    status: "active",
    approvalStatus: "approved",
    permissions: data.permissionsOverride && data.permissionsOverride.length
      ? data.permissionsOverride.slice()
      : defaultPermissionsForRole(data.role),
    hireDate: data.hireDate ?? ts,
    createdAt: ts,
  };

  const mainKey = staffMainKey(staff.restaurantId, staff.userId);
  const idKey = staffIdKey(staff.id);
  const byRestKey = staffByRestaurantKey(staff.restaurantId, staff.id);
  const byUserKey = staffByUserKey(staff.userId, staff.id);

  const tx = kv.atomic()
    .set(mainKey, staff)
    .set(idKey, { restaurantId: staff.restaurantId, userId: staff.userId })
    .set(byRestKey, 1)
    .set(byUserKey, 1);

  const res = await tx.commit();
  if (!res.ok) throw new Error("create_staff_race");

  return staff;
}

/**
 * יצירת עובד בהרשמה עצמית:
 * - approvalStatus = "pending"
 * - permissions = [] (הבעלים יקבע אח"כ)
 */
export async function createStaffSelfRegistration(data: {
  restaurantId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: StaffRole;
}): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const ts = now();

  const staff: StaffMember = {
    id,
    restaurantId: data.restaurantId,
    userId: data.userId,
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
    email: data.email.toLowerCase(),
    phone: data.phone?.trim(),
    role: data.role,
    status: "active",
    approvalStatus: "pending",
    permissions: [], // יקבלו אח"כ ע"י בעל המסעדה
    hireDate: ts,
    createdAt: ts,
  };

  const mainKey = staffMainKey(staff.restaurantId, staff.userId);
  const idKey = staffIdKey(staff.id);
  const byRestKey = staffByRestaurantKey(staff.restaurantId, staff.id);
  const byUserKey = staffByUserKey(staff.userId, staff.id);

  const tx = kv.atomic()
    .set(mainKey, staff)
    .set(idKey, { restaurantId: staff.restaurantId, userId: staff.userId })
    .set(byRestKey, 1)
    .set(byUserKey, 1);

  const res = await tx.commit();
  if (!res.ok) throw new Error("create_staff_race");

  return staff;
}

/* ─────────────── קריאה ─────────────── */

/** קבלת StaffMember לפי (restaurantId, userId) – תואם ל-authz.ts */
export async function getStaffByRestaurantAndUser(
  restaurantId: string,
  userId: string,
): Promise<StaffMember | null> {
  const res = await kv.get<StaffMember>(staffMainKey(restaurantId, userId));
  return res.value ?? null;
}

/** קבלת StaffMember לפי staffId */
export async function getStaffById(staffId: string): Promise<StaffMember | null> {
  const ref = await kv.get<{ restaurantId: string; userId: string }>(staffIdKey(staffId));
  if (!ref.value) return null;
  const { restaurantId, userId } = ref.value;
  const staff = await kv.get<StaffMember>(staffMainKey(restaurantId, userId));
  return staff.value ?? null;
}

/** כל העובדים במסעדה */
export async function listStaffByRestaurant(
  restaurantId: string,
  opts: { includeInactive?: boolean; onlyPending?: boolean } = {},
): Promise<StaffMember[]> {
  const staff: StaffMember[] = [];

  for await (const row of kv.list({ prefix: ["staff_by_restaurant", restaurantId] })) {
    const staffId = row.key[row.key.length - 1] as string;
    const s = await getStaffById(staffId);
    if (!s) continue;

    if (!opts.includeInactive && s.status !== "active") continue;
    if (opts.onlyPending && s.approvalStatus !== "pending") continue;

    staff.push(s);
  }

  // חדש → ישן
  staff.sort((a, b) => b.createdAt - a.createdAt);
  return staff;
}

/** כל המסעדות שבהן המשתמש רשום כעובד (מאושר או לא) */
export async function listStaffMembershipsByUser(userId: string): Promise<StaffMember[]> {
  const items: StaffMember[] = [];

  for await (const row of kv.list({ prefix: ["staff_by_user", userId] })) {
    const staffId = row.key[row.key.length - 1] as string;
    const s = await getStaffById(staffId);
    if (s) items.push(s);
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

/* ─────────────── עדכון ─────────────── */

export async function updateStaff(
  staffId: string,
  patch: Partial<StaffMember>,
): Promise<StaffMember | null> {
  const cur = await getStaffById(staffId);
  if (!cur) return null;

  const merged: StaffMember = {
    ...cur,
    ...patch,
    id: cur.id,
    restaurantId: cur.restaurantId,
    userId: cur.userId,
    createdAt: cur.createdAt,
  };

  await kv.set(staffMainKey(merged.restaurantId, merged.userId), merged);
  return merged;
}

/** שינוי סטטוס אישור (pending/approved/rejected) */
export async function setStaffApproval(
  staffId: string,
  approvalStatus: StaffApprovalStatus,
): Promise<StaffMember | null> {
  return await updateStaff(staffId, { approvalStatus });
}

/** שינוי סטטוס תעסוקה (active / inactive / on_leave) */
export async function setStaffStatus(
  staffId: string,
  status: StaffMember["status"],
): Promise<StaffMember | null> {
  return await updateStaff(staffId, { status });
}

/** עדכון הרשאות מלאות לעובד */
export async function setStaffPermissions(
  staffId: string,
  permissions: StaffPermission[],
): Promise<StaffMember | null> {
  return await updateStaff(staffId, {
    permissions: permissions.slice(),
  });
}

/** איפוס הרשאות לברירת המחדל לפי role */
export async function resetStaffPermissionsToDefault(
  staffId: string,
): Promise<StaffMember | null> {
  const cur = await getStaffById(staffId);
  if (!cur) return null;
  return await updateStaff(staffId, {
    permissions: defaultPermissionsForRole(cur.role),
  });
}

/* ─────────────── מחיקה רכה/קשיחה ─────────────── */

/**
 * "מחיקה רכה" – הופך ל-inactive + מוריד הרשאות.
 * (כדי לשמור היסטוריה במשמרות / דוחות)
 */
export async function softDeleteStaff(
  staffId: string,
): Promise<StaffMember | null> {
  return await updateStaff(staffId, {
    status: "inactive",
    permissions: [],
  });
}

/**
 * מחיקה קשיחה של עובד + אינדקסים.
 * ⚠️ שימוש בזה בזהירות – ייתכן שתשבור רפרנסים בהמשך (למשמרות וכו').
 */
export async function hardDeleteStaff(staffId: string): Promise<boolean> {
  const ref = await kv.get<{ restaurantId: string; userId: string }>(staffIdKey(staffId));
  if (!ref.value) return false;
  const { restaurantId, userId } = ref.value;

  const mainKey = staffMainKey(restaurantId, userId);
  const byRestKey = staffByRestaurantKey(restaurantId, staffId);
  const byUserKey = staffByUserKey(userId, staffId);

  const tx = kv.atomic()
    .delete(mainKey)
    .delete(staffIdKey(staffId))
    .delete(byRestKey)
    .delete(byUserKey);

  const res = await tx.commit();
  return res.ok;
}

/* ─────────────── יצירת עובד מאושר מתוך בקשת הצטרפות ─────────────── */
/**
 * helper קטן לשימוש במסך בעלים:
 * כשבעלים מאשר StaffSignupRequest, אפשר לקרוא לפונקציה הזו
 * כדי ליצור רשומת StaffMember מאושרת עם הרשאות דיפולטיות (או override).
 *
 * ⚠️ הפונקציה *לא* נוגעת בבקשת ההצטרפות עצמה (לא משנה status של signup),
 * זה נעשה בשכבה אחרת (owner_staff.ts / database.ts).
 */
export async function createApprovedStaffFromSignup(args: {
  restaurantId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: StaffRole;
  permissionsOverride?: StaffPermission[];
}): Promise<StaffMember> {
  return await createStaffByOwner({
    restaurantId: args.restaurantId,
    userId: args.userId,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    phone: args.phone,
    role: args.role,
    hourlyRate: undefined,
    hireDate: undefined,
    permissionsOverride: args.permissionsOverride,
  });
}

