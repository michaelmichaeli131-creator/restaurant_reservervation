// routes/restaurants.ts
import { Router } from "@oak/oak";
import { getRestaurant, createReservation, listRestaurants } from "../database.ts";
import { requireAuth } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

export const restaurantsRouter = new Router();

// דף מסעדה
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = ctx.params.id!;
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }
  await render(ctx, "restaurant_detail", { restaurant });
});

// הזמנה
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  if (!requireAuth(ctx)) return;
  const id = ctx.params.id!;
  const body = await ctx.request.body({ type: "form" }).value;
  const date = body.get("date")?.toString() ?? "";
  const time = body.get("time")?.toString() ?? "";
  const people = Number(body.get("people") ?? 2);
  const note = body.get("note")?.toString();

  const resv = {
    id: crypto.randomUUID(),
    restaurantId: id,
    userId: ctx.state.user.id,
    date, time, people, note,
    createdAt: Date.now(),
  };
  await createReservation(resv as any);
  ctx.response.redirect(`/restaurants/${id}`);
});

// --- API: חיפוש JSON להשלמות ---
restaurantsRouter.get("/api/restaurants/search", async (ctx) => {
  const q = ctx.request.url.searchParams.get("query")?.toString() ?? "";
  const all = await listRestaurants(q);
  const items = all.slice(0, 10).map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    address: r.address,
  }));
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ items });
});
