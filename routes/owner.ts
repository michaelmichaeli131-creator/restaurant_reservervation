// src/routes/owner.ts
import { Router } from "jsr:@oak/oak";
import { kv, createRestaurant, listReservationsByOwner } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

export const ownerRouter = new Router();

// דשבורד בעלי מסעדה: רשימת המסעדות + הזמנות אחרונות
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

// יצירת מסעדה חדשה (כולל קיבולת/סלוט/משך)
ownerRouter.post("/owner/restaurant/new", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const form = await ctx.request.body.form(); // Oak v17
  const id = crypto.randomUUID();

  const capacity = Number(form.get("capacity") ?? "30");
  const slotIntervalMinutes = Number(form.get("slotIntervalMinutes") ?? "15");
  const serviceDurationMinutes = Number(form.get("serviceDurationMinutes") ?? "120");

  const obj = {
    id,
    ownerId: (ctx.state as any).user.id,
    name: form.get("name")?.toString() ?? "New Restaurant",
    city: form.get("city")?.toString() ?? "",
    address: form.get("address")?.toString() ?? "",
    phone: form.get("phone")?.toString() ?? "",
    hours: form.get("hours")?.toString() ?? "",
    description: form.get("description")?.toString() ?? "",
    menu: [],
    capacity,
    slotIntervalMinutes,
    serviceDurationMinutes,
  };

  await createRestaurant(obj as any);
  ctx.response.redirect("/owner");
});
