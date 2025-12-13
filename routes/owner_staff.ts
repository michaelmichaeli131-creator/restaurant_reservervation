// routes/owner_staff.ts
// --------------------------------------------------------
// ניהול עובדים ע"י בעל המסעדה:
// - רשימת עובדים למסעדות שלו
// - עובדים ממתינים (pending) לפי staff_db
// - אישור / דחייה
// - עדכון הרשאות
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { hashPassword } from "../lib/auth.ts";

import {
  kv,
  type User,
  type Restaurant,
  type StaffPermission,
  type StaffRole,
  getRestaurant,
  getUserById,
  findUserByEmail,
  createUser,
  setEmailVerified,
  createResetToken,
} from "../database.ts";

import {
  listStaffByRestaurant,
  getStaffById,
  setStaffApproval,
  setStaffPermissions,
  resetStaffPermissionsToDefault,
  getStaffByRestaurantAndUser,
  createStaffByOwner,
  setStaffStatus,
} from "../services/staff_db.ts";

import {
  logAuditEvent,
  listAuditEventsForRestaurant,
} from "../services/audit_log.ts";

export const ownerStaffRouter = new Router();

// 🔎 לוג בעת טעינת המודול – עוזר לוודא שהקובץ בכלל נטען
console.log("[owner_staff] router module loaded");

/**
 * שים לב: *לא* משתמשים כאן ב:
 *   ownerStaffRouter.use(requireOwner as any);
 * כי requireOwner הוא לא middleware של Oak (הוא מחזיר boolean ולא קורא next),
 * וזה עלול לקטוע את השרשרת ולהפיל אותנו ל-404.
 *
 * במקום זה – משתמשים בפונקציה ensureOwner(ctx) בכל handler, כמו ב-routes/owner.ts.
 */

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

// בדיקה פנימית שהמשתמש הוא owner – משתמשת ב־ctx.state.user
function ensureOwner(ctx: any): User {
  const user = ctx.state.user as User | undefined;

  if (!user || user.role !== "owner") {
    console.warn("[owner_staff] ensureOwner failed", {
      hasUser: Boolean(user),
      role: user?.role,
      path: ctx.request.url.pathname,
    });
    const err: any = new Error("Not owner");
    err.status = Status.Forbidden;
    throw err;
  }

  return user;
}

type OwnerCreateStaffPayload = {
  restaurantId: string;
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role: StaffRole;
  permissions?: string[];
  useDefaults?: boolean;
};

const STAFF_ROLE_OPTIONS: Array<{ value: StaffRole; label: string }> = [
  { value: "manager", label: "מנהל/ת" },
  { value: "shift_manager", label: "אחמ״ש/ית" },
  { value: "host", label: "מארח/ת" },
  { value: "waiter", label: "מלצר/ית" },
  { value: "busser", label: "ראנר/בוסייר" },
  { value: "bartender", label: "ברמן/ית" },
  { value: "chef", label: "שף/ית" },
  { value: "kitchen", label: "מטבח" },
];

const STAFF_ROLES: StaffRole[] = [
  "manager",
  "chef",
  "waiter",
  "busser",
  "host",
  "bartender",
  "kitchen",
  "shift_manager",
];

function isStaffRole(x: unknown): x is StaffRole {
  return typeof x === "string" && STAFF_ROLES.includes(x as StaffRole);
}

/* ✅ MIN FIX: קריאה יציבה של body (JSON / form / form-data) לפי Content-Type
   - בלי לקרוא ctx.request.body() פעמיים
   - זה פותר invalid_body כשאתה שולח fetch עם application/json
*/
function parseBool(x: unknown): boolean {
  return x === true || x === "true" || x === "on" || x === 1 || x === "1";
}

function parsePerms(x: unknown): string[] | undefined {
  if (Array.isArray(x)) return x.map((v) => String(v));
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return undefined;
    // תומך גם ב-"a,b,c" וגם ב-"a"
    return s.includes(",")
      ? s.split(",").map((t) => t.trim()).filter(Boolean)
      : [s];
  }
  return undefined;
}

async function readOwnerCreateStaffPayload(ctx: any): Promise<OwnerCreateStaffPayload> {
  const ct = (ctx.request.headers.get("content-type") || "").toLowerCase();

  // JSON
  if (ct.includes("application/json")) {
    const v = await ctx.request.body({ type: "json" }).value;
    return {
      restaurantId: String(v?.restaurantId ?? "").trim(),
      email: String(v?.email ?? "").trim(),
      password: String(v?.password ?? ""),
      firstName: v?.firstName ? String(v.firstName).trim() : undefined,
      lastName: v?.lastName ? String(v.lastName).trim() : undefined,
      phone: v?.phone ? String(v.phone).trim() : undefined,
      role: String(v?.role ?? "") as StaffRole,
      permissions: parsePerms(v?.permissions),
      useDefaults: parseBool(v?.useDefaults),
    };
  }

  // Form (x-www-form-urlencoded)
  try {
    const form = await ctx.request.body({ type: "form" }).value;
    const perms = (form.getAll("permissions") as string[] | undefined) ?? undefined;

    return {
      restaurantId: String(form.get("restaurantId") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
      firstName: form.get("firstName") ? String(form.get("firstName")).trim() : undefined,
      lastName: form.get("lastName") ? String(form.get("lastName")).trim() : undefined,
      phone: form.get("phone") ? String(form.get("phone")).trim() : undefined,
      role: String(form.get("role") ?? "") as StaffRole,
      permissions: perms && perms.length ? perms.map(String) : undefined,
      useDefaults: form.get("useDefaults") === "on",
    };
  } catch {
    // multipart/form-data (fallback)
    const fd = await ctx.request.body({ type: "form-data" }).value;
    const data = await fd.read();
    const fields = data.fields || {};

    // permissions יכול להיות שדה יחיד או מערך – תלוי איך נשלח
    const permsRaw: unknown = (fields as any).permissions;
    const perms = Array.isArray(permsRaw)
      ? permsRaw.map((x) => String(x))
      : (typeof permsRaw === "string" && permsRaw ? [permsRaw] : undefined);

    return {
      restaurantId: String((fields as any).restaurantId ?? "").trim(),
      email: String((fields as any).email ?? "").trim(),
      password: String((fields as any).password ?? ""),
      firstName: (fields as any).firstName ? String((fields as any).firstName).trim() : undefined,
      lastName: (fields as any).lastName ? String((fields as any).lastName).trim() : undefined,
      phone: (fields as any).phone ? String((fields as any).phone).trim() : undefined,
      role: String((fields as any).role ?? "") as StaffRole,
      permissions: perms,
      useDefaults: parseBool((fields as any).useDefaults),
    };
  }
}

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
  // וידוא owner (משתמש ב-ctx.state.user שקיים אחרי ה-AUTH_GATE)
  const owner = ensureOwner(ctx);
  console.log("[owner_staff] GET /owner/staff – start", {
    ownerId: owner.id,
    ownerEmail: owner.email,
  });

  const restaurants = await listOwnerRestaurants(owner.id);
  console.log("[owner_staff] owner restaurants loaded", {
    count: restaurants.length,
    ids: restaurants.map((r) => r.id),
  });

  // Staff signup requests removed (staff is created only by owners)

  const items: Array<{
    restaurant: Restaurant;
    staff: Awaited<ReturnType<typeof listStaffByRestaurant>>;
    pending: Awaited<ReturnType<typeof listStaffByRestaurant>>;
  }> = [];

  for (const r of restaurants) {
    const all = await listStaffByRestaurant(r.id, { includeInactive: true });
    const pending = all.filter((s) => s.approvalStatus === "pending");
    const active = all.filter((s) => s.approvalStatus === "approved");
    console.log("[owner_staff] restaurant block", {
      restaurantId: r.id,
      name: r.name,
      staffCount: all.length,
      activeCount: active.length,
      pendingCount: pending.length,
      signupRequestsCount: 0,
    });

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
    staffRoleOptions: STAFF_ROLE_OPTIONS,
    allPermissions: ALL_PERMISSIONS,
  });

  console.log("[owner_staff] GET /owner/staff – render done");
});

/* ─────────────── POST: יצירת עובד ע"י בעל מסעדה ─────────────── */
/**
 * POST /owner/staff/create
 * יוצר (במידת הצורך) User חדש עם role="staff" + StaffMember מאושר למסעדה.
 *
 * Body (JSON או form):
 *   restaurantId, email, password, firstName?, lastName?, phone?, role, permissions[]?, useDefaults?
 */
ownerStaffRouter.post("/owner/staff/create", async (ctx) => {
  const owner = ensureOwner(ctx);

  let payload: OwnerCreateStaffPayload;
  try {
    payload = await readOwnerCreateStaffPayload(ctx);
  } catch (e) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "invalid_body", message: String(e) };
    return;
  }

  const restaurantId = (payload.restaurantId || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const password = String(payload.password ?? "");
  const role = payload.role;

  if (!restaurantId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "restaurant_required" };
    return;
  }
  if (!email || !email.includes("@")) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "email_invalid" };
    return;
  }
  if (!password || password.length < 8) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "password_too_short", min: 8 };
    return;
  }
  if (!isStaffRole(role)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "role_invalid" };
    return;
  }

  // verify owner owns restaurant
  const restaurant = await getRestaurant(restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "not_your_restaurant" };
    return;
  }

  // find or create user
  let user = await findUserByEmail(email);
  if (user && user.role !== "staff") {
    ctx.response.status = Status.Conflict;
    ctx.response.body = {
      ok: false,
      error: "email_in_use",
      message: "האימייל כבר בשימוש למשתמש מסוג אחר. השתמש באימייל אחר לעובד.",
    };
    return;
  }

  if (!user) {
    const passwordHash = await hashPassword(password);
    try {
      user = await createUser({
        email,
        firstName: payload.firstName ?? "",
        lastName: payload.lastName ?? "",
        passwordHash,
        role: "staff",
        provider: "local",
        emailVerified: true,
      });
    } catch (e) {
      ctx.response.status = Status.Conflict;
      ctx.response.body = { ok: false, error: "user_create_failed", message: String(e) };
      return;
    }
  } else {
    // ensure not blocked by email verification for staff created historically
    if (!user.emailVerified) {
      await setEmailVerified(user.id);
    }
  }

  // prevent duplicates
  const existing = await getStaffByRestaurantAndUser(restaurantId, user.id);
  if (existing) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: "staff_exists", staffId: existing.id };
    return;
  }

  // 7.3: permissions defaults are decided on the server.
  // - if useDefaults: ignore any permissions sent from client
  // - else: accept only whitelisted permissions (and require at least one)
  const useDefaults = Boolean(payload.useDefaults);
  let permissions: StaffPermission[] | undefined;

  if (!useDefaults) {
    const rawPerms = payload.permissions ?? [];
    const filtered: StaffPermission[] = [];
    for (const p of rawPerms) {
      if (ALL_PERMISSIONS.includes(p as StaffPermission)) filtered.push(p as StaffPermission);
    }

    if (!filtered.length) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = {
        ok: false,
        error: "permissions_required",
        message: "בחר לפחות הרשאה אחת או סמן 'ברירת מחדל לפי תפקיד'.",
      };
      return;
    }

    permissions = filtered;
  }

  const staff = await createStaffByOwner({
    restaurantId,
    userId: user.id,
    firstName: (payload.firstName ?? user.firstName ?? "").toString(),
    lastName: (payload.lastName ?? user.lastName ?? "").toString(),
    email: user.email,
    phone: payload.phone,
    role,
    permissions,
    useDefaults,
  });

  // 7.4 audit
  await logAuditEvent({
    restaurantId,
    actor: owner,
    action: "staff.created",
    targetType: "staff",
    targetId: staff.id,
    meta: {
      email: user.email,
      role,
      useDefaults,
      permissionsCount: permissions?.length ?? 0,
    },
  });

  // decide response type
  const wantsJson =
    ctx.request.headers.get("accept")?.includes("application/json") ||
    ctx.request.headers.get("content-type")?.includes("application/json");

  if (wantsJson) {
    ctx.response.status = Status.OK;
    ctx.response.body = { ok: true, staff, userId: user.id, restaurantId };
  } else {
    ctx.response.redirect("/owner/staff");
  }
});

/* ─────────────── POST: אישור עובד קיים (staff_db) ─────────────── */
ownerStaffRouter.post("/owner/staff/:id/approve", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  console.log("[owner_staff] POST /owner/staff/:id/approve", {
    staffId,
    ownerId: owner.id,
  });

  const staff = await getStaffById(staffId);
  if (!staff) {
    console.warn("[owner_staff] approve – staff not found", { staffId });
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Staff not found";
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    console.warn("[owner_staff] approve – restaurant not owner", {
      staffId,
      restaurantId: restaurant?.id,
      ownerId: owner.id,
      restaurantOwnerId: restaurant?.ownerId,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

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

  await setStaffApproval(staffId, "approved");

  // 7.4 audit
  await logAuditEvent({
    restaurantId: staff.restaurantId,
    actor: owner,
    action: "staff.approval_changed",
    targetType: "staff",
    targetId: staffId,
    meta: { approvalStatus: "approved" },
  });
  console.log("[owner_staff] staff approved", {
    staffId,
    restaurantId: staff.restaurantId,
    usedDefaults: useDefaults && (!newPermissions || !newPermissions.length),
  });

  if (newPermissions && newPermissions.length > 0) {
    await setStaffPermissions(staffId, newPermissions);

    await logAuditEvent({
      restaurantId: staff.restaurantId,
      actor: owner,
      action: "staff.permissions_changed",
      targetType: "staff",
      targetId: staffId,
      meta: { mode: "explicit", permissions: newPermissions },
    });
    console.log("[owner_staff] staff permissions updated (explicit)", {
      staffId,
      count: newPermissions.length,
    });
  } else if (useDefaults) {
    await resetStaffPermissionsToDefault(staffId);

    await logAuditEvent({
      restaurantId: staff.restaurantId,
      actor: owner,
      action: "staff.permissions_changed",
      targetType: "staff",
      targetId: staffId,
      meta: { mode: "defaults" },
    });
    console.log("[owner_staff] staff permissions reset to default", {
      staffId,
    });
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: דחיית עובד קיים (staff_db) ─────────────── */
ownerStaffRouter.post("/owner/staff/:id/reject", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  console.log("[owner_staff] POST /owner/staff/:id/reject", {
    staffId,
    ownerId: owner.id,
  });

  const staff = await getStaffById(staffId);
  if (!staff) {
    console.warn("[owner_staff] reject – staff not found", { staffId });
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Staff not found";
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    console.warn("[owner_staff] reject – restaurant not owner", {
      staffId,
      restaurantId: restaurant?.id,
      ownerId: owner.id,
      restaurantOwnerId: restaurant?.ownerId,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  await setStaffApproval(staffId, "rejected");

  // 7.4 audit
  await logAuditEvent({
    restaurantId: staff.restaurantId,
    actor: owner,
    action: "staff.approval_changed",
    targetType: "staff",
    targetId: staffId,
    meta: { approvalStatus: "rejected" },
  });
  console.log("[owner_staff] staff rejected", {
    staffId,
    restaurantId: staff.restaurantId,
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: השבתה/הפעלה של עובד ─────────────── */
// שלב 7.1: toggle active/inactive
ownerStaffRouter.post("/owner/staff/:id/status", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  const status = String(form.get("status") || "").trim() as "active" | "inactive";

  if (status !== "active" && status !== "inactive") {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid status";
    return;
  }

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

  await setStaffStatus(staffId, status);

  // 7.4 audit
  await logAuditEvent({
    restaurantId: staff.restaurantId,
    actor: owner,
    action: "staff.status_changed",
    targetType: "staff",
    targetId: staffId,
    meta: { status },
  });
  console.log("[owner_staff] staff status updated", {
    staffId,
    restaurantId: staff.restaurantId,
    status,
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: יצירת קישור איפוס סיסמה לעובד ─────────────── */
// Owner generates a reset link for a staff user (no email sending here).
// Returns JSON: { ok:true, resetUrl:"/auth/reset?token=..." }
ownerStaffRouter.post("/owner/staff/:id/password-reset-link", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;

  const staff = await getStaffById(staffId);
  if (!staff) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "staff_not_found" };
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "not_your_restaurant" };
    return;
  }

  const user = await getUserById(staff.userId);
  if (!user) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "user_not_found" };
    return;
  }

  // If the user is not local, password reset via this flow doesn't apply.
  if ((user as any).provider && (user as any).provider !== "local") {
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: "non_local_user" };
    return;
  }

  const token = await createResetToken(user.id);
  const resetUrl = `/auth/reset?token=${encodeURIComponent(token)}`;

  // 7.4 audit
  await logAuditEvent({
    restaurantId: staff.restaurantId,
    actor: owner,
    action: "staff.password_reset_link_created",
    targetType: "staff",
    targetId: staffId,
    meta: { userId: user.id },
  });

  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, resetUrl };
});

/* ─────────────── GET: Audit log (JSON) ─────────────── */
// Owner can fetch recent audit events per restaurant.
// GET /owner/staff/audit?restaurantId=...&limit=50
ownerStaffRouter.get("/owner/staff/audit", async (ctx) => {
  const owner = ensureOwner(ctx);
  const restaurantId = String(ctx.request.url.searchParams.get("restaurantId") ?? "").trim();
  const limit = Number(ctx.request.url.searchParams.get("limit") ?? "50");

  if (!restaurantId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "restaurant_required" };
    return;
  }

  const restaurant = await getRestaurant(restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "not_your_restaurant" };
    return;
  }

  const events = await listAuditEventsForRestaurant(
    restaurantId,
    Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50,
  );
  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, restaurantId, events };
});

/* ─────────────── POST: עדכון הרשאות של עובד קיים ─────────────── */
ownerStaffRouter.post("/owner/staff/:id/permissions", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  console.log("[owner_staff] POST /owner/staff/:id/permissions", {
    staffId,
    ownerId: owner.id,
  });

  const staff = await getStaffById(staffId);
  if (!staff) {
    console.warn("[owner_staff] permissions – staff not found", { staffId });
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Staff not found";
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    console.warn("[owner_staff] permissions – restaurant not owner", {
      staffId,
      restaurantId: restaurant?.id,
      ownerId: owner.id,
      restaurantOwnerId: restaurant?.ownerId,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  const rawPerms = form.getAll("permissions") as string[] | undefined;
  const resetToDefaults = form.get("resetToDefaults") === "on";

  if (resetToDefaults) {
    await resetStaffPermissionsToDefault(staffId);

    // 7.4 audit
    await logAuditEvent({
      restaurantId: staff.restaurantId,
      actor: owner,
      action: "staff.permissions_changed",
      targetType: "staff",
      targetId: staffId,
      meta: { mode: "defaults" },
    });
    console.log("[owner_staff] permissions reset to defaults", { staffId });
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

    // 7.4 audit
    await logAuditEvent({
      restaurantId: staff.restaurantId,
      actor: owner,
      action: "staff.permissions_changed",
      targetType: "staff",
      targetId: staffId,
      meta: { mode: "explicit", permissions: filtered },
    });
    console.log("[owner_staff] permissions updated explicit", {
      staffId,
      count: filtered.length,
    });
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/** אישור בקשת הצטרפות */
/** דחיית בקשת הצטרפות */
