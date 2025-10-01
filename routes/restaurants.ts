// src/routes/restaurants.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  checkAvailability,
  createReservation,
  type Reservation,
} from "../database.ts";
import { render } from "../lib/view.ts";

// ---------- Body Reader (robust across Oak versions) ----------
async function readBody(ctx: any): Promise<Record<string, unknown>> {
  const ct = ctx.request.headers.get("content-type") ?? "";
  const reqAny: any = ctx.request as any;
  const native: Request | undefined = reqAny.originalRequest ?? undefined;

  // helpers
  const toObjFromForm = (form: FormData) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) o[k] = v;
    return o;
  };

  // Try Oak body() first (older API)
  const hasOakBodyFn = typeof reqAny.body === "function";

  // JSON
  if (ct.includes("application/json")) {
    if (hasOakBodyFn) {
      try {
        const v = await reqAny.body({ type: "json" }).value;
        if (v && typeof v === "object") return v as Record<string, unknown>;
      } catch { /* fallthrough */ }
    }
    if (native && typeof (native as any).json === "function") {
      try {
        const v = await (native as any).json();
        if (v && typeof v === "object") return v as Record<string, unknown>;
      } catch { /* fallthrough */ }
    }
    // last resort: text()->JSON.parse
    try {
      const txt = native && typeof (native as any).text === "function"
        ? await (native as any).text()
        : "";
      return txt ? JSON.parse(txt) : {};
    } catch {
      return {};
    }
  }

  // Form URL Encoded / Multipart
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    if (hasOakBodyFn) {
      try {
        const form = await reqAny.body({ type: "form" }).value;
        return toObjFromForm(form);
      } catch { /* fallthrough */ }
    }
    if (native && typeof (native as any).formData === "function") {
      try {
        const fd = await (native as any).formData();
        return toObjFromForm(fd);
      } catch { /* fallthrough */ }
    }
  }

  // Fallback: try Oak "text", else native text
  if (hasOakBodyFn) {
    try {
      const txt = await reqAny.body({ type: "text" }).value;
      if (!txt) return {};
      try { return JSON.parse(txt); } catch { return {}; }
    } catch { /* fallthrough */ }
  }
  if (native && typeof (native as any).text === "function") {
    try {
      const txt = await (native as any).text();
      if (!txt) return {};
      try { return JSON.parse(txt); } catch { return {}; }
    } catch { /* ignore */ }
  }
  return {};
}

// ---------- Response helper ----------
function wantsJSON(ctx: any) {
  const acc = ctx.request.headers.get("accept") ?? "";
  return acc.includes("application/json");
}

export const restaurantsRouter = new Router();

/** API: חיפוש לאוטוקומפליט
 * GET /api/restaurants?q=tel
 */
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(items, null, 2);
});

/** דף מסעדה
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
  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant,
  });
});

/** יצירת הזמנה
 * POST /restaurants/:id/reserve
 * body: { date: YYYY-MM-DD, time: HH:mm, people: number, note?: string }
 */
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
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

  // משתמש מחובר (אם קיים ב-session)
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;

  // בדיקת זמינות
  const avail = await checkAvailability(rid, date, time, people);
  if (!avail.ok) {
    const payload = { ok: false, reason: (avail as any).reason, suggestions: (avail as any).suggestions ?? [] };
    if (wantsJSON(ctx)) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify(payload, null, 2);
      return;
    }
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    url.searchParams.set("reason", String((avail as any).reason));
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

/** API: בדיקת זמינות
 * POST /api/restaurants/:id/check
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
