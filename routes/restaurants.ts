// routes/restaurants.ts
import { Router } from "jsr:@oak/oak";
import { getRestaurant, createReservation, listRestaurants } from "../database.ts";
import { requireAuth } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

export const restaurantsRouter = new Router();

restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = ctx.params.id!;
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }
  await render(ctx, "restaurant_detail", { restaurant, page: "restaurant", title: restaurant.name });
});

restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  if (!requireAuth(ctx)) return;
  const id = ctx.params.id!;
  const form = await ctx.request.body.form(); // Oak v17
  const date = form.get("date")?.toString() ?? "";
  const time = form.get("time")?.toString() ?? "";
  const people = Number(form.get("people") ?? 2);
  const note = form.get("note")?.toString();

  const resv = {
    id: crypto.randomUUID(),
    restaurantId: id,
    userId: (ctx.state as any).user.id,
    date, time, people, note,
    createdAt: Date.now(),
  };
  await createReservation(resv as any);
  ctx.response.redirect(`/restaurants/${id}`);
});

// API להשלמות חיפוש
restaurantsRouter.get("/api/restaurants/search", async (ctx) => {
  const q = ctx.request.url.searchParams.get("query")?.toString() ?? "";
  const all = await listRestaurants(q);
  const items = all.slice(0, 10).map((r) => ({
    id: r.id, name: r.name, city: r.city, address: r.address,
  }));
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.headers.set("Cache-Control", "no-store");
  ctx.response.body = JSON.stringify({ items });
});
