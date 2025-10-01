// src/routes/restaurants.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  checkAvailability,
  createReservation,
  type Restaurant,
  type Reservation,
} from "../database.ts";
import { render } from "../lib/view.ts";

// עזר לפענוח body כ-JSON או form-urlencoded
async function readBody(ctx: any): Promise<Record<string, unknown>> {
  const ct = ctx.request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await ctx.request.body({ type: "json" }).value;
    } catch {
      return {};
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await ctx.request.body({ type: "form" }).value;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    return obj;
  }
  // raw/text
  try {
    const txt = await ctx.request.body({ type: "text" }).value;
    return txt ? JSON.parse(txt) : {};
  } catch {
    return {};
  }
}

// עזר להשבת JSON/HTML לפי Accept
function wantsJSON(ctx: any) {
  const acc = ctx.request.headers.get("accept") ?? "";
  return acc.includes("application/json");
}

export const restaurantsRouter = new Router();

/**
 * GET /api/restaurants?q=tel
 */
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(items, null, 2);
});

/**
 * GET /restaurants/:id
 */
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  // רינדור תבנית (יש קובץ restaurant.eta)
  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant,
  });
});

/**
 * POST /restaurants/:id/reserve
 * fields: date (YYYY-MM-DD), time (HH:mm), people (number), note? (string)
 */
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? ""); // מזהה תמיד מהנתיב
  if (!rid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing restaurant id";
    return;
  }

  const body = await readBody(ctx);
  const date = String(body.date ?? "");
  const time = String(body.time ?? "");
  const peopleRaw = body.people;
  const note = typeof body.note === "string" ? body.note.trim() : undefined;

  const people = typeof peopleRaw === "number"
    ? Math.trunc(peopleRaw)
    : Number(String(peopleRaw ?? ""));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "bad date (YYYY-MM-DD expected)";
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "bad time (HH:mm expected)";
    return;
  }
  if (!Number.isFinite(people) || people <= 0 || people > 30) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "bad people (1..30)";
    return;
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "restaurant not found";
    return;
  }

  // משתמש מחובר (אם יש)
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;

  // בדיקת זמינות
  const avail = await checkAvailability(rid, date, time, people);
  if (!avail.ok) {
    const payload = { ok: false, reason: avail.reason, suggestions: (avail as any).suggestions ?? [] };
    if (wantsJSON(ctx)) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify(payload, null, 2);
      return;
    }
    // redirect חזרה לעמוד המסעדה עם פרמטרים שמאותתים על הקונפליקט
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    url.searchParams.set("reason", String(avail.reason));
    if ((avail as any).suggestions?.length) url.searchParams.set("suggest", (avail as any).suggestions.join(","));
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  // יצירת הזמנה
  const reservation: Reservation = {
    id: crypto.randomUUID(),
    restaurantId: rid,
    userId,
    date,
    time,
    people,
    note,
    status: "new",
    createdAt: Date.now(),
  };
  await createReservation(reservation);

  if (wantsJSON(ctx)) {
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, reservation }, null, 2);
    return;
  }

  // redirect אחרי הצלחה
  const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
  url.searchParams.set("ok", "1");
  url.searchParams.set("date", date);
  url.searchParams.set("time", time);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", url.pathname + url.search);
});

/**
 * POST /api/restaurants/:id/check
 * body: { date, time, people }
 */
restaurantsRouter.post("/api/restaurants/:id/check", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const body = await readBody(ctx);
  const date = String(body.date ?? "");
  const time = String(body.time ?? "");
  const people = Number(String(body.people ?? ""));
  const result = await checkAvailability(rid, date, time, people);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(result, null, 2);
});
