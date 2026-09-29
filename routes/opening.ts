// src/routes/opening.ts
import { Router, Status } from "jsr:@oak/oak";
import { checkAvailability, checkRoomCapacity, getRestaurant } from "../database.ts";
import { openingWindowsForDate } from "../database.ts";
import { getRestaurantSystemNow } from "../services/system_time.ts";
import { validDate } from "../lib/booking_validation.ts";
import { debugLog } from "../lib/debug.ts";

const openingRouter = new Router();

/**
 * GET /restaurants/:id/opening?date=YYYY-MM-DD
 * מחזיר: { openingWindows: [{open,close}], slotIntervalMinutes: number }
 */
openingRouter.get("/restaurants/:id/opening", async (ctx) => {
  const id = ctx.params.id!;
  const date = ctx.request.url.searchParams.get("date") || "";

  const r = await getRestaurant(id);
  if (!r || !r.approved) {
    ctx.response.status = Status.NotFound;
    ctx.response.type = "json";
    ctx.response.body = { error: "not_found" };
    return;
  }

  if (!validDate(date)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "invalid_date" };
    return;
  }
  // תמיד פירוש לפי התאריך שהלקוח ביקש:
  const openingWindows = openingWindowsForDate(r, date);
  const slotIntervalMinutes = r.slotIntervalMinutes || 15;

  debugLog("[opening.api]", { id, date, openingWindows, slotIntervalMinutes });

  ctx.response.headers.set("Cache-Control", "no-store, max-age=0");
  ctx.response.headers.set("Pragma", "no-cache");
  ctx.response.headers.set("Expires", "0");

  ctx.response.status = Status.OK;
  ctx.response.type = "json";
  const now = await getRestaurantSystemNow(id);
  const pad = (v: number) => String(v).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const currentTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const step = Math.max(1, Math.floor(Number(slotIntervalMinutes) || 15));
  const duration = Math.max(1, Number(r.serviceDurationMinutes) || 120);
  const minutes = (v: string) => {
    const m = /^(\d{2}):(\d{2})$/.exec(v);
    return m && (+m[1] < 24 || (+m[1] === 24 && +m[2] === 0)) && +m[2] < 60 ? +m[1]*60 + +m[2] : NaN;
  };
  const times = new Set<string>();
  for (const window of openingWindows) {
    const start = minutes(window.open), end = minutes(window.close);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let m = Math.ceil(start / step) * step; m + duration <= end && m < 1440; m += step) {
      const time = `${pad(Math.floor(m/60))}:${pad(m%60)}`;
      if (date > today || (date === today && time > currentTime)) times.add(time);
    }
  }
  const peopleRaw = ctx.request.url.searchParams.get("people");
  const people = Number(peopleRaw ?? 2);
  const preferredLayoutId = ctx.request.url.searchParams.get("preferredLayoutId") || "";
  if (!Number.isInteger(people) || people < 1 || people > 100) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { error: "invalid_people" };
    return;
  }
  const openingTimes = [...times].sort();
  const bookableTimes: string[] = [];
  {
    const reads = new Map<string, Promise<unknown>>();
    // Bound concurrent reads; reuse the same validators as reservation creation.
    for (let offset = 0; offset < openingTimes.length; offset += 4) {
      const batch = openingTimes.slice(offset, offset + 4);
      const available = await Promise.all(batch.map(async time => {
        const total = await checkAvailability(id, date, time, people, reads);
        if (!total.ok) return false;
        return !preferredLayoutId || (await checkRoomCapacity(id, preferredLayoutId, date, time, people, reads)).ok;
      }));
      batch.forEach((time, i) => { if (available[i]) bookableTimes.push(time); });
    }
  }
  ctx.response.body = { openingWindows, slotIntervalMinutes, bookableTimes, openingTimes, today, currentTime };
});

export default openingRouter;
export { openingRouter };



