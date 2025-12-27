// src/routes/owner_payroll.ts
// --------------------------------------------------------
// Owner-only: Monthly payroll
// - GET  /owner/payroll                         (HTML page)
// - GET  /owner/payroll/data?restaurantId&month (JSON payroll for month)
// - POST /owner/payroll/rate                    (set hourly rate per staff)
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

    // כל רשומות הנוכחות של החודש
    const rows: TimeClockRow[] = await listMonthRows(restaurantId, month);

    // בונים staffList בסיסי עבור computePayrollForMonth
    const staffMap = new Map<string, { id: string; firstName?: string; lastName?: string }>();
    for (const r of rows) {
      if (!staffMap.has(r.staffId)) {
        staffMap.set(r.staffId, { id: r.staffId });
      }
    }
    const staffList = Array.from(staffMap.values());

    // חישוב שכר בסיסי
    const payrollBase: PayrollRow[] = await computePayrollForMonth({
      restaurantId,
      month,
      staffList,
      rows,
    });

    // ── בניית שם + מייל לעובד מתוך KV של staff ──
    type StaffInfo = { name: string; email: string };
    const staffInfoById = new Map<string, StaffInfo>();

    const staffIds = payrollBase.map((p) => p.staffId);

    for (const sid of staffIds) {
      if (staffInfoById.has(sid)) continue;

      let name = "";
      let email = "";

      // 1) staff_by_restaurant[restaurantId, staffId]
      try {
        const s2 = await kv.get<any>(["staff_by_restaurant", restaurantId, sid]);
        if (s2.value) {
          const v = s2.value;
          const fullName = `${v.firstName ?? ""} ${v.lastName ?? ""}`.trim();
          name = fullName || v.fullName || v.name || "";
          if (typeof v.email === "string") email = email || v.email;
        }
      } catch (e) {
        console.warn("[OWNER_PAYROLL] staff_by_restaurant lookup failed", { restaurantId, sid, e });
      }

      // 2) staff[sid] (fallback)
      if (!name) {
        try {
          const s1 = await kv.get<any>(["staff", sid]);
          if (s1.value) {
            const v = s1.value;
            const fullName = `${v.firstName ?? ""} ${v.lastName ?? ""}`.trim();
            name = fullName || v.fullName || v.name || "";
            if (typeof v.email === "string") email = email || v.email;
          }
        } catch (e) {
          console.warn("[OWNER_PAYROLL] staff KV lookup failed", sid, e);
        }
      }

      // 3) אם אין כלום – פולבאק למה שיש ב-payrollBase או ל-ID
      if (!name) {
        const base = payrollBase.find((p) => p.staffId === sid);
        name = base?.staffName || sid;
      }

      staffInfoById.set(sid, { name, email });
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

    // כרגע אין בדיקת מסעדה – השכר פר עובד גלובלי.
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
