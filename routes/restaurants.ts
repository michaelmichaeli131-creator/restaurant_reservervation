// src/routes/restaurants.ts
import { Router } from "jsr:@oak/oak";
import {
  getRestaurant,
  listRestaurants,
  createReservation,
  checkAvailability,
} from "../database.ts";
import { render } from "../lib/view.ts";

export const restaurantsRouter = new Router();

// הצעות אוטוקומפליט
restaurantsRouter.get("/api/restaurants/suggest", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const items = await listRestaurants(q, true);
  ctx.response.type = "json";
  ctx.response.body = JSON.stringify(items.slice(0, 8).map(r => ({ id: r.id, name: r.name, city: r.city })));
});

// רשימת מסעדות – JSON (לשימוש עתידי)
restaurantsRouter.get("/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const data = await listRestaurants(q, true);
  ctx.response.type = "json";
  ctx.response.body = JSON.stringify(data);
});

// דף מסעדה ללקוח — בלי טבלת תפוסה; יש טופס עם "בדוק זמינות"
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || !r.approved) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }

  const date = ctx.request.url.searchParams.get("date") ?? new Date().toISOString().slice(0,10);
  await render(ctx, "restaurant_detail", {
    r, date,
    title: r.name + " — הזמנה",
  });
});

// API בדיקת זמינות (לקוח לוחץ לפני הזמנה)
restaurantsRouter.get("/api/restaurants/:id/check", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || !r.approved) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }

  const date = ctx.request.url.searchParams.get("date") ?? "";
  const time = ctx.request.url.searchParams.get("time") ?? "";
  const people = Number(ctx.request.url.searchParams.get("people") ?? "1");

  const result = await checkAvailability(r, date, time, people);
  ctx.response.type = "json";
  ctx.response.body = JSON.stringify(result);
});

// יצירת הזמנה — לאחר בדיקת זמינות
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || !r.approved) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }

  const form = await ctx.request.body.form();
  const date = (form.get("date") ?? "").toString();
  const time = (form.get("time") ?? "").toString();
  const people = Number((form.get("people") ?? "1").toString());
  const note = (form.get("note") ?? "").toString();
  const userId = (ctx.state as any)?.user?.id ?? "guest-" + crypto.randomUUID().slice(0,6);

  const avail = await checkAvailability(r, date, time, people);
  if (!avail.ok) {
    await render(ctx, "restaurant_detail", {
      r, date,
      error: avail.reason === "full" ? "המסעדה מלאה בשעה הנבחרת" :
             avail.reason === "closed" ? "סלוט לא זמין" : "בקשה לא תקינה",
      suggestions: avail.suggestions ?? [],
      title: r.name + " — אין מקום",
    });
    return;
  }

  await createReservation({
    id: crypto.randomUUID(),
    restaurantId: r.id,
    userId,
    date, time, people, note,
    status: "new",
    createdAt: Date.now(),
  });

  await render(ctx, "restaurant_detail", {
    r, date,
    success: "הזמנה נשמרה בהצלחה",
    title: r.name + " — הזמנה נשמרה",
  });
});
