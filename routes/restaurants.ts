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

// ---------- Utils ----------
function pad2(n: number) { return n.toString().padStart(2, "0"); }
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function nextQuarterHour(): string {
  const d = new Date();
  const mins = d.getMinutes();
  const add = 15 - (mins % 15 || 15);
  d.setMinutes(mins + add, 0, 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function normalizeDate(input: unknown): string {
  const s = String(input ?? "").trim();
  if (!s) return todayISO();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}
function normalizeTime(input: unknown): string {
  const s = String(input ?? "").trim();
  if (!s) return nextQuarterHour();
  return /^\d{2}\.\d{2}$/.test(s) ? s.replace(".", ":") : s;
}
function toInt(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return Math.trunc(input);
  const s = String(input ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return Math.trunc(n);
  const onlyDigits = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(onlyDigits) ? Math.trunc(onlyDigits) : null;
}

// ---------- Body Reader (חסין: JSON / form / querystring) ----------
async function readBody(ctx: any): Promise<Record<string, unknown>> {
  const ct = ctx.request.headers.get("content-type") ?? "";
  const reqAny: any = ctx.request as any;
  const native: Request | undefined = reqAny.originalRequest ?? undefined;

  const fromForm = (form: FormData | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    // @ts-ignore
    for (const [k, v] of form.entries()) o[k] = v;
    return o;
  };

  // 1) JSON
  if (ct.includes("application/json")) {
    if (typeof reqAny.body === "function") {
      try { const v = await reqAny.body({ type: "json" }).value; if (v && typeof v === "object") return v; } catch {}
    }
    if (native && (native as any).json) {
      try { const v = await (native as any).json(); if (v && typeof v === "object") return v; } catch {}
    }
  }

  // 2) x-www-form-urlencoded / multipart
  if (ct.includes("application/x-www-form-urlencoded")) {
    if (typeof reqAny.body === "function") {
      try { const v = await reqAny.body({ type: "form" }).value; return fromForm(v as URLSearchParams); } catch {}
    }
    if (native && (native as any).formData) {
      try { const fd = await (native as any).formData(); return fromForm(fd); } catch {}
    }
  } else if (ct.includes("multipart/form-data")) {
    if (typeof reqAny.body === "function") {
      try { const v = await reqAny.body({ type: "form-data" }).value; return fromForm(v as FormData); } catch {}
    }
    if (native && (native as any).formData) {
      try { const fd = await (native as any).formData(); return fromForm(fd); } catch {}
    }
  }

  // 3) טקסט → נסה JSON
  if (typeof reqAny.body === "function") {
    try { const t = await reqAny.body({ type: "text" }).value; return t ? JSON.parse(t) : {}; } catch {}
  }
  if (native && (native as any).text) {
    try { const t = await (native as any).text(); return t ? JSON.parse(t) : {}; } catch {}
  }

  // 4) fallback: querystring
  const qs = Object.fromEntries(ctx.request.url.searchParams);
  return qs;
}

function wantsJSON(ctx: any) {
  const acc = ctx.request.headers.get("accept") ?? "";
  return acc.includes("application/json");
}

export const restaurantsRouter = new Router();

/** API: חיפוש לאוטוקומפליט */
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(items, null, 2);
});

/** דף מסעדה */
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

  const url = ctx.request.url;
  const conflict = url.searchParams.get("conflict") === "1";
  const suggestions = (url.searchParams.get("suggest") ?? "").split(",").filter(Boolean);

  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant,
    conflict,
    suggestions,
  });
});

/** יצירת הזמנה */
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  if (!rid) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing restaurant id"; return; }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }
  const maxPeople = Math.max(1, Math.min(30, restaurant.capacity || 30));

  const body = await readBody(ctx);
  const date = normalizeDate((body as any).date);
  const time = normalizeTime((body as any).time);
  // קבל גם guests/num כ-alias אם יגיעו מטופס ישן
  const people = toInt((body as any).people ?? (body as any).guests ?? (body as any).num);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ctx.response.status = Status.BadRequest; ctx.response.body = "bad date (YYYY-MM-DD expected)"; return; }
  if (!/^\d{2}:\d{2}$/.test(time)) { ctx.response.status = Status.BadRequest; ctx.response.body = "bad time (HH:mm expected)"; return; }
  if (people == null || people < 1 || people > maxPeople) { ctx.response.status = Status.BadRequest; ctx.response.body = `bad people (1..${maxPeople})`; return; }

  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;

  const avail = await checkAvailability(rid, date, time, people);
  if (!avail.ok) {
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    url.searchParams.set("reason", String((avail as any).reason));
    if ((avail as any).suggestions?.length) url.searchParams.set("suggest", (avail as any).suggestions.join(","));
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  const reservation: Reservation = {
    id: crypto.randomUUID(),
    restaurantId: rid,
    userId,
    date,
    time,
    people,
    status: "new",
    createdAt: Date.now(),
  };
  await createReservation(reservation);

  if (wantsJSON(ctx)) {
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, reservation }, null, 2);
    return;
  }

  const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
  url.searchParams.set("ok", "1");
  url.searchParams.set("date", date);
  url.searchParams.set("time", time);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", url.pathname + url.search);
});

/** API: בדיקת זמינות (AJAX) */
restaurantsRouter.post("/api/restaurants/:id/check", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }
  const maxPeople = Math.max(1, Math.min(30, restaurant.capacity || 30));

  const body = await readBody(ctx);
  const date = normalizeDate((body as any).date);
  const time = normalizeTime((body as any).time);
  const people = toInt((body as any).people ?? (body as any).guests ?? (body as any).num);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ctx.response.status = Status.BadRequest; ctx.response.body = "bad date (YYYY-MM-DD expected)"; return; }
  if (!/^\d{2}:\d{2}$/.test(time)) { ctx.response.status = Status.BadRequest; ctx.response.body = "bad time (HH:mm expected)"; return; }
  if (people == null || people < 1 || people > maxPeople) { ctx.response.status = Status.BadRequest; ctx.response.body = `bad people (1..${maxPeople})`; return; }

  const result = await checkAvailability(rid, date, time, people);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(result, null, 2);
});
