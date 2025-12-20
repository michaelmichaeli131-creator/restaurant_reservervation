// routes/timeclock.ts
// --------------------------------------------------------
// Staff:
//  - GET  /staff/timeclock?restaurantId=...
//  - POST /staff/timeclock/checkin
//  - POST /staff/timeclock/checkout
//
// Owner/Manager:
//  - GET  /owner/timeclock?restaurantId=...&month=YYYY-MM
//  - GET  /owner/timeclock/api?restaurantId=...&month=YYYY-MM
//  - POST /owner/timeclock/edit   (manual edit)
//
// שים לב: Manager הוא user.role === "manager" (לא staff).
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant } from "../database.ts";
import type { User, StaffMember } from "../database.ts";
import { listStaffByRestaurant, getStaffById, setStaffHourlyRate } from "../services/staff_db.ts";
import {
  checkInNow,
  checkOutNow,
  upsertManual,
  listMonthForRestaurant,
  computeMonthlyPayroll,
  minutesWorked,
} from "../services/timeclock_db.ts";

export const timeClockRouter = new Router();

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

async function readJsonCompat(ctx: any): Promise<any> {
  // Oak versions differ; simplest:
  try {
    const b = ctx.request.body?.();
    if (b?.type === "json") return await b.value;
  } catch {}
  try {
    return await ctx.request.body?.json();
  } catch {}
  // fallback
  const txt = await ctx.request.body?.text?.();
  if (txt) return JSON.parse(txt);
  return {};
}

/* ─────────────── Staff UI ─────────────── */

timeClockRouter.get("/staff/timeclock", async (ctx) => {
  const user = ensureAuthed(ctx);

  // staff context מגיע מ-middleware שלך (לפי NEW3 ב-view.ts)
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

  const res = await checkInNow(staffRestaurantId, staff.id);
  if (!res.ok) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = res;
    return;
  }

  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, row: res.row };
});

timeClockRouter.post("/staff/timeclock/checkout", async (ctx) => {
  const user = ensureAuthed(ctx);

  const staff = (ctx.state as any).staff as StaffMember | null;
  const staffRestaurantId = (ctx.state as any).staffRestaurantId as string | null;

  if (user.role !== "staff" || !staff || !staffRestaurantId) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = { ok: false, error: "forbidden" };
    return;
  }

  const res = await checkOutNow(staffRestaurantId, staff.id);
  if (!res.ok) {
    ctx.response.status = Status.BadRequest;
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
  const month = String(ctx.request.url.searchParams.get("month") || "").trim(); // YYYY-MM

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

  // Owner יכול רק שלו; Manager – כרגע נותנים גישה (אם תרצה גם בדיקה לפי UserRestaurantRole נוסיף)
  if (user.role === "owner" && r.ownerId !== user.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "not your restaurant";
    return;
  }

  const ym = month || (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  })();

  const rows = await listMonthForRestaurant(restaurantId, ym);
  const staffList = await listStaffByRestaurant(restaurantId, { includeInactive: true });

  const staffById = new Map(staffList.map((s) => [s.id, s]));
  const payroll = computeMonthlyPayroll(rows, staffById);

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
  // זהה ל-HTML אבל תמיד JSON
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

  const rows = await listMonthForRestaurant(restaurantId, month);
  const staffList = await listStaffByRestaurant(restaurantId, { includeInactive: true });
  const staffById = new Map(staffList.map((s) => [s.id, s]));
  const payroll = computeMonthlyPayroll(rows, staffById);

  ctx.response.status = Status.OK;
  ctx.response.body = { ok: true, restaurantId, month, rows, payroll };
});

timeClockRouter.post("/owner/timeclock/edit", async (ctx) => {
  const user = ensureOwnerOrManager(ctx);

  const v = await readJsonCompat(ctx);
  const restaurantId = String(v?.restaurantId || "").trim();
  const staffId = String(v?.staffId || "").trim();
  const ymd = String(v?.ymd || "").trim(); // YYYY-MM-DD

  const checkInAt = v?.checkInAt === null ? null : (v?.checkInAt ? Number(v.checkInAt) : undefined);
  const checkOutAt = v?.checkOutAt === null ? null : (v?.checkOutAt ? Number(v.checkOutAt) : undefined);
  const note = v?.note === null ? null : (v?.note ? String(v.note) : undefined);

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

  const row = await upsertManual(restaurantId, staffId, ymd, { checkInAt, checkOutAt, note }, user.id);

  // אופציונלי: עדכון hourlyRate באותו מסך
  if (v?.hourlyRate !== undefined) {
    const hr = Number(v.hourlyRate);
    if (Number.isFinite(hr) && hr >= 0) {
      await setStaffHourlyRate(staffId, hr);
    }
  }

  ctx.response.status = Status.OK;
  ctx.response.body = {
    ok: true,
    row,
    minutes: minutesWorked(row),
  };
});
