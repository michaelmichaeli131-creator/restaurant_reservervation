// src/routes/owner_payroll.ts
// --------------------------------------------------------
// Owner-only: Monthly payroll
// - GET  /owner/payroll                     (HTML page)
// - GET  /owner/payroll/data?restaurantId&month (JSON payroll for month)
// - POST /owner/payroll/rate                (set hourly rate per staff)
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { kv, type User, type Restaurant, getRestaurant } from "../database.ts";

// שירות הנוכחות החדש
import {
  listMonthRows,
  computePayrollForMonth,
  setHourlyRate,
  type TimeClockRow,
  type PayrollRow,
} from "../services/timeclock_db.ts";

export const ownerPayrollRouter = new Router();

console.log("[owner_payroll] router module loaded");

/* ─────────────── Helpers ─────────────── */

function ensureOwner(ctx: any): User {
  const user = ctx.state.user as User | undefined;
  if (!user || user.role !== "owner") {
    const err: any = new Error("Not owner");
    err.status = Status.Forbidden;
    throw err;
  }
  return user;
}

function json(ctx: any, status: number, body: any) {
  ctx.response.status = status;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = body;
}

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

// YYYY-MM של החודש הנוכחי לפי Asia/Jerusalem
function currentMonthInTZ(tz = "Asia/Jerusalem"): string {
  const now = Date.now();
  const d = new Date(now);
  const y = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric" });
  const m = d.toLocaleString("en-CA", { timeZone: tz, month: "2-digit" });
  return `${y}-${m}`; // YYYY-MM
}

/* ─────────────── GET: HTML page ─────────────── */
// GET /owner/payroll?restaurantId=...&month=YYYY-MM
ownerPayrollRouter.get("/owner/payroll", async (ctx) => {
  const owner = ensureOwner(ctx);
  const restaurants = await listOwnerRestaurants(owner.id);

  const qRestaurantId = String(ctx.request.url.searchParams.get("restaurantId") || "").trim();
  const qMonth = String(ctx.request.url.searchParams.get("month") || "").trim();

  const restaurantId = qRestaurantId || (restaurants[0]?.id ?? "");
  const month = qMonth || currentMonthInTZ("Asia/Jerusalem");

  if (restaurantId) {
    const r = await getRestaurant(restaurantId);
    if (!r || r.ownerId !== owner.id) {
      ctx.response.status = Status.Forbidden;
      await render(ctx, "owner/payroll", {
        title: "שכר עובדים",
        owner,
        restaurants,
        restaurantId: "",
        month,
        error: "not_your_restaurant",
      });
      return;
    }
  }

  await render(ctx, "owner/payroll", {
    title: "שכר עובדים",
    page: "owner_payroll",
    owner,
    restaurants,
    restaurantId,
    month,
  });
});

/* ─────────────── GET: Payroll data JSON ─────────────── */
// GET /owner/payroll/data?restaurantId=...&month=YYYY-MM
ownerPayrollRouter.get("/owner/payroll/data", async (ctx) => {
  try {
    const owner = ensureOwner(ctx);

    const restaurantId = String(ctx.request.url.searchParams.get("restaurantId") || "").trim();
    const month = String(ctx.request.url.searchParams.get("month") || "").trim(); // YYYY-MM

    if (!restaurantId) {
      return json(ctx, Status.BadRequest, { ok: false, error: "restaurant_required" });
    }
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return json(ctx, Status.BadRequest, { ok: false, error: "month_invalid" });
    }

    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || restaurant.ownerId !== owner.id) {
      return json(ctx, Status.Forbidden, { ok: false, error: "not_your_restaurant" });
    }

    // מושכים את כל הרשומות של החודש (TimeClockRow[])
    const rows: TimeClockRow[] = await listMonthRows(restaurantId, month);

    // בונים staffList בסיסי מתוך הרשומות (אפשר לחבר בעתיד ל־staff_db)
    const staffMap = new Map<string, { id: string; firstName?: string; lastName?: string }>();
    for (const r of rows) {
      if (!staffMap.has(r.staffId)) {
        staffMap.set(r.staffId, { id: r.staffId });
      }
    }
    const staffList = Array.from(staffMap.values());

    // משתמשים בפונקציה הקיימת שלך לחישוב שכר
    const payrollBase: PayrollRow[] = await computePayrollForMonth({
      restaurantId,
      month,
      staffList,
      rows,
    });

    // ── חיזוק: לצרף שם + אימייל של העובד (דינמי, על בסיס staff או user אם תרצה) ──
    // כאן אני מניח שקיימים אובייקטי staff ב-KV במפתח ["staff", staffId]
    // ואם לא – ניפול חזרה ל-staffId.
    type StaffInfo = { name: string; email: string };

    const staffInfoById = new Map<string, StaffInfo>();

    for (const p of payrollBase) {
      const sid = p.staffId;
      if (staffInfoById.has(sid)) continue;

      try {
        const row = await kv.get<any>(["staff", sid]);
        const v = row.value || {};
        const fullName = `${v.firstName ?? ""} ${v.lastName ?? ""}`.trim();
        const name = fullName || p.staffName || sid;
        const email = typeof v.email === "string" ? v.email : "";
        staffInfoById.set(sid, { name, email });
      } catch (e) {
        console.warn("[OWNER_PAYROLL] staff lookup failed", sid, e);
        staffInfoById.set(sid, { name: p.staffName || sid, email: "" });
      }
    }

    const payroll = payrollBase.map((p) => {
      const info = staffInfoById.get(p.staffId);
      return {
        ...p,
        displayName: info?.name || p.staffName || p.staffId,
        userEmail: info?.email || "",
      };
    });

    return json(ctx, Status.OK, {
      ok: true,
      restaurantId,
      month,
      payroll,
    });
  } catch (e: any) {
    console.error("[OWNER_PAYROLL] /owner/payroll/data error", e);
    return json(ctx, e?.status ?? Status.InternalServerError, {
      ok: false,
      error: String(e?.message ?? e),
    });
  }
});

/* ─────────────── POST: Set hourly rate ─────────────── */
// POST /owner/payroll/rate
// body: { staffId: string, hourlyRate: number }
ownerPayrollRouter.post("/owner/payroll/rate", async (ctx) => {
  try {
    const owner = ensureOwner(ctx);

    let body: any = {};
    try {
      body = await ctx.request.body({ type: "json" }).value;
    } catch {
      try {
        body = await (ctx.request.originalRequest?.request?.json?.() ??
          ctx.request.originalRequest?.json?.());
      } catch {
        body = {};
      }
    }

    const staffId = String(body?.staffId || "").trim();
    const hourlyRateRaw = body?.hourlyRate;

    if (!staffId) {
      return json(ctx, Status.BadRequest, { ok: false, error: "staff_required" });
    }

    const n = Number(hourlyRateRaw);
    if (!Number.isFinite(n) || n < 0) {
      return json(ctx, Status.BadRequest, { ok: false, error: "hourlyRate_invalid" });
    }

    // כרגע אין בדיקת מסעדה כאן – השכר פר עובד גלובלי.
    // אם תרצה, אפשר להרחיב למפתח לפי staff+restaurant.
    await setHourlyRate(staffId, n);

    return json(ctx, Status.OK, {
      ok: true,
      staffId,
      hourlyRate: n,
    });
  } catch (e: any) {
    console.error("[OWNER_PAYROLL] /owner/payroll/rate error", e);
    return json(ctx, e?.status ?? Status.InternalServerError, {
      ok: false,
      error: String(e?.message ?? e),
    });
  }
});
