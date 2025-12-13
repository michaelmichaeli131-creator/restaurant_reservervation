// routes/owner_staff.ts
// --------------------------------------------------------
// ניהול עובדים ע"י בעל המסעדה:
// - רשימת עובדים למסעדות שלו
// - עובדים ממתינים (pending) לפי staff_db
// - אישור / דחייה
// - עדכון הרשאות
// - ✅ עמוד עובד נפרד: GET /owner/staff/:id
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
      path: ctx.request?.url?.pathname,
    });
    const err: any = new Error("Not owner");
    err.status = Status.Forbidden;
    throw err;
  }

  return user;
}

/**
 * Oak compatibility:
 * - Oak older: ctx.request.body() is a function returning Body
 * - Oak newer (v17): ctx.request.body is an object/stream (NOT a function)
 *
 * We support both without breaking.
 */
function getOakBodyCompat(ctx: any): any {
  const b = ctx?.request?.body;
  if (!b) return undefined;
  if (typeof b === "function") return b.call(ctx.request);
  return b;
}

/**
 * Try to reach the underlying native Request if Oak exposes it.
 * (Different Oak versions expose it differently.)
 */
function getNativeRequestCompat(ctx: any): Request | undefined {
  const candidates = [
    ctx?.request?.originalRequest?.request,
    ctx?.request?.originalRequest,
    ctx?.request?.request,
    ctx?.request?.raw?.request,
    ctx?.request?.raw,
    ctx?.request,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as any).json === "function") {
      return c as Request;
    }
  }
  return undefined;
}

function safeKeys(obj: any): string[] {
  try {
    if (!obj || typeof obj !== "object") return [];
    return Object.keys(obj).slice(0, 40);
  } catch {
    return [];
  }
}

async function readTextCompat(ctx: any): Promise<string> {
  const req = getNativeRequestCompat(ctx);
  if (req && typeof (req as any).text === "function") {
    return await (req as any).text();
  }

  const body = getOakBodyCompat(ctx);
  if (body) {
    if (typeof body.text === "function") return await body.text();
    if (typeof body.getReader === "function") return await new Response(body).text();
  }

  throw new Error("Cannot read text body (compat)");
}

async function readJsonCompat(ctx: any): Promise<any> {
  // 1) native Request.json()
  const req = getNativeRequestCompat(ctx);
  if (req && typeof (req as any).json === "function") {
    return await (req as any).json();
  }

  // 2) Oak Body object
  const body = getOakBodyCompat(ctx);
  if (body) {
    if (typeof body.json === "function") {
      return await body.json();
    }

    // Old Oak style: body.type === "json" and body.value
    const t = typeof body.type === "string"
      ? body.type
      : (typeof body.type === "function" ? body.type() : undefined);

    if (t === "json") {
      const v = (body as any).value;
      if (typeof v === "function") return await v.call(body);
      if (v !== undefined) return await v;
    }

    // If it's a stream
    if (typeof body.getReader === "function") {
      return await new Response(body).json();
    }
  }

  // 3) Last resort: try to read text and JSON.parse
  try {
    const raw = await readTextCompat(ctx);
    return JSON.parse(raw);
  } catch {
    throw new Error("Cannot parse JSON body (compat)");
  }
}

/**
 * For form posts from <form method="post">.
 * We return FormData (has get/getAll) so it works with your code.
 */
async function readFormDataCompat(ctx: any): Promise<FormData> {
  // 1) native Request.formData()
  const req = getNativeRequestCompat(ctx);
  if (req && typeof (req as any).formData === "function") {
    return await (req as any).formData();
  }

  // 2) Oak Body object
  const body = getOakBodyCompat(ctx);
  if (body) {
    if (typeof body.formData === "function") return await body.formData();

    const t = typeof body.type === "string"
      ? body.type
      : (typeof body.type === "function" ? body.type() : undefined);

    // Some Oak versions used "form" and "form-data"
    if (t === "form" || t === "form-data" || t === "formData") {
      const v = (body as any).value;
      // old oak: value is URLSearchParams. convert to FormData.
      const val = typeof v === "function" ? await v.call(body) : await v;
      if (val && typeof val.get === "function") {
        // URLSearchParams-like
        const fd = new FormData();
        for (const [k, vv] of (val as any).entries()) fd.append(k, vv);
        return fd;
      }
    }

    // If it's raw stream: parse as urlencoded
    if (typeof body.getReader === "function") {
      const txt = await new Response(body).text();
      const usp = new URLSearchParams(txt);
      const fd = new FormData();
      for (const [k, v] of usp.entries()) fd.append(k, v);
      return fd;
    }
  }

  throw new Error("Cannot parse form body (compat)");
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

async function readOwnerCreateStaffPayload(ctx: any): Promise<OwnerCreateStaffPayload> {
  const contentType = String(ctx.request.headers.get("content-type") || "").toLowerCase();

  // Debug body shape
  const rawBody = (ctx as any)?.request?.body;
  console.log("[owner_staff] create – body shape", {
    typeof_body: typeof rawBody,
    is_func: typeof rawBody === "function",
    keys: safeKeys(typeof rawBody === "function" ? undefined : rawBody),
    contentType,
    accept: String(ctx.request.headers.get("accept") || ""),
  });

  // JSON (your client uses fetch JSON)
  if (contentType.includes("application/json")) {
    const v = await readJsonCompat(ctx);
    return {
      restaurantId: String(v?.restaurantId ?? "").trim(),
      email: String(v?.email ?? "").trim(),
      password: String(v?.password ?? ""),
      firstName: v?.firstName ? String(v.firstName).trim() : undefined,
      lastName: v?.lastName ? String(v.lastName).trim() : undefined,
      phone: v?.phone ? String(v.phone).trim() : undefined,
      role: v?.role as StaffRole,
      permissions: Array.isArray(v?.permissions) ? v.permissions.map(String) : undefined,
      useDefaults: Boolean(v?.useDefaults),
    };
  }

  // Form (fallback)
  const form = await readFormDataCompat(ctx);
  const perms = form.getAll("permissions") as string[] | undefined;
  return {
    restaurantId: String(form.get("restaurantId") ?? "").trim(),
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    firstName: form.get("firstName") ? String(form.get("firstName")).trim() : undefined,
    lastName: form.get("lastName") ? String(form.get("lastName")).trim() : undefined,
    phone: form.get("phone") ? String(form.get("phone")).trim() : undefined,
    role: String(form.get("role") ?? "") as StaffRole,
    permissions: perms,
    useDefaults: String(form.get("useDefaults") ?? "") === "on",
  };
}

/* ─────────────── GET: מסך ניהול עובדים ─────────────── */

ownerStaffRouter.get("/owner/staff", async (ctx) => {
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

ownerStaffRouter.post("/owner/staff/create", async (ctx) => {
  const owner = ensureOwner(ctx);

  let payload: OwnerCreateStaffPayload;
  try {
    payload = await readOwnerCreateStaffPayload(ctx);
  } catch (e) {
    console.error("[owner_staff] create – invalid_body", {
      ownerId: owner.id,
      err: String(e),
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "invalid_body" };
    return;
  }

  // sanitized debug (no password)
  console.log("[owner_staff] create – payload", {
    ownerId: owner.id,
    restaurantId: String(payload.restaurantId || ""),
    email: String(payload.email || "").toLowerCase(),
    role: String(payload.role || ""),
    useDefaults: Boolean(payload.useDefaults),
    permissionsCount: Array.isArray(payload.permissions) ? payload.permissions.length : 0,
    hasFirstName: Boolean(payload.firstName),
    hasLastName: Boolean(payload.lastName),
    hasPhone: Boolean(payload.phone),
  });

  const restaurantId = (payload.restaurantId || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const password = String(payload.password ?? "");
  const role = payload.role;

  if (!restaurantId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "restaurant_required" };
    return;
  }

  // align with your client mapping: email_required
  if (!email || !email.includes("@")) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "email_required" };
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

  // if existing user is not staff → reject (align with client mapping)
  if (user && user.role !== "staff") {
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: "user_email_in_use" };
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
      console.error("[owner_staff] create – user_create_failed", { err: String(e), email });
      ctx.response.status = Status.Conflict;
      ctx.response.body = { ok: false, error: "user_create_failed" };
      return;
    }
  } else {
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

  // permissions defaults are decided on the server.
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
      ctx.response.body = { ok: false, error: "permissions_required" };
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

  const wantsJson =
    String(ctx.request.headers.get("accept") || "").includes("application/json") ||
    String(ctx.request.headers.get("content-type") || "").includes("application/json");

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
  const form = await readFormDataCompat(ctx);

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
  const useDefaults = String(form.get("useDefaults") ?? "") === "on";

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
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: דחיית עובד קיים (staff_db) ─────────────── */

ownerStaffRouter.post("/owner/staff/:id/reject", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await readFormDataCompat(ctx);

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

  await logAuditEvent({
    restaurantId: staff.restaurantId,
    actor: owner,
    action: "staff.approval_changed",
    targetType: "staff",
    targetId: staffId,
    meta: { approvalStatus: "rejected" },
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: השבתה/הפעלה של עובד ─────────────── */

ownerStaffRouter.post("/owner/staff/:id/status", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await readFormDataCompat(ctx);

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

  await logAuditEvent({
    restaurantId: staff.restaurantId,
    actor: owner,
    action: "staff.status_changed",
    targetType: "staff",
    targetId: staffId,
    meta: { status },
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: יצירת קישור איפוס סיסמה לעובד ─────────────── */

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

  if ((user as any).provider && (user as any).provider !== "local") {
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: "non_local_user" };
    return;
  }

  const token = await createResetToken(user.id);
  const resetUrl = `/auth/reset?token=${encodeURIComponent(token)}`;

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

/* ─────────────── GET: עמוד עובד נפרד ─────────────── */
/**
 * GET /owner/staff/:id
 * מציג עמוד נפרד לעובד:
 * - פרטים בסיסיים
 * - הרשאות + שמירה/איפוס
 * - סטטוס active/inactive
 * - יצירת קישור איפוס סיסמה
 *
 * חשוב: מוגדר אחרי /owner/staff/audit כדי לא לתפוס "audit" כ-id.
 */
ownerStaffRouter.get("/owner/staff/:id", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = String(ctx.params.id || "").trim();

  console.log("[owner_staff] GET /owner/staff/:id – start", {
    ownerId: owner.id,
    staffId,
  });

  if (!staffId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Missing staff id";
    return;
  }

  const staff = await getStaffById(staffId);
  if (!staff) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "owner/staff_member", {
      title: "עובד לא נמצא",
      owner,
      staff: null,
      restaurant: null,
      allPermissions: ALL_PERMISSIONS,
      staffRoleOptions: STAFF_ROLE_OPTIONS,
      error: "staff_not_found",
    });
    return;
  }

  const restaurant = await getRestaurant(staff.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "owner/staff_member", {
      title: "אין הרשאה",
      owner,
      staff: null,
      restaurant: null,
      allPermissions: ALL_PERMISSIONS,
      staffRoleOptions: STAFF_ROLE_OPTIONS,
      error: "not_your_restaurant",
    });
    return;
  }

  // (optional) ensure user exists - for debug/future
  const user = await getUserById(staff.userId).catch(() => null);
  console.log("[owner_staff] GET /owner/staff/:id – loaded", {
    staffId: staff.id,
    restaurantId: staff.restaurantId,
    userId: staff.userId,
    hasUser: Boolean(user),
    role: staff.role,
    approvalStatus: (staff as any).approvalStatus,
    status: (staff as any).status,
    permissionsCount: Array.isArray((staff as any).permissions) ? (staff as any).permissions.length : 0,
  });

  await render(ctx, "owner/staff_member", {
    title: "ניהול עובד",
    owner,
    staff,
    restaurant,
    allPermissions: ALL_PERMISSIONS,
    staffRoleOptions: STAFF_ROLE_OPTIONS,
  });
});

/* ─────────────── POST: עדכון הרשאות של עובד קיים ─────────────── */

ownerStaffRouter.post("/owner/staff/:id/permissions", async (ctx) => {
  const owner = ensureOwner(ctx);
  const staffId = ctx.params.id!;
  const form = await readFormDataCompat(ctx);

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
  const resetToDefaults = String(form.get("resetToDefaults") ?? "") === "on";

  if (resetToDefaults) {
    await resetStaffPermissionsToDefault(staffId);

    await logAuditEvent({
      restaurantId: staff.restaurantId,
      actor: owner,
      action: "staff.permissions_changed",
      targetType: "staff",
      targetId: staffId,
      meta: { mode: "defaults" },
    });
  } else {
    const filtered: StaffPermission[] = [];
    if (rawPerms) {
      for (const p of rawPerms) {
        if (ALL_PERMISSIONS.includes(p as StaffPermission)) filtered.push(p as StaffPermission);
      }
    }

    await setStaffPermissions(staffId, filtered);

    await logAuditEvent({
      restaurantId: staff.restaurantId,
      actor: owner,
      action: "staff.permissions_changed",
      targetType: "staff",
      targetId: staffId,
      meta: { mode: "explicit", permissions: filtered },
    });
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/** אישור בקשת הצטרפות */
/** דחיית בקשת הצטרפות */
