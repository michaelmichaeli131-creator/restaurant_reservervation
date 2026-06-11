// src/routes/owner.ts
import { Router } from "jsr:@oak/oak";
import {
  kv,
  createRestaurant,
  getRestaurant,
  updateRestaurant,
  listReservationsByOwner,
  listReservationsFor,
  computeOccupancy,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { render } from "../lib/view.ts";
import { listItems as listPosMenuItems } from "../pos/pos_db.ts";

export const ownerRouter = new Router();

/**
 * Setup-progress steps for the owner onboarding checklist.
 * Heuristics mirror templates/owner_restaurant_manage.eta (setupChecks):
 * description / weeklySchedule / photos / menu / approved.
 */
function computeSetupStatus(r: any, menuCount: number) {
  const photos = Array.isArray(r?.photos) ? r.photos : [];
  const photoCount = photos.length;

  const weekly: any = r?.weeklySchedule ?? r?.openingHours ?? null;
  const hasOpenDay = !!weekly && Object.values(weekly).some((v: any) =>
    v != null && (Array.isArray(v) ? v.length > 0 : true)
  );

  const hasDescription = !!String(r?.description || "").trim();
  const approved = r?.approved === true;

  const steps = [
    {
      key: "profile",
      done: true, // restaurant exists
      needsDescription: !hasDescription,
      href: `/owner/restaurants/${r.id}/edit`,
    },
    {
      key: "hours",
      done: hasOpenDay,
      href: `/owner/restaurants/${r.id}/hours`,
    },
    {
      key: "photos",
      done: photoCount >= 1,
      fewPhotos: photoCount >= 1 && photoCount < 3,
      href: `/owner/restaurants/${r.id}/photos`,
    },
    {
      key: "menu",
      done: menuCount >= 1,
      href: `/owner/${r.id}/menu`,
    },
    {
      key: "approval",
      done: approved,
      waiting: !approved && hasOpenDay && photoCount >= 1 && menuCount >= 1,
      href: null, // no action — admin approval
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

ownerRouter.get("/owner", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const ownerId = (ctx.state as any).user.id;
  const date = ctx.request.url.searchParams.get("date") || todayISO();
  const myRestaurants: any[] = [];

  for await (const key of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = key.key[key.key.length - 1] as string;
    const r = await getRestaurant(rid);
    if (!r) continue;

    const reservations = await listReservationsFor(r.id, date);
    const peopleToday = reservations.reduce((acc, x) => acc + Number(x.people || 0), 0);
    const occMap = await computeOccupancy(r, date);
    let peakUsed = 0;
    for (const used of occMap.values()) peakUsed = Math.max(peakUsed, Number(used || 0));

    const capacity = Math.max(1, Number(r.capacity || 0));
    const peakPct = Math.min(100, Math.round((peakUsed / capacity) * 100));

    const photos = Array.isArray(r.photos) ? r.photos : [];
    const normPhotos = photos.map((p: any) => (typeof p === "string" ? { dataUrl: p, alt: "" } : p));

    // Menu items can live on the restaurant record (legacy) or in the POS menu store.
    let posMenuCount = 0;
    try {
      posMenuCount = (await listPosMenuItems(r.id)).length;
    } catch {
      posMenuCount = 0;
    }
    const menuCount = (Array.isArray(r.menu) ? r.menu.length : 0) + posMenuCount;

    myRestaurants.push({
      ...r,
      photos: normPhotos,
      _setup: computeSetupStatus(r, menuCount),
      _today: date,
      _reservationsCount: reservations.length,
      _peopleToday: peopleToday,
      _peakOccupancyPct: peakPct,
      _calendarUrl: `/owner/restaurants/${r.id}/calendar?date=${encodeURIComponent(date)}`,
      _manageUrl: `/owner/restaurants/${r.id}/manage?date=${encodeURIComponent(date)}`,
    });
  }

  myRestaurants.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  const reservations = await listReservationsByOwner(ownerId);

  await render(ctx, "owner_dashboard", {
    restaurants: myRestaurants,
    reservations,
    title: "Owner Dashboard",
    page: "owner_dashboard",
  });
});

ownerRouter.post("/owner/restaurant/new", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const ownerId = (ctx.state as any).user.id;
  const form = await ctx.request.body.formData();

  const photosField = (form.get("photos")?.toString() ?? "").trim();
  const photos = photosField
    ? photosField.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean)
    : [];

  await createRestaurant({
    id: crypto.randomUUID(),
    ownerId,
    name: form.get("name")?.toString() ?? "",
    city: form.get("city")?.toString() ?? "",
    address: form.get("address")?.toString() ?? "",
    phone: form.get("phone")?.toString() ?? "",
    hours: form.get("hours")?.toString() ?? "",
    description: form.get("description")?.toString() ?? "",
    photos,
    menu: [],
    capacity: Number(form.get("capacity") ?? "30"),
    slotIntervalMinutes: Number(form.get("slotIntervalMinutes") ?? "15"),
    serviceDurationMinutes: Number(form.get("serviceDurationMinutes") ?? "120"),
    approved: false,
  });

  ctx.response.redirect("/owner");
});

ownerRouter.post("/owner/restaurant/:id/updatePhotos", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.id!;
  const form = await ctx.request.body.formData();
  const photosField = (form.get("photos")?.toString() ?? "").trim();
  const photos = photosField
    ? photosField.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean)
    : [];
  await updateRestaurant(rid, { photos });
  ctx.response.redirect("/owner");
});
