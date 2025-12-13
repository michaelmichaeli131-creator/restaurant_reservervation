// src/services/staff_db.ts
// --------------------------------------------------------
// שכבת DB לעובדי מסעדה (StaffMember):
// - יצירת עובד ע"י בעל המסעדה (מאושר מראש)
// - רשימות עובדים למסעדה / לפי משתמש
// - עדכון סטטוס / הרשאות / אישור
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

type StaffIdIndex = { restaurantId: string; userId: string };

/* ─────────────── Fetch helpers ─────────────── */

export async function getStaffByRestaurantAndUser(
  restaurantId: string,
  userId: string,
): Promise<StaffMember | null> {
  const res = await kv.get<StaffMember>(staffMainKey(restaurantId, userId));
  return res.value ?? null;
}

export async function getStaffById(staffId: string): Promise<StaffMember | null> {
  const idx = await kv.get<StaffIdIndex>(staffIdKey(staffId));
  if (!idx.value) return null;
  const res = await kv.get<StaffMember>(staffMainKey(idx.value.restaurantId, idx.value.userId));
  return res.value ?? null;
}

export async function listStaffMembershipsByUser(userId: string): Promise<StaffMember[]> {
  const out: StaffMember[] = [];
  for await (const row of kv.list({ prefix: ["staff_by_user", userId] })) {
    const staffId = row.key[row.key.length - 1] as string;
    const s = await getStaffById(staffId);
    if (s) out.push(s);
  }
  // newest first
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return out;
}

export async function listStaffByRestaurant(
  restaurantId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<StaffMember[]> {
  const out: StaffMember[] = [];
  for await (const row of kv.list({ prefix: ["staff_by_restaurant", restaurantId] })) {
    const staffId = row.key[row.key.length - 1] as string;
    const s = await getStaffById(staffId);
    if (!s) continue;
    if (!opts.includeInactive && s.status === "inactive") continue;
    out.push(s);
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return out;
}

/* ─────────────── Create ─────────────── */

export async function createStaffByOwner(args: {
  restaurantId: string;
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role: StaffRole;
  permissions?: StaffPermission[];
  useDefaults?: boolean;
}): Promise<StaffMember> {
  const restaurantId = args.restaurantId;
  const userId = args.userId;

  const existing = await getStaffByRestaurantAndUser(restaurantId, userId);
  if (existing) {
    const err: any = new Error("Staff already exists for this user+restaurant");
    err.code = "staff_exists";
    throw err;
  }

  const id = crypto.randomUUID();
  const createdAt = now();

  const permissions = (args.useDefaults || !args.permissions?.length)
    ? defaultPermissionsForRole(args.role)
    : args.permissions;

  const staff: StaffMember = {
    id,
    restaurantId,
    userId,
    email: args.email,
    firstName: args.firstName || "",
    lastName: args.lastName || "",
    phone: args.phone,
    role: args.role,
    status: "active",
    approvalStatus: "approved",
    permissions,
    hireDate: createdAt,
    createdAt,
  };

  // atomic write
  const idx: StaffIdIndex = { restaurantId, userId };
  const tx = kv.atomic()
    .check({ key: staffMainKey(restaurantId, userId), versionstamp: null })
    .check({ key: staffIdKey(id), versionstamp: null })
    .set(staffMainKey(restaurantId, userId), staff)
    .set(staffIdKey(id), idx)
    .set(staffByRestaurantKey(restaurantId, id), true)
    .set(staffByUserKey(userId, id), true);

  const res = await tx.commit();
  if (!res.ok) throw new Error("Failed to create staff (atomic commit failed)");

  return staff;
}

/* ─────────────── Updates ─────────────── */

async function updateStaff(staffId: string, patch: Partial<StaffMember>): Promise<StaffMember> {
  const current = await getStaffById(staffId);
  if (!current) {
    const err: any = new Error("Staff not found");
    err.code = "not_found";
    throw err;
  }

  const next: StaffMember = { ...current, ...patch };
  const tx = kv.atomic()
    .set(staffMainKey(current.restaurantId, current.userId), next)
    .set(staffIdKey(staffId), { restaurantId: current.restaurantId, userId: current.userId });

  const res = await tx.commit();
  if (!res.ok) throw new Error("Failed to update staff");
  return next;
}

export async function setStaffApproval(
  staffId: string,
  approvalStatus: StaffApprovalStatus,
): Promise<StaffMember> {
  return await updateStaff(staffId, { approvalStatus });
}

export async function setStaffPermissions(
  staffId: string,
  permissions: StaffPermission[],
): Promise<StaffMember> {
  return await updateStaff(staffId, { permissions });
}

export async function resetStaffPermissionsToDefault(
  staffId: string,
): Promise<StaffMember> {
  const current = await getStaffById(staffId);
  if (!current) {
    const err: any = new Error("Staff not found");
    err.code = "not_found";
    throw err;
  }
  const perms = defaultPermissionsForRole(current.role);
  return await updateStaff(staffId, { permissions: perms });
}

// שלב 7.1: השבתה/הפעלה של עובד
export async function setStaffStatus(
  staffId: string,
  status: StaffMember["status"],
): Promise<StaffMember> {
  return await updateStaff(staffId, { status });
}
