// src/routes/owner_hours.ts
// ניהול שעות פתיחה שבועיות למסעדה — לבעלים בלבד

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  getRestaurant,
  updateRestaurant,
  type Restaurant,
  type WeeklySchedule,
  type DayOfWeek,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

const ownerHoursRouter = new Router();

const DAY_LABELS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"] as const;

// ---------- GET ----------
ownerHoursRouter.get("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  debugLog("[owner_hours][GET] load", { id, found: !!r, ownerId: r?.ownerId, userId: (ctx.state as any)?.user?.id });

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  // טעינת weeklySchedule קיים (אם יש)
  const weekly: WeeklySchedule = {};
  const source = r.weeklySchedule ?? (r as any).openingHours ?? (r as any).hours ?? {};
  
  for (let d = 0 as 0|1|2|3|4|5|6; d <= 6; d = (d + 1) as 0|1|2|3|4|5|6) {
    const cur = source[d] ?? source[String(d)] ?? null;
    if (cur && typeof cur === "object" && cur.open && cur.close) {
      weekly[d] = { open: String(cur.open), close: String(cur.close) };
    } else {
      weekly[d] = null;
    }
  }

  debugLog("[owner_hours][GET] current.weeklySchedule", weekly);

  await render(ctx, "owner_hours", {
    title: `שעות פתיחה — ${r.name}`,
    page: "owner_hours",
    restaurant: r,
    weekly,
    labels: DAY_LABELS,
    saved: ctx.request.url.searchParams.get("saved") === "1",
  });
});

// ---------- POST ----------
ownerHoursRouter.post("/owner/restaurants/:id/hours", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  // קריאת raw text ופרסור JSON ידני
  let payload: any = {};
  try {
    const body = ctx.request.body({ type: "text" });
    const text = await body.value;
    debugLog("[owner_hours][POST] raw body", text?.slice(0, 200) || "(empty)");
    if (text) {
      payload = JSON.parse(text);
    }
  } catch (e) {
    debugLog("[owner_hours][POST] body parse error", String(e));
  }

  debugLog("[owner_hours][POST] payload", payload);

  // קליטת weeklySchedule מה-payload
  let weeklySchedule: WeeklySchedule = {};

  if (payload.weeklySchedule && typeof payload.weeklySchedule === 'object') {
    const raw = payload.weeklySchedule as any;
    for (let d = 0; d <= 6; d++) {
      const day = d as DayOfWeek;
      const entry = raw[d] ?? raw[String(d)] ?? null;
      if (entry && typeof entry === 'object' && entry.open && entry.close) {
        weeklySchedule[day] = { open: String(entry.open), close: String(entry.close) };
      } else {
        weeklySchedule[day] = null;
      }
    }
  }
  
  debugLog("[owner_hours][POST] parsed.weeklySchedule", weeklySchedule);

  const capacity = Number(payload.capacity) || r.capacity;
  const slotIntervalMinutes = Number(payload.slotIntervalMinutes) || r.slotIntervalMinutes;
  const serviceDurationMinutes = Number(payload.serviceDurationMinutes) || r.serviceDurationMinutes;

  const patch: Partial<Restaurant> = {
    weeklySchedule,
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : r.capacity,
    slotIntervalMinutes: Number.isFinite(slotIntervalMinutes) && slotIntervalMinutes > 0 ? slotIntervalMinutes : r.slotIntervalMinutes,
    serviceDurationMinutes: Number.isFinite(serviceDurationMinutes) && serviceDurationMinutes > 0 ? serviceDurationMinutes : r.serviceDurationMinutes,
  };

  try {
    await updateRestaurant(id, patch);
    debugLog("[owner_hours][POST] updateRestaurant.ok", { id });
  } catch (e) {
    debugLog("[owner_hours][POST] updateRestaurant.error", { error: String(e) });
    ctx.response.status = Status.InternalServerError;
    await render(ctx, "error", { title: "שגיאה בשמירה", message: "אירעה תקלה בשמירת שעות הפתיחה." });
    return;
  }

  // בדיקה אם זה JSON request
  const wantsJson =
    (ctx.request.headers.get("accept") || "").includes("application/json") ||
    (ctx.request.headers.get("content-type") || "").includes("application/json");

  if (wantsJson) {
    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ 
      ok: true, 
      weeklySchedule, 
      capacity: patch.capacity, 
      slotIntervalMinutes: patch.slotIntervalMinutes 
    }, null, 2);
  } else {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/hours?saved=1`);
  }
});

export default ownerHoursRouter;
export { ownerHoursRouter };