// src/routes/staff_shifts.ts
// --------------------------------------------------------
// Staff shifts UI + API
//
// UI:
//  - GET /staff/shifts
// API:
//  - GET /api/staff/shifts?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Context:
//  - ctx.state.user must exist
//  - ctx.state.staff + ctx.state.staffRestaurantId are provided by middleware/staff_context.ts
//
// Permission gate:
//  - staff.permissions must include "shifts.view"
//  - staff must be approvalStatus=approved (if present) and status not inactive
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import type { Context } from "jsr:@oak/oak";

import { render } from "../lib/view.ts";
import { getRestaurant, type StaffMember, type User } from "../database.ts";
import {
  listShiftsByStaff,
  listShiftTemplates,
} from "../services/shift_service.ts";

export const staffShiftsRouter = new Router();

/* ─────────────── Helpers ─────────────── */

function json(ctx: Context, status: number, body: any) {
  ctx.response.status = status;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = body;
}

function ensureUser(ctx: Context): User | null {
  const u = (ctx.state as any)?.user as User | undefined;
  return u ?? null;
}

function resolveStaffContext(ctx: Context): StaffMember | null {
  const s = (ctx.state as any)?.staff as StaffMember | null;
  if (s) return s;

  const ms = (ctx.state as any)?.staffMemberships as StaffMember[] | undefined;
  if (Array.isArray(ms) && ms.length) {
    const pick =
      ms.find((x) => x?.approvalStatus === "approved" && x?.status !== "inactive") ??
      ms[0];
    return pick ?? null;
  }
  return null;
}

function hasPerm(staff: StaffMember, perm: string): boolean {
  const arr = (staff as any)?.permissions;
  return Array.isArray(arr) && arr.includes(perm);
}

function ensureCanView(ctx: Context): {
  user: User;
  staff: StaffMember;
  restaurantId: string;
} {
  const user = ensureUser(ctx);
  if (!user) {
    const e: any = new Error("Not logged in");
    e.status = Status.Unauthorized;
    throw e;
  }

  // We currently support only user.role === "staff" in staff area
  if (user.role !== "staff") {
    const e: any = new Error("Forbidden");
    e.status = Status.Forbidden;
    throw e;
  }

  const staff = resolveStaffContext(ctx);
  if (!staff) {
    const e: any = new Error("No staff context");
    e.status = Status.Forbidden;
    throw e;
  }

  // Must be active
  if ((staff as any)?.status === "inactive") {
    const e: any = new Error("Staff inactive");
    e.status = Status.Forbidden;
    throw e;
  }

  // If approvalStatus exists, require approved
  if ((staff as any)?.approvalStatus && (staff as any)?.approvalStatus !== "approved") {
    const e: any = new Error("Staff not approved");
    e.status = Status.Forbidden;
    throw e;
  }

  if (!hasPerm(staff, "shifts.view")) {
    const e: any = new Error("Missing shifts.view permission");
    e.status = Status.Forbidden;
    throw e;
  }

  const restaurantId = String((ctx.state as any)?.staffRestaurantId ?? staff.restaurantId ?? "").trim();
  if (!restaurantId) {
    const e: any = new Error("Missing restaurantId");
    e.status = Status.BadRequest;
    throw e;
  }

  return { user, staff, restaurantId };
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDaysISO(dateISO: string, days: number): string {
  // Use UTC to keep ISO stable
  const d = new Date(dateISO + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRangeInclusive(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  let cur = fromISO;
  // safety cap: max 62 days to prevent abuse
  for (let i = 0; i < 62; i++) {
    out.push(cur);
    if (cur === toISO) break;
    cur = addDaysISO(cur, 1);
  }
  return out;
}

/* ─────────────── UI ─────────────── */

// GET /staff/shifts
staffShiftsRouter.get("/staff/shifts", async (ctx) => {
  // If not logged in, redirect to login (same pattern as other UI)
  const u = ensureUser(ctx);
  if (!u) {
    const redirect = "/auth/login?redirect=" + encodeURIComponent(ctx.request.url.pathname);
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", redirect);
    return;
  }

  try {
    const { staff, restaurantId } = ensureCanView(ctx);

    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant) {
      ctx.response.status = Status.NotFound;
      ctx.response.body = "Restaurant not found";
      return;
    }

    await render(ctx, "staff/shifts", {
      title: "המשמרות שלי",
      user: u,
      staff,
      restaurant,
      restaurantId,
    });
  } catch (e: any) {
    const st = e?.status ?? Status.Forbidden;
    ctx.response.status = st;
    ctx.response.body = st === Status.Forbidden ? "Forbidden" : String(e?.message ?? e);
  }
});

/* ─────────────── API ─────────────── */

// GET /api/staff/shifts?from=YYYY-MM-DD&to=YYYY-MM-DD
staffShiftsRouter.get("/api/staff/shifts", async (ctx) => {
  try {
    const { staff, restaurantId } = ensureCanView(ctx);

    const from = String(ctx.request.url.searchParams.get("from") ?? "").trim();
    const to = String(ctx.request.url.searchParams.get("to") ?? "").trim();

    if (!from || !to || !isIsoDate(from) || !isIsoDate(to)) {
      return json(ctx, Status.BadRequest, {
        ok: false,
        error: "missing_or_invalid_range",
        hint: "Use ?from=YYYY-MM-DD&to=YYYY-MM-DD",
      });
    }

    if (from > to) {
      return json(ctx, Status.BadRequest, {
        ok: false,
        error: "range_order",
        hint: "from must be <= to",
      });
    }

    const dates = dateRangeInclusive(from, to);

    const templates = await listShiftTemplates(restaurantId);
    const tmplMap = new Map(templates.map((t) => [t.id, t] as const));

    const all: any[] = [];
    for (const d of dates) {
      const shifts = await listShiftsByStaff(staff.id, d);
      for (const s of shifts) {
        // Extra safety: ensure restaurant match
        if (String((s as any)?.restaurantId ?? "") !== restaurantId) continue;

        const tmpl = (s as any)?.shiftTemplateId ? tmplMap.get((s as any).shiftTemplateId) : null;
        all.push({
          ...s,
          templateName: tmpl?.name ?? null,
        });
      }
    }

    // stable sort: by date then startTime
    all.sort((a, b) => {
      if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
      return String(a.startTime).localeCompare(String(b.startTime));
    });

    return json(ctx, Status.OK, {
      ok: true,
      restaurantId,
      staffId: staff.id,
      from,
      to,
      shifts: all,
    });
  } catch (e: any) {
    return json(ctx, e?.status ?? Status.InternalServerError, {
      ok: false,
      error: String(e?.message ?? e),
    });
  }
});

export default staffShiftsRouter;
