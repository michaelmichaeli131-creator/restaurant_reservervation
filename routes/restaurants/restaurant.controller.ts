// src/routes/restaurants/restaurant.controller.ts
import { Status } from "jsr:@oak/oak";
import { listRestaurants, getRestaurant, isFavorite, type WeeklySchedule } from "../../database.ts";
import { listFloorLayouts } from "../../services/floor_service.ts";
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

  // Load floor layouts for room selection dropdown (all rooms, not just active)
  const allLayouts = await listFloorLayouts(id).catch(() => []);
  const deriveRoomCapacity = (layout: any) => {
    const explicitCapacity = Number(layout?.capacity);
    if (Number.isFinite(explicitCapacity) && explicitCapacity > 0) return explicitCapacity;
    const tables = Array.isArray(layout?.tables) ? layout.tables : [];
    const seats = tables.reduce((sum: number, table: any) => {
      const value = Number(table?.seats);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
    return seats > 0 ? seats : null;
  };

  const rooms = allLayouts
    .map((l: any) => ({ id: l.id, label: l.floorLabel || l.name, capacity: deriveRoomCapacity(l) }));

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

  const viewer = (ctx.state as any)?.user ?? null;
  const isFav = viewer ? await isFavorite(viewer.id, id).catch(() => false) : false;

  // SEO: schema.org Restaurant structured data + social sharing meta
  const pageUrl = `${ctx.request.url.protocol}//${ctx.request.url.host}/restaurants/${restaurant.id}`;
  const structuredData: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: restaurant.name,
    url: pageUrl,
    address: {
      "@type": "PostalAddress",
      addressLocality: restaurant.city || undefined,
      streetAddress: (restaurant as any).address || undefined,
    },
    telephone: (restaurant as any).phone || undefined,
    servesCuisine: (restaurant as any).kitchenCategories || undefined,
    image: photos[0] && !photos[0].startsWith("data:") ? photos[0] : undefined,
    acceptsReservations: "True",
  };
  const avgRating = Number((restaurant as any).averageRating);
  const reviewCount = Number((restaurant as any).reviewCount);
  if (Number.isFinite(avgRating) && avgRating > 0 && reviewCount > 0) {
    structuredData.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: avgRating.toFixed(1),
      reviewCount,
    };
  }

  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — SpotBook`,
    metaDescription: ((restaurant as any).description || "").slice(0, 160) ||
      `Book a table at ${restaurant.name}${restaurant.city ? ` in ${restaurant.city}` : ""} — instant online reservation on SpotBook.`,
    canonicalUrl: pageUrl,
    ogImage: photos[0] && !photos[0].startsWith("data:") ? photos[0] : undefined,
    structuredData,
    restaurant: restaurantForView,
    openingWindows,
    slotIntervalMinutes,
    serviceDurationMinutes,
    conflict: ctx.request.url.searchParams.get("conflict") === "1",
    roomFull: ctx.request.url.searchParams.get("room_full") ?? "",
    suggestions: (ctx.request.url.searchParams.get("suggest") ?? "").split(",").filter(Boolean),
    date,
    time,
    people,
    rooms,
    preferredLayoutId: ctx.request.url.searchParams.get("preferredLayoutId") ?? "",
    isFav,
  });
}
