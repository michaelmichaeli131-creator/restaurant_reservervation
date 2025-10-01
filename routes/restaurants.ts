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
  const m = s.match(/^(\d{2})[\/.](\d{2})[\/.](\d{4})$/); // 16/10/2025 או 16.10.2025
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}
function normalizeTime(input: unknown): string {
  const s = String(input ?? "").trim();
  if (!s) return nextQuarterHour();
  return /^\d{2}\.\d{2}$/.test(s) ? s.replace(".", ":") : s;
}
function toIntLoose(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return Math.trunc(input);
  if (typeof input === "bigint") return Number(input);
  if (typeof input === "boolean") return input ? 1 : 0;
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.trunc(Number(s));
  const onlyDigits = s.replace(/[^\d]/g, "");
  return onlyDigits ? Math.trunc(Number(onlyDigits)) : null;
}

// ---------- Body Reader (JSON / form / text / querystring) ----------
async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const ct = ctx.request.headers.get("content-type") ?? "";
  const reqAny: any = ctx.request as any;
  const native: Request | undefined = reqAny.originalRequest ?? undefined;

  const dbg: Record<string, unknown> = { ct, phases: [] as any[] };
  function logPhase(name: string, data: unknown) {
    try { (dbg.phases as any[]).push({ name, data }); } catch {}
  }

  const fromForm = (form: FormData | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    // @ts-ignore
    for (const [k, v] of form.entries()) o[k] = v;
    return o;
  };

  // 1) JSON
  if (ct.includes("application/json")) {
    if (typeof reqAny.body === "function") {
      try {
        const v = await reqAny.body({ type: "json" }).value;
        logPhase("oak.json", v);
        if (v && typeof v === "object") return { payload: v, dbg };
      } catch (e) { logPhase("oak.json.error", String(e)); }
    }
    if (native && (native as any).json) {
      try {
        const v = await (native as any).json();
        logPhase("native.json", v);
        if (v && typeof v === "object") return { payload: v, dbg };
      } catch (e) { logPhase("native.json.error", String(e)); }
    }
  }

  // 2) x-www-form-urlencoded / multipart
  if (ct.includes("application/x-www-form-urlencoded")) {
    if (typeof reqAny.body === "function") {
      try {
        const v = await reqAny.body({ type: "form" }).value;
        const o = fromForm(v as URLSearchParams);
        logPhase("oak.form", o);
        return { payload: o, dbg };
      } catch (e) { logPhase("oak.form.error", String(e)); }
    }
    if (native && (native as any).formData) {
      try {
        const fd = await (native as any).formData();
        const o = fromForm(fd);
        logPhase("native.formData", o);
        return { payload: o, dbg };
      } catch (e) { logPhase("native.formData.error", String(e)); }
    }
  } else if (ct.includes("multipart/form-data")) {
    if (typeof reqAny.body === "function") {
      try {
        const v = await reqAny.body({ type: "form-data" }).value;
        const o = fromForm(v as FormData);
        logPhase("oak.form-data", o);
        return { payload: o, dbg };
      } catch (e) { logPhase("oak.form-data.error", String(e)); }
    }
    if (native && (native as any).formData) {
      try {
        const fd = await (native as any).formData();
        const o = fromForm(fd);
        logPhase("native.formData", o);
        return { payload: o, dbg };
      } catch (e) { logPhase("native.formData.error", String(e)); }
    }
  }

  // 3) טקסט → נסה JSON
  if (typeof reqAny.body === "function") {
    try {
      const t = await reqAny.body({ type: "text" }).value;
      logPhase("oak.text", t);
      if (t) { try { const j = JSON.parse(t); logPhase("oak.text->json", j); return { payload: j, dbg }; } catch {} }
    } catch (e) { logPhase("oak.text.error", String(e)); }
  }
  if (native && (native as any).text) {
    try {
      const t = await (native as any).text();
      logPhase("native.text", t);
      if (t) { try { const j = JSON.parse(t); logPhase("native.text->json", j); return { payload: j, dbg }; } catch {} }
    } catch (e) { logPhase("native.text.error", String(e)); }
  }

  // 4) fallback: querystring
  const qs = Object.fromEntries(ctx.request.url.searchParams);
  logPhase("querystring", qs);
  return { payload: qs, dbg };
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
  const date = url.searchParams.get("date") ?? "";
  const time = url.searchParams.get("time") ?? "";
  const people = url.searchParams.get("people") ?? "";

  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant,
    conflict,
    suggestions,
    date, time, people,
  });
});

/** יצירת הזמנה */
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const reqId = String(ctx.state?.reqId ?? crypto.randomUUID().slice(0,8));
  if (!rid) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing restaurant id"; return; }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }
  const maxPeople = Math.max(1, Math.min(30, restaurant.capacity || 30));

  const { payload, dbg } = await readBody(ctx);

  // קח גם alias נפוצים, וגם headers (למקרה של פרוקסי/שכתוב)
  const date = normalizeDate((payload as any).date ?? ctx.request.url.searchParams.get("date"));
  const time = normalizeTime((payload as any).time ?? ctx.request.url.searchParams.get("time"));
  const peopleRaw =
    (payload as any).people ??
    (payload as any).guests ??
    (payload as any).num ??
    ctx.request.url.searchParams.get("people") ??
    ctx.request.headers.get("x-people");
  const people = toIntLoose(peopleRaw);

  console.log(`[RESV ${reqId}] /reserve rawBody`, dbg);
  console.log(`[RESV ${reqId}] /reserve input`, { rid, date, time, people, peopleRaw, maxPeople });

  const respondBad = (msg: string) => {
    console.warn(`[RESV ${reqId}] BAD: ${msg}`);
    const body = { ok: false, error: msg, debug: { rid, date, time, people, peopleRaw, dbg } };
    if (wantsJSON(ctx)) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.BadRequest;
      ctx.response.body = JSON.stringify(body, null, 2);
    } else {
      ctx.response.status = Status.BadRequest;
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.body = JSON.stringify(body, null, 2);
    }
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return respondBad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return respondBad("bad time (HH:mm expected)");
  if (people == null || people < 1 || people > maxPeople) return respondBad(`bad people (1..${maxPeople})`);

  const avail = await checkAvailability(rid, date, time, people);
  console.log(`[RESV ${reqId}] availability`, avail);

  if (!avail.ok) {
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    url.searchParams.set("reason", String((avail as any).reason));
    if ((avail as any).suggestions?.length) url.searchParams.set("suggest", (avail as any).suggestions.join(","));
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    url.searchParams.set("people", String(people));
    ctx.response.status = Status.SeeOther; // 303
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;
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

  // תמיד נחזיר JSON (גם ללא Accept), כדי שהלקוח יראה שגיאות/הצלחה מפורטות בזמן דיבוג
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, reservation }, null, 2);
});

/** API: בדיקת זמינות (AJAX) */
restaurantsRouter.post("/api/restaurants/:id/check", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const reqId = String(ctx.state?.reqId ?? crypto.randomUUID().slice(0,8));
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }
  const maxPeople = Math.max(1, Math.min(30, restaurant.capacity || 30));

  const { payload, dbg } = await readBody(ctx);
  const date = normalizeDate((payload as any).date ?? ctx.request.url.searchParams.get("date"));
  const time = normalizeTime((payload as any).time ?? ctx.request.url.searchParams.get("time"));
  const peopleRaw =
    (payload as any).people ??
    (payload as any).guests ??
    (payload as any).num ??
    ctx.request.url.searchParams.get("people") ??
    ctx.request.headers.get("x-people");
  const people = toIntLoose(peopleRaw);

  console.log(`[RESV ${reqId}] /check rawBody`, dbg);
  console.log(`[RESV ${reqId}] /check input`, { rid, date, time, people, peopleRaw, maxPeople });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ctx.response.status = Status.BadRequest; ctx.response.body = JSON.stringify({ ok:false, error:"bad date (YYYY-MM-DD expected)", dbg }, null, 2); return; }
  if (!/^\d{2}:\d{2}$/.test(time)) { ctx.response.status = Status.BadRequest; ctx.response.body = JSON.stringify({ ok:false, error:"bad time (HH:mm expected)", dbg }, null, 2); return; }
  if (people == null || people < 1 || people > maxPeople) { ctx.response.status = Status.BadRequest; ctx.response.body = JSON.stringify({ ok:false, error:`bad people (1..${maxPeople})`, dbg }, null, 2); return; }

  const result = await checkAvailability(rid, date, time, people);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(result, null, 2);
});
