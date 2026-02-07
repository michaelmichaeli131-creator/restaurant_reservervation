// src/routes/staff_time.ts
// --------------------------------------------------------
// Staff clock-in/out endpoints
// Uses ctx.state.user + ctx.state.staff / staffRestaurantId / staffMemberships (from your middleware)
// Permissions: requires "time.clock" in staff.permissions (Owner bypass is not needed here)
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import type { Context } from "jsr:@oak/oak";

import { createClockIn, clockOut, getOpenEntryIdByStaff, getTimeEntry } from "../services/time_db.ts";
import type { User } from "../database.ts";

export const staffTimeRouter = new Router();

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
    if (c && typeof c === "object" && typeof (c as any).json === "function") return c as Request;
  }
  return undefined;
}

async function readJsonCompat(ctx: any): Promise<any> {
  const req = getNativeRequestCompat(ctx);
  if (req && typeof (req as any).json === "function") return await (req as any).json();

  const b = ctx?.request?.body;
  if (typeof b === "function") {
    const body = b.call(ctx.request);
    if (body?.json) return await body.json();
  } else if (b?.json) {
    return await b.json();
  }

  // last resort: empty
  return {};
}

function json(ctx: Context, status: number, body: any) {
  ctx.response.status = status;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = body;
}

function ensureUser(ctx: Context): User {
  const u = (ctx.state as any)?.user as User | undefined;
  if (!u) {
    const e: any = new Error("Not logged in");
    e.status = Status.Unauthorized;
    throw e;
  }
  return u;
}

/**
 * Resolve current staff context from middleware:
 * - ctx.state.staff: current membership (single)
 * - ctx.state.staffRestaurantId: restaurantId for this staff context
 * - ctx.state.staffMemberships: list of memberships (optional)
 *
 * We pick:
 * 1) state.staff if exists
 * 2) else first approved+active membership
 */
function resolveStaffContext(ctx: Context): any | null {
  const s: any = (ctx.state as any)?.staff ?? null;
  if (s) return s;

  const ms: any[] = (ctx.state as any)?.staffMemberships ?? [];
  if (Array.isArray(ms) && ms.length) {
    const pick =
      ms.find((x) => x?.approvalStatus === "approved" && x?.status !== "inactive") ??
      ms[0];
    return pick ?? null;
  }
  return null;
}

function hasPerm(staff: any, perm: string): boolean {
  const arr = staff?.permissions;
  if (!Array.isArray(arr)) return false;
  return arr.includes(perm);
}

function ensureCanClock(ctx: Context): { user: User; staff: any; restaurantId: string; staffId: string } {
  const user = ensureUser(ctx);

  // Owner shouldn't hit these endpoints; but we won't block if you want.
  // Still require staff context to avoid allowing owners to clock via staff endpoints.
  const staff = resolveStaffContext(ctx);
  if (!staff) {
    const e: any = new Error("No staff context");
    e.status = Status.Forbidden;
    throw e;
  }

  // Must be approved + active
  if (staff.approvalStatus !== "approved" || staff.status === "inactive") {
    const e: any = new Error("Staff not active/approved");
    e.status = Status.Forbidden;
    throw e;
  }

  // permission gate (your requirement: "each employee sees only what owner defined")
  if (!hasPerm(staff, "time.clock")) {
    const e: any = new Error("Missing time.clock permission");
    e.status = Status.Forbidden;
    throw e;
  }

  const restaurantId =
    String((ctx.state as any)?.staffRestaurantId ?? staff.restaurantId ?? "").trim();
  if (!restaurantId) {
    const e: any = new Error("Missing restaurantId");
    e.status = Status.BadRequest;
    throw e;
  }

  const staffId = String(staff.id ?? "").trim();
  if (!staffId) {
    const e: any = new Error("Missing staffId");
    e.status = Status.BadRequest;
    throw e;
  }

  return { user, staff, restaurantId, staffId };
}

// GET /staff/time/status
staffTimeRouter.get("/staff/time/status", async (ctx) => {
  try {
    const { staffId } = ensureCanClock(ctx);
    const openId = await getOpenEntryIdByStaff(staffId);
    const openEntry = openId ? await getTimeEntry(openId) : null;
    json(ctx, Status.OK, { ok: true, openEntry });
  } catch (e: any) {
    json(ctx, e?.status ?? Status.InternalServerError, { ok: false, error: String(e?.message ?? e) });
  }
});

// POST /staff/time/clock-in
staffTimeRouter.post("/staff/time/clock-in", async (ctx) => {
  try {
    const { user, restaurantId, staffId } = ensureCanClock(ctx);

    // allow optional body.restaurantId only if matches staff context (prevent spoof)
    const body = await readJsonCompat(ctx);
    const rid = body?.restaurantId ? String(body.restaurantId).trim() : restaurantId;
    if (rid !== restaurantId) {
      return json(ctx, Status.Forbidden, { ok: false, error: "restaurant_mismatch" });
    }

    const res = await createClockIn({
      restaurantId,
      staffId,
      userId: user.id,
      source: "staff",
    });

    if (!res.ok) {
      const open = await getTimeEntry(res.openEntryId);
      return json(ctx, Status.Conflict, { ok: false, error: res.error, openEntry: open });
    }

    return json(ctx, Status.OK, { ok: true, entry: res.entry });
  } catch (e: any) {
    json(ctx, e?.status ?? Status.InternalServerError, { ok: false, error: String(e?.message ?? e) });
  }
});

// POST /staff/time/clock-out
staffTimeRouter.post("/staff/time/clock-out", async (ctx) => {
  try {
    const { user, staffId } = ensureCanClock(ctx);

    const res = await clockOut({
      staffId,
      userId: user.id,
      roleForAudit: user.role || "staff",
    });

    if (!res.ok) {
      if (res.error === "no_open") return json(ctx, Status.Conflict, { ok: false, error: "no_open" });
      if (res.error === "not_found") return json(ctx, Status.NotFound, { ok: false, error: "not_found" });
      if (res.error === "already_closed") return json(ctx, Status.OK, { ok: true, entry: res.entry });
      return json(ctx, Status.InternalServerError, { ok: false, error: res.error });
    }

    return json(ctx, Status.OK, { ok: true, entry: res.entry });
  } catch (e: any) {
    json(ctx, e?.status ?? Status.InternalServerError, { ok: false, error: String(e?.message ?? e) });
  }
});
