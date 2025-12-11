// src/routes/owner_staff.ts
// --------------------------------------------------------
// ניהול עובדים ע"י בעל המסעדה:
// - רשימת עובדים למסעדות שלו
// - עובדים ממתינים (pending)
// - אישור / דחייה
// - עדכון הרשאות
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";

import {
  kv,
  type User,
  type Restaurant,
  type StaffPermission,
  getRestaurant,
} from "../database.ts";

import {
  listStaffByRestaurant,
  getStaffById,
  setStaffApproval,
  setStaffPermissions,
  resetStaffPermissionsToDefault,
} from "../services/staff_db.ts";

export const ownerStaffRouter = new Router();

// כל הראוטר הזה מוגן – רק בעלים
ownerStaffRouter.use(requireOwner as any);

/* ─────────────── Helpers ─────────────── */

const ALL_PERMISSIONS: StaffPermission[] = [
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

// מסעדות של הבעלים (מבוסס על restaurant_by_owner)
async function listOwnerRestaurants(ownerId: string): Promise<Restaurant[]> {
  const restaurants: Restaurant[] = [];

  for await (const row of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = row.key[row.key.length - 1] as string;
    const r = await getRestaurant(rid);
    if (r) restaurants.push(r);
  }

  restaurants.sort((a, b) => b.createdAt - a.createdAt);
  return restaurants;
}

function ensureOwner(ctx: any): User {
  const user = ctx.state.user as User | undefined;
  if (!user || user.role !== "owner") {
    const err: any = new Error("Not owner");
    err.status = Status.Forbidden;
    throw err;
  }
  return user;
}

/* ─────────────── GET: מסך ניהול עובדים ─────────────── */
/**
 * GET /owner/staff
 * מציג:
 * - רשימת מסעדות של הבעלים
 * - לכל מסעדה: עובדים מאושרים + עובדים ממתינים
 */
ownerStaffRouter.get("/owner/staff", async (ctx) => {
  const owner = ensureOwner(ctx);

  const restaurants = await listOwnerRestaurants(owner.id);

  const items: Array<{
    restaurant: Restaurant;
    staff: Awaited<ReturnType<typeof listStaffByRestaurant>>;
    pending: Awaited<ReturnType<typeof listStaffByRestaurant>>;
  }> = [];

  for (const r of restaurants) {
    const all = await listStaffByRestaurant(r.id, { includeInactive: true });
    const pending = all.filter((s) => s.approvalStatus === "pending");
    const active = all.filter((s) => s.approvalStatus === "approved");
    items.push({
      restaurant: r,
      staff: active,
      pending,
    });
  }

  await render(ctx, "owner/staff", {
    title: "ניהול עובדים",
    owner,
    restaurantsData: items,
    allPermissions: ALL_PERMISSIONS,
  });
});

/* ─────────────── POST: אישור עובד ─────────────── */
/**
 * POST /owner/staff/:id/approve
 * body (אופציונלי):
 *   permissions=... (multi-select)
 *   useDefaults=on  → אם לא נשלחו הרשאות, אך רוצים ברירות מחדל
 */
ownerStaffRouter.post("/owner/staff/:id/approve", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  const staff = await getStaffById(staffId);
  if (!staff) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Staff not found";
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  // קבלת הרשאות מהטופס (אם יש)
  const rawPerms = form.getAll("permissions") as string[] | undefined;
  const useDefaults = form.get("useDefaults") === "on";

  let newPermissions: StaffPermission[] | undefined;

  if (rawPerms && rawPerms.length > 0) {
    const filtered: StaffPermission[] = [];
    for (const p of rawPerms) {
      if (ALL_PERMISSIONS.includes(p as StaffPermission)) {
        filtered.push(p as StaffPermission);
      }
    }
    newPermissions = filtered;
  }

  // אישור העובד
  await setStaffApproval(staffId, "approved");

  // אם נבחרו הרשאות ספציפיות – לעדכן אותן
  if (newPermissions && newPermissions.length > 0) {
    await setStaffPermissions(staffId, newPermissions);
  } else if (useDefaults) {
    // אם לא נבחר ספציפי אך ביקשו ברירת מחדל
    await resetStaffPermissionsToDefault(staffId);
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: דחיית עובד ─────────────── */
/**
 * POST /owner/staff/:id/reject
 */
ownerStaffRouter.post("/owner/staff/:id/reject", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  const staff = await getStaffById(staffId);
  if (!staff) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Staff not found";
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  // דחייה: נסמן approvalStatus="rejected" ומשאיר את הרשומה (שיקוף ללוגים)
  await setStaffApproval(staffId, "rejected");

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: עדכון הרשאות של עובד ─────────────── */
/**
 * POST /owner/staff/:id/permissions
 * body:
 *   permissions=... (multi-select)
 */
ownerStaffRouter.post("/owner/staff/:id/permissions", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  const staff = await getStaffById(staffId);
  if (!staff) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Staff not found";
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  const rawPerms = form.getAll("permissions") as string[] | undefined;
  const resetToDefaults = form.get("resetToDefaults") === "on";

  if (resetToDefaults) {
    await resetStaffPermissionsToDefault(staffId);
  } else {
    const filtered: StaffPermission[] = [];
    if (rawPerms) {
      for (const p of rawPerms) {
        if (ALL_PERMISSIONS.includes(p as StaffPermission)) {
          filtered.push(p as StaffPermission);
        }
      }
    }
    await setStaffPermissions(staffId, filtered);
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});
