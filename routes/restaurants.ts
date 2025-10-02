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
  const m = s.match(/^(\d{2})[\/.](\d{2})[\/.](\d{4})$/);
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
function politeAvailMessage(name: string, people: number, date: string, time: string) {
  return `יש זמינות ב־${name} עבור ${people} סועדים בתאריך ${date} בשעה ${time}.`;
}

// ---------- Body Reader (חסין: Oak body() → originalRequest → bytes) ----------
async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const ct = ctx.request.headers.get("content-type") ?? "";
  const reqAny: any = ctx.request as any;
  const original: Request | undefined = (reqAny.originalRequest ?? undefined);

  const dbg: Record<string, unknown> = { ct, phases: [] as any[] };
  const phase = (name: string, data: unknown) => {
    try { (dbg.phases as any[]).push({ name, data }); } catch {}
  };

  const fromForm = (form: FormData | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    // @ts-ignore
    for (const [k, v] of form.entries()) o[k] = v;
    return o;
  };

  // JSON
  if (ct.includes("application/json")) {
    try {
      if (typeof reqAny.body === "function") {
        const v = await reqAny.body({ type: "json" }).value;
        if (v && typeof v === "object") { phase("oak.json", v); return { payload: v, dbg }; }
        phase("oak.json.empty", v);
      } else {
        phase("oak.json.skip", "request.body is not a function");
      }
    } catch (e) { phase("oak.json.error", String(e)); }

    try {
      if (typeof reqAny.body === "function") {
        const b = await reqAny.body();
        if (b?.type === "json") {
          const v = await b.value;
          if (v && typeof v === "object") { phase("oak.generic.json", v); return { payload: v, dbg }; }
        } else if (b?.type === "bytes") {
          const u8: Uint8Array = await b.value;
          const text = new TextDecoder().decode(u8);
          phase("oak.bytes", text);
          try { const j = JSON.parse(text); phase("oak.bytes->json", j); return { payload: j, dbg }; } catch {}
        } else if (b?.type === "text") {
          const text: string = await b.value;
          phase("oak.text", text);
          try { const j = JSON.parse(text); phase("oak.text->json", j); return { payload: j, dbg }; } catch {}
        } else {
          phase("oak.generic", { type: b?.type });
        }
      }
    } catch (e) { phase("oak.generic.error", String(e)); }

    try {
      if (original && (original as any).json) {
        const v = await (original as any).json();
        if (v && typeof v === "object") { phase("native.json", v); return { payload: v, dbg }; }
        phase("native.json.empty", v);
      } else {
        phase("native.json.skip", "no originalRequest");
      }
    } catch (e) { phase("native.json.error", String(e)); }

    try {
      if (original && (original as any).text) {
        const text = await (original as any).text();
        phase("native.text", text);
        if (text) { try { const j = JSON.parse(text); phase("native.text->json", j); return { payload: j, dbg }; } catch {} }
      }
    } catch (e) { phase("native.text.error", String(e)); }
  }

  // x-www-form-urlencoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      if (typeof reqAny.body === "function") {
        const v = await reqAny.body({ type: "form" }).value;
        const o = fromForm(v as URLSearchParams);
        phase("oak.form", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("oak.form.error", String(e)); }
    try {
      if (original && (original as any).formData) {
        const fd = await (original as any).formData();
        const o = fromForm(fd);
        phase("native.formData(urlencoded)", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("native.formData.error", String(e)); }
  }

  // multipart/form-data
  if (ct.includes("multipart/form-data")) {
    try {
      if (typeof reqAny.body === "function") {
        const v = await reqAny.body({ type: "form-data" }).value;
        const o = fromForm(v as FormData);
        phase("oak.multipart", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("oak.multipart.error", String(e)); }
    try {
      if (original && (original as any).formData) {
        const fd = await (original as any).formData();
        const o = fromForm(fd);
        phase("native.formData(multipart)", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("native.formData(multipart).error", String(e)); }
  }

  // bytes/text fallback
  try {
    if (typeof reqAny.body === "function") {
      const b = await reqAny.body({ type: "bytes" }).value;
      if (b && (b as Uint8Array).byteLength > 0) {
        const text = new TextDecoder().decode(b as Uint8Array);
        phase("oak.bytes.fallback", text);
        try { const j = JSON.parse(text); phase("oak.bytes.fallback->json", j); return { payload: j, dbg }; } catch {}
      }
    }
  } catch (e) { phase("oak.bytes.fallback.error", String(e)); }

  try {
    if (original && (original as any).text) {
      const text = await (original as any).text();
      phase("native.text.fallback", text);
      if (text) { try { const j = JSON.parse(text); phase("native.text.fallback->json", j); return { payload: j, dbg }; } catch {} }
    }
  } catch (e) { phase("native.text.fallback.error", String(e)); }

  // querystring
  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  return { payload: qs, dbg };
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
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.BadRequest;
    ctx.response.body = JSON.stringify(body, null, 2);
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

  const message = `הזמנתך נשמרה בהצלחה ב־${restaurant.name} עבור ${people} סועדים לתאריך ${date} בשעה ${time}. נשמח לארח אותך!`;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, reservation, message }, null, 2);
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

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("bad time (HH:mm expected)");
  if (people == null || people < 1 || people > maxPeople) return bad(`bad people (1..${maxPeople})`);

  const result = await checkAvailability(rid, date, time, people);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");

  if (result.ok) {
    const message = politeAvailMessage(restaurant.name, people, date, time);
    ctx.response.body = JSON.stringify({ ok: true, message, details: { restaurantId: rid, date, time, people } }, null, 2);
  } else {
    ctx.response.body = JSON.stringify(result, null, 2);
  }
});
