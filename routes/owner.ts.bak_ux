// src/routes/owner.ts
import { Router } from "jsr:@oak/oak";
import {
  kv,
  createRestaurant,
  getRestaurant,
  updateRestaurant,
  listReservationsByOwner,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

export const ownerRouter = new Router();

ownerRouter.get("/owner", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const myRestaurants: any[] = [];
  const ownerId = (ctx.state as any).user.id;

  for await (const key of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = key.key[key.key.length - 1] as string;
    const r = await getRestaurant(rid);
    if (r) myRestaurants.push(r);
  }

  const reservations = await listReservationsByOwner(ownerId);

  await render(ctx, "owner_dashboard", {
    restaurants: myRestaurants,
    reservations,
    title: "אזור מנהלים",
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
