// src/routes/restaurants.ts
import { Router } from "jsr:@oak/oak";
import {
  getRestaurant,
  listRestaurants,
  createReservation,
  computeOccupancy,
  checkAvailability,
} from "../database.ts";
import { render } from "../lib/view.ts";

export const restaurantsRouter = new Router();

// רשימת מסעדות (כבר משמשת בעמוד הבית)
restaurantsRouter.get("/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const data = await listRestaurants(q);
  ctx.response.type = "json";
  ctx.response.body = JSON.stringify(data);
});

// דף מסעדה
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }

  const date = ctx.request.url.searchParams.get("date") ?? new Date().toISOString().slice(0,10);
  const loads = await computeOccupancy(r, date);

  await render(ctx, "restaurant_detail", {
    r, date, loads,
    title: r.name + " — פרטים וזמינות",
  });
});

// API זמינות יומית (ל־AJAX/Autocomplete וכו')
restaurantsRouter.get("/api/restaurants/:id/availability", async (ctx) => {
  const id = ctx.params.id!;
  const date = ctx.request.url.searchParams.get("date") ?? new Date().toISOString().slice(0,10);
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }
  const loads = await computeOccupancy(r, date);
  ctx.response.type = "json";
  ctx.response.body = JSON.stringify({ date, loads, capacity: r.capacity, slotInterval: r.slotIntervalMinutes, serviceDuration: r.serviceDurationMinutes });
});

// הזמנה — עם ולידציית קיבולת והצעות חלופיות
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }

  const form = await ctx.request.body.form(); // Oak v17
  const date = (form.get("date") ?? "").toString();
  const time = (form.get("time") ?? "").toString();
  const people = Number(form.get("people") ?? "1");
  const note = (form.get("note") ?? "").toString();

  const userId = (ctx.state as any)?.user?.id ?? "guest-" + crypto.randomUUID().slice(0,6);

  // בדיקת זמינות
  const avail = await checkAvailability(r, date, time, people);
  if (!avail.ok) {
    // החזר עמוד עם הודעה והצעות
    await render(ctx, "restaurant_detail", {
      r, date,
      error: avail.reason === "full"
        ? "המסעדה מלאה בשעה שביקשת."
        : avail.reason === "closed"
          ? "המסעדה סגורה/סלוט לא חוקי."
          : "בקשה לא תקינה.",
      suggestions: avail.suggestions ?? [],
      loads: await computeOccupancy(r, date),
      title: r.name + " — אין מקום",
    });
    return;
  }

  const resv = await createReservation({
    id: crypto.randomUUID(),
    restaurantId: r.id,
    userId,
    date, time, people, note,
    status: "new",
    createdAt: Date.now(),
  });

  // נחזיר לדף המסעדה עם הודעת הצלחה
  await render(ctx, "restaurant_detail", {
    r, date,
    success: "הזמנה נשמרה בהצלחה",
    loads: await computeOccupancy(r, date),
    title: r.name + " — הזמנה נשמרה",
  });
});
