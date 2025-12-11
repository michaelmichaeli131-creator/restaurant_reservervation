// src/routes/owner_staff.ts
// --------------------------------------------------------
// ניהול עובדים ע"י בעל המסעדה:
// - רשימת עובדים למסעדות שלו
// - עובדים ממתינים (pending) לפי staff_db
// - בקשות הצטרפות חדשות (StaffSignupRequest) מעובדים שנרשמו לבד
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
  type StaffSignupRequest,
  getRestaurant,
  getUserById,
  listStaffSignupRequestsForOwner,
  getStaffSignupRequest,
  updateStaffSignupStatus,
} from "../database.ts";

import {
  listStaffByRestaurant,
  getStaffById,
  setStaffApproval,
  setStaffPermissions,
  resetStaffPermissionsToDefault,
  getStaffByRestaurantAndUser,       // ← חדש
  createApprovedStaffFromSignup,     // ← חדש
} from "../services/staff_db.ts";

export const ownerStaffRouter = new Router();

// 🔎 לוג טעינת מודול – כדי לוודא שהקובץ עולה
console.log("[owner_staff] module loaded");

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

type SignupRequestWithUser = {
  request: StaffSignupRequest;
  user: User | null;
};

/* ─────────────── GET: מסך ניהול עובדים ─────────────── */
/**
 * GET /owner/staff
 * מציג:
 * - רשימת מסעדות של הבעלים
 * - לכל מסעדה:
 *    • עובדים מאושרים
 *    • עובדים ממתינים (לפי staff_db)
 *    • בקשות הצטרפות חדשות (עובדים שנרשמו בעצמם כ"staff")
 */
ownerStaffRouter.get("/owner/staff", async (ctx) => {
  const reqId = (ctx.state as any).reqId;
  console.log("[owner_staff] GET /owner/staff – handler start", {
    reqId,
    userId: (ctx.state as any).user?.id,
    userEmail: (ctx.state as any).user?.email,
  });

  const owner = ensureOwner(ctx);

  const restaurants = await listOwnerRestaurants(owner.id);

  // בקשות הצטרפות (StaffSignupRequest) לכל המסעדות של הבעלים
  const rawSignupRequests = await listStaffSignupRequestsForOwner(owner.id, "pending");
  const signupRequestsByRestaurant = new Map<string, SignupRequestWithUser[]>();

  for (const req of rawSignupRequests) {
    const u = await getUserById(req.userId);
    const arr = signupRequestsByRestaurant.get(req.restaurantId) ?? [];
    arr.push({ request: req, user: u });
    signupRequestsByRestaurant.set(req.restaurantId, arr);
  }

  const items: Array<{
    restaurant: Restaurant;
    staff: Awaited<ReturnType<typeof listStaffByRestaurant>>;
    pending: Awaited<ReturnType<typeof listStaffByRestaurant>>;
    signupRequests: SignupRequestWithUser[];
  }> = [];

  for (const r of restaurants) {
    const all = await listStaffByRestaurant(r.id, { includeInactive: true });
    const pending = all.filter((s) => s.approvalStatus === "pending");
    const active = all.filter((s) => s.approvalStatus === "approved");
    const signupRequests = signupRequestsByRestaurant.get(r.id) ?? [];

    items.push({
      restaurant: r,
      staff: active,
      pending,
      signupRequests,
    });
  }

  console.log("[owner_staff] GET /owner/staff – rendering template", {
    reqId,
    restaurantsCount: restaurants.length,
  });

  await render(ctx, "owner/staff", {
    title: "ניהול עובדים",
    owner,
    restaurantsData: items,
    allPermissions: ALL_PERMISSIONS,
  });

  console.log("[owner_staff] GET /owner/staff – done", { reqId });
});

// אליאס לנתיב עם סלאש בסוף, ליתר ביטחון
ownerStaffRouter.get("/owner/staff/", (ctx) => {
  const reqId = (ctx.state as any).reqId;
  console.log("[owner_staff] GET /owner/staff/ – redirecting to /owner/staff", {
    reqId,
  });
  ctx.response.status = Status.PermanentRedirect;
  ctx.response.headers.set("Location", "/owner/staff");
});

/* ─────────────── POST: אישור עובד קיים (staff_db) ─────────────── */
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

/* ─────────────── POST: דחיית עובד קיים (staff_db) ─────────────── */
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

/* ─────────────── POST: עדכון הרשאות של עובד קיים ─────────────── */
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

/* ─────────────── POST: אישור / דחיית בקשת הצטרפות (StaffSignupRequest) ─────────────── */
/**
 * עובדים שנרשמו כ-"staff" דרך /auth/register יוצרים StaffSignupRequest.
 * כאן בעל המסעדה יכול לאשר / לדחות את הבקשה.
 *
 * בעת אישור:
 *  - מעדכנים סטטוס בבקשה עצמה (pending → approved)
 *  - ואם המשתמש קיים ואין כבר StaffMember באותה מסעדה → יוצרים StaffMember מאושר
 *    עם הרשאות דיפולטיות לפי role (או הרחבות בעתיד).
 */

/** אישור בקשת הצטרפות */
ownerStaffRouter.post("/owner/staff-signup/:id/approve", async (ctx) => {
  const owner = ensureOwner(ctx);
  const id = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  const req = await getStaffSignupRequest(id);
  if (!req) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Signup request not found";
    return;
  }

  const restaurant = await getRestaurant(req.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  // ננסה להביא את המשתמש עצמו
  const user = await getUserById(req.userId);
  if (!user) {
    console.warn("[owner_staff] signup request user not found", {
      userId: req.userId,
      requestId: id,
    });
  } else {
    // נבדוק אם כבר קיימת רשומת StaffMember למסעדה הזו
    const existing = await getStaffByRestaurantAndUser(req.restaurantId, user.id);
    if (!existing) {
      try {
        await createApprovedStaffFromSignup({
          restaurantId: req.restaurantId,
          userId: user.id,
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          email: user.email,
          phone: user.phone || undefined,
          role: req.staffRole,             // מתוך StaffSignupRequest
          // permissionsOverride: אפשר להוסיף בעתיד אם נרצה לקחת מהטופס
        });
      } catch (e) {
        console.error(
          "[owner_staff] failed to create StaffMember from signup request",
          e,
        );
      }
    }
  }

  // מעדכנים סטטוס הבקשה ל-approved (גם אם יצירת ה-Staff נכשלה – שומרים התנהגות סבירה)
  await updateStaffSignupStatus(id, "approved");

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/** דחיית בקשת הצטרפות */
ownerStaffRouter.post("/owner/staff-signup/:id/reject", async (ctx) => {
  const owner = ensureOwner(ctx);
  const id = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  const req = await getStaffSignupRequest(id);
  if (!req) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Signup request not found";
    return;
  }

  const restaurant = await getRestaurant(req.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  await updateStaffSignupStatus(id, "rejected");

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});
