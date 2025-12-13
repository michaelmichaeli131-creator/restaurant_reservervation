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
 * במקום זה – משתמשים בפונקציה ensureOwner(ctx) בכל handler.
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

/* ─────────────── Debug helpers ─────────────── */

function reqTag(ctx: any) {
  // אם יש לך req id במערכת – אפשר לשלב כאן
  return `${ctx.request.method} ${ctx.request.url.pathname}`;
}

function headersToObject(h: Headers) {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
  return out;
}

function safePreview(s: string, max = 600) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max) + "…(truncated)" : t;
}

function redactPayloadForLog(p: OwnerCreateStaffPayload) {
  return {
    restaurantId: p.restaurantId,
    email: p.email,
    role: p.role,
    firstName: p.firstName,
    lastName: p.lastName,
    phone: p.phone,
    useDefaults: Boolean(p.useDefaults),
    permissionsCount: Array.isArray(p.permissions) ? p.permissions.length : 0,
    hasPassword: Boolean(p.password),
    passwordLen: typeof p.password === "string" ? p.password.length : 0,
  };
}

/**
 * קורא body פעם אחת בלבד.
 * - קורא כ-text
 * - מחליט parse לפי Content-Type (או לפי צורת הטקסט)
 * - תומך JSON וגם x-www-form-urlencoded
 */
async function readOwnerCreateStaffPayload(ctx: any): Promise<{
  payload: OwnerCreateStaffPayload;
  meta: { contentType: string; rawPreview: string };
}> {
  const contentType = String(ctx.request.headers.get("content-type") || "");
  const accept = String(ctx.request.headers.get("accept") || "");

  // קוראים פעם אחת כטקסט – זה עובד גם ל-json וגם ל-form-urlencoded
  const rawText = await ctx.request.body({ type: "text" }).value as string;
  const rawPreview = safePreview(rawText);

  console.log("[owner_staff] read payload start", {
    tag: reqTag(ctx),
    contentType,
    accept,
    rawPreview,
  });

  let obj: any = null;

  const looksJson =
    contentType.includes("application/json") ||
    rawText.trim().startsWith("{") ||
    rawText.trim().startsWith("[");

  if (looksJson) {
    try {
      obj = rawText ? JSON.parse(rawText) : {};
    } catch (e) {
      console.error("[owner_staff] JSON parse failed", {
        tag: reqTag(ctx),
        contentType,
        rawPreview,
        err: String(e),
      });
      throw new Error("json_parse_failed");
    }
  } else {
    // form-urlencoded
    try {
      const usp = new URLSearchParams(rawText || "");
      obj = {};
      for (const [k, v] of usp.entries()) {
        if (k === "permissions") {
          if (!obj.permissions) obj.permissions = [];
          obj.permissions.push(v);
        } else {
          obj[k] = v;
        }
      }
    } catch (e) {
      console.error("[owner_staff] form parse failed", {
        tag: reqTag(ctx),
        contentType,
        rawPreview,
        err: String(e),
      });
      throw new Error("form_parse_failed");
    }
  }

  const v = obj || {};
  const payload: OwnerCreateStaffPayload = {
    restaurantId: String(v.restaurantId ?? "").trim(),
    email: String(v.email ?? "").trim(),
    password: String(v.password ?? ""),
    firstName: v.firstName ? String(v.firstName).trim() : undefined,
    lastName: v.lastName ? String(v.lastName).trim() : undefined,
    phone: v.phone ? String(v.phone).trim() : undefined,
    role: v.role as StaffRole,
    permissions: Array.isArray(v.permissions) ? v.permissions.map(String) : undefined,
    useDefaults: Boolean(v.useDefaults) || v.useDefaults === "on",
  };

  console.log("[owner_staff] read payload normalized", {
    tag: reqTag(ctx),
    normalized: redactPayloadForLog(payload),
  });

  return { payload, meta: { contentType, rawPreview } };
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

  const hObj = headersToObject(ctx.request.headers);

  console.log("[owner_staff] POST /owner/staff/create – incoming", {
    ownerId: owner.id,
    ownerEmail: owner.email,
    headers: {
      "content-type": hObj["content-type"],
      "accept": hObj["accept"],
      // אם תרצה, תוכל להדפיס את כולם:
      // all: hObj,
    },
  });

  let payload: OwnerCreateStaffPayload;
  let meta: { contentType: string; rawPreview: string };

  try {
    const r = await readOwnerCreateStaffPayload(ctx);
    payload = r.payload;
    meta = r.meta;
  } catch (e) {
    console.error("[owner_staff] create – invalid_body", {
      ownerId: owner.id,
      err: String(e),
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = {
      ok: false,
      error: "invalid_body",
      message: "Failed to parse request body",
      debug: { err: String(e) },
    };
    return;
  }

  const restaurantId = (payload.restaurantId || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const password = String(payload.password ?? "");
  const role = payload.role;

  console.log("[owner_staff] create – validated input start", {
    restaurantId,
    email,
    role,
    useDefaults: Boolean(payload.useDefaults),
    permissionsCount: Array.isArray(payload.permissions) ? payload.permissions.length : 0,
  });

  if (!restaurantId) {
    console.warn("[owner_staff] create – restaurant_required", { ownerId: owner.id });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "restaurant_required" };
    return;
  }
  if (!email || !email.includes("@")) {
    console.warn("[owner_staff] create – email_invalid", { ownerId: owner.id, email });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "email_invalid" };
    return;
  }
  if (!password || password.length < 8) {
    console.warn("[owner_staff] create – password_too_short", { ownerId: owner.id, len: password?.length || 0 });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "password_too_short", min: 8 };
    return;
  }
  if (!isStaffRole(role)) {
    console.warn("[owner_staff] create – role_invalid", { ownerId: owner.id, role });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "role_invalid" };
    return;
  }

  const restaurant = await getRestaurant(restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    console.warn("[owner_staff] create – not_your_restaurant", {
      ownerId: owner.id,
      restaurantId,
      found: Boolean(restaurant),
      restaurantOwnerId: restaurant?.ownerId,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "not_your_restaurant" };
    return;
  }

  let user = await findUserByEmail(email);
  if (user && user.role !== "staff") {
    console.warn("[owner_staff] create – email_in_use (non-staff user)", {
      ownerId: owner.id,
      email,
      existingRole: user.role,
    });
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
      console.log("[owner_staff] create – user created", { userId: user.id, email: user.email });
    } catch (e) {
      console.error("[owner_staff] create – user_create_failed", {
        ownerId: owner.id,
        email,
        err: String(e),
      });
      ctx.response.status = Status.Conflict;
      ctx.response.body = { ok: false, error: "user_create_failed", message: String(e) };
      return;
    }
  } else {
    if (!user.emailVerified) {
      await setEmailVerified(user.id);
      console.log("[owner_staff] create – setEmailVerified", { userId: user.id, email: user.email });
    }
  }

  const existing = await getStaffByRestaurantAndUser(restaurantId, user.id);
  if (existing) {
    console.warn("[owner_staff] create – staff_exists", {
      ownerId: owner.id,
      restaurantId,
      userId: user.id,
      staffId: existing.id,
    });
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: "staff_exists", staffId: existing.id };
    return;
  }

  const useDefaults = Boolean(payload.useDefaults);
  let permissions: StaffPermission[] | undefined;

  if (!useDefaults) {
    const rawPerms = payload.permissions ?? [];
    const filtered: StaffPermission[] = [];

    for (const p of rawPerms) {
      if (ALL_PERMISSIONS.includes(p as StaffPermission)) filtered.push(p as StaffPermission);
    }

    if (!filtered.length) {
      console.warn("[owner_staff] create – permissions_required", {
        ownerId: owner.id,
        restaurantId,
        rawPermsCount: rawPerms.length,
      });
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

  console.log("[owner_staff] create – creating staff record", {
    ownerId: owner.id,
    restaurantId,
    userId: user.id,
    role,
    useDefaults,
    permissionsCount: permissions?.length ?? 0,
  });

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

  console.log("[owner_staff] create – staff created", {
    staffId: staff.id,
    restaurantId,
    userId: user.id,
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

  console.log("[owner_staff] POST /owner/staff/:id/approve", { staffId, ownerId: owner.id });

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
      if (ALL_PERMISSIONS.includes(p as StaffPermission)) filtered.push(p as StaffPermission);
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
  const form = await ctx.request.body({ type: "form" }).value;

  console.log("[owner_staff] POST /owner/staff/:id/reject", { staffId, ownerId: owner.id });

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

/* ─────────────── POST: עדכון הרשאות של עובד קיים ─────────────── */
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
