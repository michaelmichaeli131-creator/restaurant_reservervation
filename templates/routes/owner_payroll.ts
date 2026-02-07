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

// User כמו שהוא נשמר ב-KV (הערכה סבירה)
type AppUser = {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
};

/**
 * ניסיון להביא User מתוך KV ישירות.
 * אם המפתח בפועל שונה – הפונקציה פשוט תחזיר null והמערכת תמשיך לעבוד עם fallback.
 */
async function getUserFromKV(userId: string): Promise<AppUser | null> {
  try {
    const res = await kv.get<AppUser>(["user", userId]);
    return res.value ?? null;
  } catch (e) {
    console.warn("[OWNER_PAYROLL] getUserFromKV failed", userId, e);
    return null;
  }
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

    // אם אין רשומות – נחזיר ריק מהר
    if (!rows.length) {
      return json(ctx, Status.OK, {
        ok: true,
        restaurantId,
        month,
        payroll: [],
      });
    }

    // אוסף כל staffIds שבאמת עבדו החודש
    const staffIds = new Set<string>();
    for (const r of rows) {
      if (r.staffId) staffIds.add(r.staffId);
    }

    // ── 1) staff_by_restaurant: ניסיון להביא firstName/lastName/email (fallback) ──
    type StaffKV = {
      id?: string;
      staffId?: string;
      firstName?: string;
      lastName?: string;
      fullName?: string;
      name?: string;
      email?: string;
      userId?: string;
    };

    const staffInfoById = new Map<
      string,
      { firstName?: string; lastName?: string; email?: string; userId?: string }
    >();

    for await (const row of kv.list({ prefix: ["staff_by_restaurant", restaurantId] })) {
      const v = row.value as StaffKV | undefined;
      if (!v) continue;

      // חשוב: staffId לפי ה-key קודם, כדי שיתאים ל-timeclock
      const sid = String(
        row.key[row.key.length - 1] ??
        v.staffId ??
        v.id ??
        "",
      ).trim();

      if (!sid || !staffIds.has(sid)) continue; // מעניין רק מי שעבד החודש

      const firstName =
        v.firstName ??
        (v as any).first_name ??
        (v.fullName ? v.fullName.split(" ")[0] : "") ??
        (v.name ? v.name.split(" ")[0] : "");

      const lastName =
        v.lastName ??
        (v as any).last_name ??
        (v.fullName ? v.fullName.split(" ").slice(1).join(" ") : "") ??
        (v.name ? v.name.split(" ").slice(1).join(" ") : "");

      const email = typeof v.email === "string" ? v.email : "";
      const userId = typeof v.userId === "string" ? v.userId : undefined;

      staffInfoById.set(sid, { firstName, lastName, email, userId });
    }

    // ── 2) ממפים staffId -> userId מתוך timeclock עצמו ──
    const staffToUser = new Map<string, string>();
    for (const r of rows) {
      if (!r.staffId || !r.userId) continue;
      if (!staffToUser.has(r.staffId)) {
        staffToUser.set(r.staffId, r.userId);
      }
    }

    // ── 3) מביאים User מכל ה-userIds שנמצאו ──
    const userIdsSet = new Set<string>();
    for (const uid of staffToUser.values()) {
      if (uid) userIdsSet.add(uid);
    }

    const userById = new Map<string, AppUser>();
    for (const uid of userIdsSet) {
      const u = await getUserFromKV(uid);
      if (u) userById.set(uid, u);
    }

    // ── 4) בונים staffList בשביל computePayrollForMonth, עם firstName/lastName "אמיתיים" ──
    const staffList = Array.from(staffIds).map((sid) => {
      const staffInfo = staffInfoById.get(sid);
      const uid = staffToUser.get(sid);
      const u = uid ? userById.get(uid) : undefined;

      const firstName = staffInfo?.firstName || u?.firstName;
      const lastName = staffInfo?.lastName || u?.lastName;

      return {
        id: sid,
        firstName,
        lastName,
      };
    });

    // חישוב שכר בסיסי (ישתמש firstName/lastName כשיש)
    const payrollBase: PayrollRow[] = await computePayrollForMonth({
      restaurantId,
      month,
      staffList,
      rows,
    });

    // ── 5) מוסיפים displayName + userEmail לתוצאה (עדיפות ל-User, אחר כך staffInfo, אחר כך fallback) ──
    const payroll = payrollBase.map((p) => {
      const staffInfo = staffInfoById.get(p.staffId);
      const uid =
        staffToUser.get(p.staffId) ??
        staffInfo?.userId;

      const u = uid ? userById.get(uid) : undefined;

      const first =
        staffInfo?.firstName ||
        u?.firstName ||
        undefined;

      const last =
        staffInfo?.lastName ||
        u?.lastName ||
        undefined;

      const fullName = `${first ?? ""} ${last ?? ""}`.trim();
      const displayName = fullName || p.staffName || p.staffId;
      const userEmail =
        staffInfo?.email ||
        u?.email ||
        "";

      return {
        ...p,
        displayName,
        userEmail,
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
