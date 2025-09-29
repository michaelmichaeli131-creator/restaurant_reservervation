// src/routes/owner.ts
import { Router } from "jsr:@oak/oak";
import { kv, createRestaurant, listReservationsByOwner, getRestaurant, createReservation, computeOccupancy } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

export const ownerRouter = new Router();

ownerRouter.get("/owner", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const myRestaurants: any[] = [];
  const ownerId = (ctx.state as any).user.id;

  for await (const key of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = key.key[key.key.length - 1] as string;
    const r = (await kv.get(["restaurant", rid])).value;
    if (r) myRestaurants.push(r);
  }

  const reservations = await listReservationsByOwner(ownerId);

  await render(ctx, "owner_dashboard", {
    myRestaurants,
    reservations,
    page: "owner",
    title: "אזור מנהלים",
  });
});

// תצוגת תפוסה למסעדה מסוימת (רק בעלים)
ownerRouter.get("/owner/restaurants/:id", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  const ownerId = (ctx.state as any).user.id;
  if (!r || r.ownerId !== ownerId) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }
  const date = ctx.request.url.searchParams.get("date") ?? new Date().toISOString().slice(0,10);
  const loads = await computeOccupancy(r, date);
  await render(ctx, "owner_restaurant_capacity", { r, date, loads, title: r.name + " — תפוסה" });
});

// חסימה ידנית של שולחנות
ownerRouter.post("/owner/restaurants/:id/block", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  const ownerId = (ctx.state as any).user.id;
  if (!r || r.ownerId !== ownerId) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }

  const form = await ctx.request.body.form();
  const date = (form.get("date") ?? "").toString();
  const time = (form.get("time") ?? "").toString();
  const people = Number((form.get("people") ?? "1").toString());
  const note = (form.get("note") ?? "חסימה ידנית").toString();

  await createReservation({
    id: crypto.randomUUID(),
    restaurantId: r.id,
    userId: `manual-block:${ownerId}`,
    date, time, people, note,
    status: "blocked",
    createdAt: Date.now(),
  });

  ctx.response.redirect(`/owner/restaurants/${r.id}?date=${encodeURIComponent(date)}`);
});

// יצירת מסעדה חדשה + קיבולת/סלוט/משך (מאושרת רק ע"י אדמין)
ownerRouter.post("/owner/restaurant/new", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const form = await ctx.request.body.form();
  const id = crypto.randomUUID();

  await createRestaurant({
    id,
    ownerId: (ctx.state as any).user.id,
    name: form.get("name")?.toString() ?? "New Restaurant",
    city: form.get("city")?.toString() ?? "",
    address: form.get("address")?.toString() ?? "",
    phone: form.get("phone")?.toString() ?? "",
    hours: form.get("hours")?.toString() ?? "",
    description: form.get("description")?.toString() ?? "",
    menu: [],
    capacity: Number(form.get("capacity") ?? "30"),
    slotIntervalMinutes: Number(form.get("slotIntervalMinutes") ?? "15"),
    serviceDurationMinutes: Number(form.get("serviceDurationMinutes") ?? "120"),
    approved: false,
  });

  ctx.response.redirect("/owner");
});
