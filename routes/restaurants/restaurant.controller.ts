// src/routes/restaurants/restaurant.controller.ts
import { Status } from "jsr:@oak/oak";
import { listRestaurants, getRestaurant, type WeeklySchedule } from "../../database.ts";
import { render } from "../../lib/view.ts";
import { debugLog } from "../../lib/debug.ts";
import { todayISO, normalizeDate, normalizeTime } from "./_utils/datetime.ts";
import { hasScheduleForDate, getWindowsForDate } from "./_utils/hours.ts";
import { photoStrings } from "./_utils/misc.ts";

export async function autocomplete(ctx: any) {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  const out = items.map(r => ({ ...r, photos: photoStrings(r.photos) }));
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(out, null, 2);
}

export async function view(ctx: any) {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

  const rawDate = ctx.request.url.searchParams.get("date") ?? "";
  const rawTime = ctx.request.url.searchParams.get("time") ?? "";
  const date = normalizeDate(rawDate) || todayISO();
  const time = normalizeTime(rawTime);
  const people = Number(ctx.request.url.searchParams.get("people") ?? "2") || 2;

  const hasDay = hasScheduleForDate(restaurant.weeklySchedule as WeeklySchedule, date);
  const windows = getWindowsForDate(restaurant.weeklySchedule as WeeklySchedule, date);
  const openingWindows = hasDay ? windows : [{ open: "00:00", close: "23:59" }];

  const slotIntervalMinutes = (restaurant as any).slotIntervalMinutes ?? 15;
  const serviceDurationMinutes = (restaurant as any).serviceDurationMinutes ?? 120;

  debugLog("[restaurants][GET /restaurants/:id] view", {
    id, date, rawTime, time, people,
    hasWeekly: !!restaurant.weeklySchedule,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : [],
    openingWindows
  });

  const photos = photoStrings(restaurant.photos);
  const restaurantForView = {
    ...restaurant,
    photos,
    weeklySchedule: (restaurant as any).weeklySchedule ?? null,
    openingHours: (restaurant as any).weeklySchedule ?? (restaurant as any).openingHours ?? null,
    hours:         (restaurant as any).weeklySchedule ?? (restaurant as any).hours ?? null,
    open_hours:    (restaurant as any).weeklySchedule ?? (restaurant as any).open_hours ?? null,
    slotIntervalMinutes,
    serviceDurationMinutes,
  };

  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant: restaurantForView,
    openingWindows,
    slotIntervalMinutes,
    serviceDurationMinutes,
    conflict: ctx.request.url.searchParams.get("conflict") === "1",
    suggestions: (ctx.request.url.searchParams.get("suggest") ?? "").split(",").filter(Boolean),
    date,
    time,
    people,
  });
}
