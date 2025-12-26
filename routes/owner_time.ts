// src/routes/owner_time.ts
// --------------------------------------------------------
// Owner-only: Time tracking calendar + manual edits
// - GET  /owner/time                     (HTML page)
// - GET  /owner/time/day?restaurantId&day (JSON day entries)
// - POST /owner/time/entry/:id/manual    (JSON update clockIn/clockOut/note)
// --------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";

import { kv, type User, type Restaurant, getRestaurant } from "../database.ts";
import { getTimeEntry, listEntriesByRestaurantDay } from "../services/time_db.ts";
import type { TimeEntry } from "../services/time_db.ts";

// *** חדש – שימוש ב־timeclock_db (המערכת החדשה של נוכחות) ***
import {
  listMonthRows,
  minutesWorked,
  type TimeClockRow,
} from "../services/timeclock_db.ts";

export const ownerTimeRouter = new Router();

console.log("[owner_time] router module loaded");

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

function wantsJSON(ctx: any) {
  const acc = String(ctx.request.headers.get("accept") || "").toLowerCase();
  const ct = String(ctx.request.headers.get("content-type") || "").toLowerCase();
  return acc.includes("application/json") || acc.includes("json") || ct.includes("application/json");
}

function json(ctx: any, status: number, body: any) {
  ctx.response.status = status;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = body;
}

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

function getOakBodyCompat(ctx: any): any {
  const b = ctx?.request?.body;
  if (!b) return undefined;
  if (typeof b === "function") return b.call(ctx.request);
  return b;
}

async function readJsonCompat(ctx: any): Promise<any> {
  const req = getNativeRequestCompat(ctx);
  if (req && typeof (req as any).json === "function") return await (req as any).json();

  const body = getOakBodyCompat(ctx);
  if (body) {
    if (typeof body.json === "function") return await body.json();

    const t = typeof body.type === "string"
      ? body.type
      : (typeof body.type === "function" ? body.type() : undefined);

    if (t === "json") {
      const v = (body as any).value;
      if (typeof v === "function") return await v.call(body);
      if (v !== undefined) return await v;
    }

    if (typeof body.getReader === "function") return await new Response(body).json();
  }

  // last resort
  try {
    const txt = await (req ? (req as any).text() : new Response(getOakBodyCompat(ctx)).text());
    return JSON.parse(txt);
  } catch {
    return {};
  }
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

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function todayInTZ(tz = "Asia/Jerusalem"): string {
  const now = Date.now();
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date(now)); // YYYY-MM-DD
}

function fmtTime(ms: number, tz = "Asia/Jerusalem") {
  const dtf = new Intl.DateTimeFormat("he-IL", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
  return dtf.format(new Date(ms));
}

function minutesBetween(a: number, b: number) {
  return Math.max(0, Math.round((b - a) / 60000));
}

function safeParseMs(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;

  // allow:
  // - epoch ms
  // - ISO string
  // - "YYYY-MM-DDTHH:mm"
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }

  const d = new Date(s);
  const ms = d.getTime();
  if (Number.isFinite(ms)) return ms;

  return null;
}

/* ─────────────── GET: HTML page ─────────────── */
// GET /owner/time?restaurantId=...&day=YYYY-MM-DD
ownerTimeRouter.get("/owner/time", async (ctx) => {
  const owner = ensureOwner(ctx);
  const tz = "Asia/Jerusalem";

  const restaurants = await listOwnerRestaurants(owner.id);
  const qRestaurantId = String(ctx.request.url.searchParams.get("restaurantId") || "").trim();
  const qDay = String(ctx.request.url.searchParams.get("day") || "").trim();

  const restaurantId = qRestaurantId || (restaurants[0]?.id ?? "");
  const day = qDay || todayInTZ(tz);

  // verify restaurant belongs to owner
  if (restaurantId) {
    const r = await getRestaurant(restaurantId);
    if (!r || r.ownerId !== owner.id) {
      ctx.response.status = Status.Forbidden;
      await render(ctx, "owner/time", {
        title: "נוכחות עובדים",
        owner,
        restaurants,
        restaurantId: "",
        day,
        error: "not_your_restaurant",
      });
      return;
    }
  }

  await render(ctx, "owner/time", {
    title: "נוכחות עובדים",
    page: "owner_time",
    owner,
    restaurants,
    restaurantId,
    day,
  });
});

// GET /owner/time/day?restaurantId=...&day=YYYY-MM-DD  (JSON)
ownerTimeRouter.get("/owner/time/day", async (ctx) => {
  try {
    const owner = ensureOwner(ctx);
    const tz = "Asia/Jerusalem";

    const restaurantId = String(ctx.request.url.searchParams.get("restaurantId") || "").trim();
    const day = String(ctx.request.url.searchParams.get("day") || "").trim();

    if (!restaurantId) {
      return json(ctx, Status.BadRequest, { ok: false, error: "restaurant_required" });
    }
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return json(ctx, Status.BadRequest, { ok: false, error: "day_invalid" });
    }

    const restaurant = await getRestaurant(restaurantId);
    if (!restaurant || restaurant.ownerId !== owner.id) {
      return json(ctx, Status.Forbidden, { ok: false, error: "not_your_restaurant" });
    }

    const month = day.slice(0, 7); // "YYYY-MM"

    // 🔍 DEBUG: מה הבעלים מחפש
    console.log("[OWNER_TIME] query", { restaurantId, day, month });

    // שלב 1 – למשוך את כל רשומות הנוכחות של החודש עבור המסעדה הזו
    const monthRows: TimeClockRow[] = await listMonthRows(restaurantId, month);

    console.log("[OWNER_TIME] monthRows", {
      restaurantId,
      month,
      count: monthRows.length,
      rows: monthRows,
    });

    // שלב 2 – לסנן רק את היום המבוקש
    const dayRows: TimeClockRow[] = monthRows.filter((r) => r.ymd === day);

    console.log("[OWNER_TIME] dayRows_after_filter", {
      restaurantId,
      day,
      count: dayRows.length,
      rows: dayRows,
    });

    const debugWithMinutes = dayRows.map((r) => ({
      staffId: r.staffId,
      ymd: r.ymd,
      checkInAt: r.checkInAt,
      checkOutAt: r.checkOutAt,
      minutes: minutesWorked(r),
    }));
    console.log("[OWNER_TIME] dayRows_with_minutes", debugWithMinutes);

    // נבנה entries במבנה דומה ל-TimeEntry כדי לא לשבור את ה-UI
    type UiEntry = {
      id: string;
      restaurantId: string;
      staffId: string;
      userId: string;
      ymd: string;
      clockInAt: number | null;
      clockOutAt: number | null;
      note: string | null;
      source: string;
      createdAt: number;
      updatedAt?: number;
      clockInLabel: string;
      clockOutLabel: string;
      minutes: number;
    };

    const nowMs = Date.now();
    const entries: UiEntry[] = dayRows.map((r) => {
      const clockIn = typeof r.checkInAt === "number" ? r.checkInAt : null;
      const clockOut = typeof r.checkOutAt === "number" ? r.checkOutAt : null;

      const minutes = clockIn
        ? (clockOut
          ? minutesBetween(clockIn, clockOut)
          : minutesBetween(clockIn, nowMs))
        : 0;

      return {
        id: `${r.staffId}-${r.ymd}-${clockIn ?? "0"}`, // מזהה סינתטי
        restaurantId: r.restaurantId,
        staffId: r.staffId,
        userId: r.userId ?? "",
        ymd: r.ymd,
        clockInAt: clockIn,
        clockOutAt: clockOut,
        note: r.note ?? null,
        source: r.source ?? "staff",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt ?? r.createdAt,
        clockInLabel: clockIn ? fmtTime(clockIn, tz) : "",
        clockOutLabel: clockOut ? fmtTime(clockOut, tz) : "פתוח",
        minutes,
      };
    });

    // group by staffId עם סכום דקות
    const groups: Record<
      string,
      { staffId: string; userId: string; entries: UiEntry[]; totalMinutes: number }
    > = {};

    for (const e of entries) {
      if (!groups[e.staffId]) {
        groups[e.staffId] = {
          staffId: e.staffId,
          userId: e.userId,
          entries: [],
          totalMinutes: 0,
        };
      }
      groups[e.staffId].entries.push(e);
      groups[e.staffId].totalMinutes += e.minutes;
    }

    console.log("[OWNER_TIME] response_summary", {
      restaurantId,
      day,
      rowsCount: entries.length,
      groupsCount: Object.keys(groups).length,
    });

    return json(ctx, Status.OK, {
      ok: true,
      restaurantId,
      day,
      rows: entries,
      grouped: Object.values(groups),
    });
  } catch (e: any) {
    console.error("[OWNER_TIME] /owner/time/day error", e);
    return json(ctx, e?.status ?? Status.InternalServerError, {
      ok: false,
      error: String(e?.message ?? e),
    });
  }
});

/* ─────────────── POST: Manual edit entry (JSON) ─────────────── */
// POST /owner/time/entry/:id/manual
// body: { clockInAt?: number|string, clockOutAt?: number|string|null, note?: string }
ownerTimeRouter.post("/owner/time/entry/:id/manual", async (ctx) => {
  try {
    const owner = ensureOwner(ctx);
    const entryId = String(ctx.params.id || "").trim();
    if (!entryId) return json(ctx, Status.BadRequest, { ok: false, error: "entry_required" });

    const entry = await getTimeEntry(entryId);
    if (!entry) return json(ctx, Status.NotFound, { ok: false, error: "entry_not_found" });

    // verify owner owns the restaurant
    const restaurant = await getRestaurant(entry.restaurantId);
    if (!restaurant || restaurant.ownerId !== owner.id) {
      return json(ctx, Status.Forbidden, { ok: false, error: "not_your_restaurant" });
    }

    const body = await readJsonCompat(ctx);

    const inMs = safeParseMs(body?.clockInAt);
    const outMs = body?.clockOutAt === null ? null : safeParseMs(body?.clockOutAt);
    const note = body?.note ? String(body.note).slice(0, 300) : undefined;

    const nextClockInAt = inMs ?? entry.clockInAt;
    const nextClockOutAt = outMs === null ? undefined : (outMs ?? entry.clockOutAt);

    if (typeof nextClockInAt !== "number" || !Number.isFinite(nextClockInAt)) {
      return json(ctx, Status.BadRequest, { ok: false, error: "clockInAt_invalid" });
    }

    if (nextClockOutAt !== undefined) {
      if (typeof nextClockOutAt !== "number" || !Number.isFinite(nextClockOutAt)) {
        return json(ctx, Status.BadRequest, { ok: false, error: "clockOutAt_invalid" });
      }
      if (nextClockOutAt < nextClockInAt) {
        return json(ctx, Status.BadRequest, { ok: false, error: "clockout_before_clockin" });
      }
    }

    const now = Date.now();
    const updated: TimeEntry = {
      ...entry,
      clockInAt: nextClockInAt,
      ...(nextClockOutAt !== undefined ? { clockOutAt: nextClockOutAt } : { clockOutAt: undefined }),
      note: note ?? entry.note,
      updatedAt: now,
      editedBy: { userId: owner.id, role: owner.role, at: now },
      source: "owner",
    };

    // Save (simple set). Indexes: day might change if clockInAt day changed.
    // MVP: keep indexes as-is (still queryable by the original day).
    // If you want perfect reindex, we can add it next step.
    // For now: owner edits are typically within same day.
    await kv.set(["time_entry", entryId], updated);

    return json(ctx, Status.OK, { ok: true, entry: updated });
  } catch (e: any) {
    return json(ctx, e?.status ?? Status.InternalServerError, { ok: false, error: String(e?.message ?? e) });
  }
});
