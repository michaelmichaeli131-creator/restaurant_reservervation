// src/routes/timeclock.ts
// --------------------------------------------------------
// Staff:
//  - GET  /staff/timeclock
//  - POST /staff/timeclock/checkin
//  - POST /staff/timeclock/checkout
//
// Owner/Manager:
//  - GET  /owner/timeclock?restaurantId=...&month=YYYY-MM
//  - GET  /owner/timeclock/api?restaurantId=...&month=YYYY-MM
//  - POST /owner/timeclock/edit   (manual edit + optional hourlyRate)
//
// שים לב: Manager הוא user.role === "manager" (לא staff).
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant } from "../database.ts";
import type { User, StaffMember } from "../database.ts";
import { listStaffByRestaurant, getStaffById } from "../services/staff_db.ts";

import {
  checkInNow,
  checkOutNow,
  upsertManualEntry,
  listMonthRows,
  computePayrollForMonth,
  setHourlyRate,
} from "../services/timeclock_db.ts";

export const timeClockRouter = new Router();

/* ─────────────── Helpers ─────────────── */

function ensureAuthed(ctx: any): User {
  const u = ctx.state.user as User | undefined;
  if (!u) {
    const err: any = new Error("Not authenticated");
    err.status = Status.Unauthorized;
    throw err;
  }
  return u;
}

function ensureOwnerOrManager(ctx: any): User {
  const u = ensureAuthed(ctx);
  if (u.role !== "owner" && u.role !== "manager") {
    const err: any = new Error("Not owner/manager");
    err.status = Status.Forbidden;
    throw err;
  }
  return u;
}

function wantsJSON(ctx: any) {
  const acc = String(ctx.request.headers.get("accept") || "").toLowerCase();
  return acc.includes("application/json") || acc.includes("json");
}

/** גוף JSON בצורה תואמת גרסאות Oak שונות */
async function readJsonCompat(ctx: any): Promise<any> {
  // Oak (ישן): ctx.request.body() -> { type, value }
  try {
    const b = typeof ctx.request.body === "function" ? ctx.request.body() : undefined;
    if (b?.type === "json") return await b.value;
  } catch {}

  // Oak (חדש): ctx.request.body.json()
  try {
    if (ctx.request.body && typeof ctx.request.body.json === "function") {
      return await ctx.request.body.json();
    }
  } catch {}

  // fallback: text -> parse
  try {
    const txt = typeof ctx.request.body === "function"
      ? await (await ctx.request.body()).value
      : (ctx.request.body && typeof ctx.request.body.text === "function"
        ? await ctx.request.body.text()
        : null);

    if (typeof txt === "string" && txt.trim()) return JSON.parse(txt);
  } catch {}

  return {};
}

/** חישוב דקות לרשומה (למענה של API) */
function minutesWorkedLocal(row: any): number {
  if (!row?.checkInAt || !row?.checkOutAt) return 0;
  return Math.max(0, Math.floor((Number(row.checkOutAt) - Number(row.checkInAt)) / 60000));
}

/* ─────────────── Staff UI ─────────────── */

timeClockRouter.get("/staff/timeclock", async (ctx) => {
  const user = ensureAuthed(ctx);

  // staff context מגיע מ-middleware שלך
  const staff = (ctx.state as any).staff as StaffMember | null;
  const staffRestaurantId = (ctx.state as any).staffRestaurantId as string | null;

  if (user.role !== "staff" || !staff || !staffRestaurantId) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const r = await getRestaurant(staffRestaurantId);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  await render(ctx, "staff/timeclock", {
    title: "כניסה/יציאה",
    restaurant: r,
    staff,
  });
});

timeClockRouter.post("/staff/timeclock/checkin", async (ctx) => {
  const user = ensureAuthed(ctx);

  const staff = (ctx.state as any).staff as StaffMember | null;
  const staffRestaurantId = (ctx.state as any).staffRestaurantId as string | null;

  if (user.role !== "staff" || !staff || !staffRestaurantId) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "forbidden" };
    return;
  }

  const res = await checkInNow({
    restaurantId: staffRestaurantId,
    staffId: staff.id,
    userId: user.id,
    source: "staff",
  });

  if (!res.ok) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = res;
    return;
  }

  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, row: res.row };
});

timeClockRouter.post("/staff/timeclock/checkout", async (ctx) => {
  const user = ensureAuthed(ctx);

  const staff = (ctx.state as any).staff as StaffMember | null;

  if (user.role !== "staff" || !staff) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "forbidden" };
    return;
  }

  const res = await checkOutNow({
    staffId: staff.id,
    userId: user.id,
    roleForAudit: "staff",
  });

  if (!res.ok) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = res;
    return;
  }

  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, row: res.row };
});

/* ─────────────── Owner/Manager Calendar ─────────────── */

timeClockRouter.get("/owner/timeclock", async (ctx) => {
  const user = ensureOwnerOrManager(ctx);

  const restaurantId = String(ctx.request.url.searchParams.get("restaurantId") || "").trim();
  const monthQ = String(ctx.request.url.searchParams.get("month") || "").trim(); // YYYY-MM

  if (!restaurantId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "restaurantId required";
    return;
  }

  const r = await getRestaurant(restaurantId);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "restaurant not found";
    return;
  }

  if (user.role === "owner" && r.ownerId !== user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "not your restaurant";
    return;
  }

  const ym = monthQ || (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  })();

  const rows = await listMonthRows(restaurantId, ym);
  const staffList = await listStaffByRestaurant(restaurantId, { includeInactive: true });

  const payroll = await computePayrollForMonth({
    restaurantId,
    month: ym,
    staffList: staffList.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName })),
    rows,
  });

  if (wantsJSON(ctx)) {
    ctx.response.status = Status.OK;
    ctx.response.body = { ok: true, restaurantId, month: ym, rows, payroll };
    return;
  }

  await render(ctx, "owner/timeclock", {
    title: "נוכחות ושכר",
    restaurant: r,
    month: ym,
    rows,
    staffList,
    payroll,
  });
});

timeClockRouter.get("/owner/timeclock/api", async (ctx) => {
  const user = ensureOwnerOrManager(ctx);

  const restaurantId = String(ctx.request.url.searchParams.get("restaurantId") || "").trim();
  const month = String(ctx.request.url.searchParams.get("month") || "").trim();

  if (!restaurantId || !month) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "restaurantId_and_month_required" };
    return;
  }

  const r = await getRestaurant(restaurantId);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "restaurant_not_found" };
    return;
  }

  if (user.role === "owner" && r.ownerId !== user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "not_your_restaurant" };
    return;
  }

  const rows = await listMonthRows(restaurantId, month);
  const staffList = await listStaffByRestaurant(restaurantId, { includeInactive: true });

  const payroll = await computePayrollForMonth({
    restaurantId,
    month,
    staffList: staffList.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName })),
    rows,
  });

  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, restaurantId, month, rows, payroll };
});

timeClockRouter.post("/owner/timeclock/edit", async (ctx) => {
  const user = ensureOwnerOrManager(ctx);

  const v = await readJsonCompat(ctx);
  const restaurantId = String(v?.restaurantId || "").trim();
  const staffId = String(v?.staffId || "").trim();
  const ymd = String(v?.ymd || "").trim(); // YYYY-MM-DD

  // allow null to clear; allow number to set; undefined => keep
  const checkInAt =
    v?.checkInAt === null ? null : (v?.checkInAt !== undefined ? Number(v.checkInAt) : undefined);
  const checkOutAt =
    v?.checkOutAt === null ? null : (v?.checkOutAt !== undefined ? Number(v.checkOutAt) : undefined);
  const note =
    v?.note === null ? null : (v?.note !== undefined ? String(v.note) : undefined);

  if (!restaurantId || !staffId || !ymd) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const r = await getRestaurant(restaurantId);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "restaurant_not_found" };
    return;
  }
  if (user.role === "owner" && r.ownerId !== user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "not_your_restaurant" };
    return;
  }

  const staff = await getStaffById(staffId);
  if (!staff || staff.restaurantId !== restaurantId) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "staff_not_found" };
    return;
  }

  const edited = await upsertManualEntry({
    restaurantId,
    staffId,
    ymd,
    checkInAt,
    checkOutAt,
    note,
    actorUserId: user.id,
    actorRole: user.role,
  });

  if (!edited.ok) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: edited.error, open: edited.open };
    return;
  }

  // optional: hourlyRate update from same modal
  if (v?.hourlyRate !== undefined && v.hourlyRate !== null && v.hourlyRate !== "") {
    const hr = Number(v.hourlyRate);
    if (Number.isFinite(hr) && hr >= 0) {
      await setHourlyRate(staffId, hr);
    }
  }

  ctx.response.status = Status.OK;
  ctx.response.body = {
    ok: true,
    row: edited.row,
    minutes: minutesWorkedLocal(edited.row),
  };
});
