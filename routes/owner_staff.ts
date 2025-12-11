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
  getStaffByRestaurantAndUser,
  createApprovedStaffFromSignup,
} from "../services/staff_db.ts";

export const ownerStaffRouter = new Router();

// 🔎 לוג בעת טעינת המודול
console.log("[owner_staff] router module loaded");

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

  // בקשות הצטרפות (StaffSignupRequest) לכל המסעדות של הבעלים
  const rawSignupRequests = await listStaffSignupRequestsForOwner(owner.id, "pending");
  console.log("[owner_staff] signup requests loaded", {
    count: rawSignupRequests.length,
  });

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

    console.log("[owner_staff] restaurant block", {
      restaurantId: r.id,
      name: r.name,
      staffCount: all.length,
      activeCount: active.length,
      pendingCount: pending.length,
      signupRequestsCount: signupRequests.length,
    });

    items.push({
      restaurant: r,
      staff: active,
      pending,
      signupRequests,
    });
  }

  await render(ctx, "owner/staff", {
    title: "ניהול עובדים",
    owner,
    restaurantsData: items,
    allPermissions: ALL_PERMISSIONS,
  });

  console.log("[owner_staff] GET /owner/staff – render done");
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
  console.log("[owner_staff] staff approved", {
    staffId,
    restaurantId: staff.restaurantId,
    usedDefaults: useDefaults && (!newPermissions || !newPermissions.length),
  });

  if (newPermissions && newPermissions.length > 0) {
    await setStaffPermissions(staffId, newPermissions);
    console.log("[owner_staff] staff permissions updated (explicit)", {
      staffId,
      count: newPermissions.length,
    });
  } else if (useDefaults) {
    await resetStaffPermissionsToDefault(staffId);
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
  console.log("[owner_staff] staff rejected", {
    staffId,
    restaurantId: staff.restaurantId,
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
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
    console.log("[owner_staff] permissions reset to defaults", {
      staffId,
    });
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
    console.log("[owner_staff] permissions updated explicit", {
      staffId,
      count: filtered.length,
    });
  }

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/* ─────────────── POST: אישור / דחיית בקשת הצטרפות (StaffSignupRequest) ─────────────── */

/** אישור בקשת הצטרפות */
ownerStaffRouter.post("/owner/staff-signup/:id/approve", async (ctx) => {
  const owner = ensureOwner(ctx);
  const id = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  console.log("[owner_staff] POST /owner/staff-signup/:id/approve", {
    signupRequestId: id,
    ownerId: owner.id,
  });

  const req = await getStaffSignupRequest(id);
  if (!req) {
    console.warn("[owner_staff] signup approve – request not found", { id });
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Signup request not found";
    return;
  }

  const restaurant = await getRestaurant(req.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    console.warn("[owner_staff] signup approve – restaurant not owner", {
      signupRequestId: id,
      restaurantId: restaurant?.id,
      ownerId: owner.id,
      restaurantOwnerId: restaurant?.ownerId,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  const user = await getUserById(req.userId);
  if (!user) {
    console.warn("[owner_staff] signup approve – user not found", {
      userId: req.userId,
      signupRequestId: id,
    });
  } else {
    const existing = await getStaffByRestaurantAndUser(req.restaurantId, user.id);
    if (existing) {
      console.log("[owner_staff] signup approve – staff already exists, skip create", {
        signupRequestId: id,
        restaurantId: req.restaurantId,
        userId: user.id,
        staffId: existing.id,
      });
    } else {
      try {
        const created = await createApprovedStaffFromSignup({
          restaurantId: req.restaurantId,
          userId: user.id,
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          email: user.email,
          phone: user.phone || undefined,
          role: req.staffRole,
        });
        console.log("[owner_staff] signup approve – created staff from request", {
          signupRequestId: id,
          restaurantId: req.restaurantId,
          userId: user.id,
          staffId: created.id,
        });
      } catch (e) {
        console.error(
          "[owner_staff] failed to create StaffMember from signup request",
          {
            signupRequestId: id,
            restaurantId: req.restaurantId,
            userId: req.userId,
            error: String(e),
          },
        );
      }
    }
  }

  await updateStaffSignupStatus(id, "approved");
  console.log("[owner_staff] signup request status → approved", {
    signupRequestId: id,
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});

/** דחיית בקשת הצטרפות */
ownerStaffRouter.post("/owner/staff-signup/:id/reject", async (ctx) => {
  const owner = ensureOwner(ctx);
  const id = ctx.params.id!;
  const form = await ctx.request.body({ type: "form" }).value;

  console.log("[owner_staff] POST /owner/staff-signup/:id/reject", {
    signupRequestId: id,
    ownerId: owner.id,
  });

  const req = await getStaffSignupRequest(id);
  if (!req) {
    console.warn("[owner_staff] signup reject – request not found", { id });
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Signup request not found";
    return;
  }

  const restaurant = await getRestaurant(req.restaurantId);
  if (!restaurant || restaurant.ownerId !== owner.id) {
    console.warn("[owner_staff] signup reject – restaurant not owner", {
      signupRequestId: id,
      restaurantId: restaurant?.id,
      ownerId: owner.id,
      restaurantOwnerId: restaurant?.ownerId,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Not your restaurant";
    return;
  }

  await updateStaffSignupStatus(id, "rejected");
  console.log("[owner_staff] signup request status → rejected", {
    signupRequestId: id,
  });

  const redirectTo = form.get("redirectTo") || "/owner/staff";
  ctx.response.redirect(String(redirectTo));
});
