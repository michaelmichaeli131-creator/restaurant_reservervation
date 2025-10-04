// src/routes/restaurants.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  checkAvailability,
  listAvailableSlotsAround,
  createReservation,
  getUserById,
  type Reservation,
} from "../database.ts";
import { render } from "../lib/view.ts";
import { sendReservationEmail, notifyOwnerEmail } from "../lib/mail.ts";
import { debugLog } from "../lib/debug.ts";

// ---------------- Utilities ----------------
function pad2(n: number) { return n.toString().padStart(2, "0"); }
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function normalizeDate(input: unknown): string {
  let s = String(input ?? "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/);
  if (iso) return iso[1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (dmy) {
    const dd = pad2(+dmy[1]);
    const mm = pad2(+dmy[2]);
    const yyyy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return s;
}
function normalizeTime(input: unknown): string {
  let s = String(input ?? "").trim();
  if (!s) return "";
  if (/^\d{1,2}\.\d{2}$/.test(s)) s = s.replace(".", ":");
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) s = `${iso[1]}:${iso[2]}`;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  let mi = Math.max(0, Math.min(59, Number(m[2])));
  mi = Math.floor(mi / 15) * 15;
  return `${pad2(h)}:${pad2(mi)}`;
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

// -------- Normalizers (RTL / Unicode) --------
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ZSP  = /[\s\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]+/g;
const FULLWIDTH_AT = /＠/g;
const FULLWIDTH_DOT = /．/g;
function normalizePlain(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(BIDI, "");
  s = s.replace(ZSP, " ").trim();
  s = s.replace(/^[<"'\s]+/, "").replace(/[>"'\s]+$/, "");
  return s;
}
function normalizeEmail(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(BIDI, "");
  s = s.replace(FULLWIDTH_AT, "@").replace(FULLWIDTH_DOT, ".");
  s = s.replace(ZSP, " ").trim();
  s = s.replace(/^[<"'\s]+/, "").replace(/[>"'\s]+$/, "");
  return s.toLowerCase();
}
function isValidEmail(s: string): boolean {
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(s);
}
function pickNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

// ---------------- Strong body reader for Oak ----------------
async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const dbg: Record<string, unknown> = { ct: (ctx.request.headers.get("content-type") ?? "").toLowerCase(), phases: [] as any[] };
  const phase = (name: string, data?: unknown) => { try { (dbg.phases as any[]).push({ name, data }); } catch {} };
  const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null && v !== "") dst[k] = v;
    return dst;
  };
  const fromEntries = (iter: Iterable<[string, FormDataEntryValue]> | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    for (const [k, v0] of (iter as any).entries()) {
      const v = typeof v0 === "string" ? v0 : (v0?.name ?? "");
      o[k] = v;
    }
    return o;
  };

  const out: Record<string, unknown> = {};

  // 1) Oak body() API – ננסה קודם את הטיפוסים הסבירים לפי ה-CT
  async function tryOak(kind: "form" | "form-data" | "json" | "text" | "bytes") {
    try {
      const b = await ctx.request.body?.({ type: kind });
      if (!b) return;
      const t = b.type;
      if (t === "form") {
        const v = await b.value as URLSearchParams;
        const o = fromEntries(v);
        phase("oak.body(form)", o);
        merge(out, o);
      } else if (t === "form-data") {
        // Deno Oak ממיר ל־reader ייעודי
        const v = await b.value;
        const r = await v.read();
        const o = (r?.fields ?? {}) as Record<string, unknown>;
        phase("oak.body(form-data)", o);
        merge(out, o);
      } else if (t === "json") {
        const j = await b.value as Record<string, unknown>;
        phase("oak.body(json)", j);
        merge(out, j || {});
      } else if (t === "text") {
        const txt = await b.value as string;
        phase("oak.body(text)", txt.length > 200 ? txt.slice(0,200) + "…" : txt);
        try { const j = JSON.parse(txt); phase("oak.body(text->json)", j); merge(out, j as any); }
        catch { const sp = new URLSearchParams(txt); const o = fromEntries(sp); if (Object.keys(o).length) { phase("oak.body(text->urlencoded)", o); merge(out, o); } }
      } else if (t === "bytes") {
        const u8 = await b.value as Uint8Array;
        const txt = new TextDecoder().decode(u8);
        phase("oak.body(bytes)", txt.length > 200 ? txt.slice(0,200) + "…" : txt);
        try { const j = JSON.parse(txt); phase("oak.body(bytes->json)", j); merge(out, j as any); }
        catch { const sp = new URLSearchParams(txt); const o = fromEntries(sp); if (Object.keys(o).length) { phase("oak.body(bytes->urlencoded)", o); merge(out, o); } }
      }
    } catch (e) {
      phase(`oak.body(${kind}).error`, String(e));
    }
  }

  await tryOak("form");
  await tryOak("json");
  await tryOak("form-data");
  await tryOak("text");
  await tryOak("bytes");

  // 2) Fallbacks בסגנון Web Request אם קיימים
  const reqAny: any = ctx.request as any;
  try {
    if (typeof reqAny.formData === "function") {
      const fd = await reqAny.formData();
      const o = fromEntries(fd);
      if (Object.keys(o).length) { phase("native.formData", o); merge(out, o); }
    }
  } catch (e) { phase("native.formData.error", String(e)); }
  try {
    if (typeof reqAny.json === "function") {
      const j = await reqAny.json();
      if (j && typeof j === "object") { phase("native.json", j); merge(out, j); }
    }
  } catch (e) { phase("native.json.error", String(e)); }
  try {
    if (typeof reqAny.text === "function") {
      const t: string = await reqAny.text();
      if (t) {
        phase("native.text", t.length > 200 ? t.slice(0,200) + "…" : t);
        try { const j = JSON.parse(t); phase("native.text->json", j); merge(out, j); }
        catch { const sp = new URLSearchParams(t); const o = fromEntries(sp); if (Object.keys(o).length) { phase("native.text->urlencoded", o); merge(out, o); } }
      }
    }
  } catch (e) { phase("native.text.error", String(e)); }

  // 3) תמיד מוסיפים querystring אם חסר
  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  for (const [k, v] of Object.entries(qs)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }

  phase("keys", Object.keys(out));
  return { payload: out, dbg };
}

// ---------------- Helpers: extract date/time ----------------
function extractFromReferer(ctx: any) {
  const ref = ctx.request.headers.get("referer") || ctx.request.headers.get("referrer") || "";
  try {
    const u = new URL(ref);
    return Object.fromEntries(u.searchParams);
  } catch { return {}; }
}
function extractDateAndTime(ctx: any, payload: Record<string, unknown>) {
  const qs = ctx.request.url.searchParams;
  const ref = extractFromReferer(ctx);

  const rawDate = pickNonEmpty(
    payload["date"], payload["reservation_date"], payload["res_date"],
    qs.get("date"), qs.get("reservation_date"), qs.get("res_date"),
    payload["datetime"], payload["datetime_local"], payload["datetime-local"],
    qs.get("datetime"), qs.get("datetime_local"), qs.get("datetime-local"),
    (ref as any)["date"], (ref as any)["reservation_date"], (ref as any)["res_date"],
    (ref as any)["datetime"], (ref as any)["datetime_local"], (ref as any)["datetime-local"]
  );

  const hhmmFromHM = (() => {
    const h = pickNonEmpty(payload["hour"], qs.get("hour"), (ref as any)["hour"]);
    const m = pickNonEmpty(payload["minute"], qs.get("minute"), (ref as any)["minute"]);
    return h && m ? `${pad2(Number(h))}:${pad2(Number(m))}` : "";
  })();

  const rawTime = pickNonEmpty(
    payload["time"], qs.get("time"), (ref as any)["time"],
    payload["time_display"], payload["timeDisplay"], qs.get("time_display"), qs.get("timeDisplay"),
    (ref as any)["time_display"], (ref as any)["timeDisplay"],
    hhmmFromHM,
    payload["datetime"], payload["datetime_local"], payload["datetime-local"],
    qs.get("datetime"), qs.get("datetime_local"), qs.get("datetime-local"),
    (ref as any)["datetime"], (ref as any)["datetime_local"], (ref as any)["datetime-local"]
  );

  const date = normalizeDate(rawDate);
  const time = normalizeTime(rawTime);

  debugLog("extractDateAndTime", {
    rawDate, rawTime,
    from: {
      payload: { date: payload["date"], time: payload["time"], time_display: (payload as any)["time_display"] },
      qs: { date: qs.get("date"), time: qs.get("time") },
      referer: { date: (ref as any)["date"], time: (ref as any)["time"] },
    },
    normalized: { date, time }
  });

  return { date, time };
}

// ---------------- Router ----------------
export const restaurantsRouter = new Router();

function asOk(x: unknown): boolean {
  if (typeof x === "boolean") return x;
  if (x && typeof x === "object" && "ok" in (x as any)) return !!(x as any).ok;
  return !!x;
}

// API: אוטוקומפליט
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(items, null, 2);
});

// דף מסעדה — שלב 1
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  const url = ctx.request.url;
  const conflict = url.searchParams.get("conflict") === "1";
  const suggestions = (url.searchParams.get("suggest") ?? "").split(",").filter(Boolean);
  const date = url.searchParams.get("date") ?? "";
  const time = url.searchParams.get("time") ?? "";

  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant,
    conflict,
    suggestions,
    date,
    time,
  });
});

// API: בדיקת זמינות
restaurantsRouter.post("/api/restaurants/:id/check", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "restaurant not found";
    return;
  }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = 2;

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("bad time (HH:mm expected)");

  const result = await checkAvailability(rid, date, time, people);
  const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  if (asOk(result)) {
    ctx.response.body = JSON.stringify({ ok: true, availableSlots: around.slice(0,4) }, null, 2);
  } else {
    const reason = (result as any)?.reason ?? "unavailable";
    ctx.response.body = JSON.stringify({ ok: false, reason, suggestions: around.slice(0,4) }, null, 2);
  }
});

// שלב 1 → שלב 2
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "restaurant not found";
    return;
  }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = 2;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    debugLog("reserve error invalid format", { date, time, dbg });
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:"אנא בחר/י תאריך ושעה תקינים" }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    if (around.length) url.searchParams.set("suggest", around.slice(0,4).join(","));
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  const u = new URL(`/restaurants/${encodeURIComponent(rid)}/details`, "http://local");
  u.searchParams.set("date", date);
  u.searchParams.set("time", time);
  u.searchParams.set("people", String(people));
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", u.pathname + u.search);
});

// שלב 2
restaurantsRouter.get("/restaurants/:id/details", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  const date = normalizeDate(ctx.request.url.searchParams.get("date") ?? "");
  const time = normalizeTime(ctx.request.url.searchParams.get("time") ?? "");
  const people = Number(ctx.request.url.searchParams.get("people") ?? "2") || 2;

  await render(ctx, "reservation_details", {
    page: "reservation_details",
    title: `פרטי הזמנה — ${restaurant.name}`,
    restaurant,
    date, time, people
  });
});

// שלב 2 → אישור סופי (GET)
restaurantsRouter.get("/restaurants/:id/confirm", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "restaurant not found";
    return;
  }

  const sp = ctx.request.url.searchParams;
  const { date, time } = extractDateAndTime(ctx, Object.fromEntries(sp.entries()));
  const people = toIntLoose(sp.get("people")) ?? 2;

  const customerNameRaw =
    sp.get("name") ?? sp.get("customerName") ?? sp.get("fullName") ?? sp.get("customer_name") ?? sp.get("full_name");
  const customerPhoneRaw =
    sp.get("phone") ?? sp.get("tel") ?? sp.get("customerPhone") ?? sp.get("customer_phone");
  const customerEmailRaw =
    sp.get("email") ?? sp.get("customerEmail") ?? sp.get("customer_email");

  const customerName  = normalizePlain(customerNameRaw ?? "");
  const customerPhone = normalizePlain(customerPhoneRaw ?? "");
  const customerEmail = normalizeEmail(customerEmailRaw ?? "");

  const bad = (m: string, extra?: unknown) => {
    const dbg = { ct: "querystring", phases: [], keys: Array.from(sp.keys()), extra };
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time))       return bad("שעה לא תקינה");
  if (!customerName)                     return bad("נא להזין שם");

  if (!customerPhone && !customerEmail)  return bad("נא להזין טלפון או אימייל");
  if (customerEmail && !isValidEmail(customerEmail))
    return bad("נא להזין אימייל תקין", { customerEmail });

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions: around.slice(0,4) }, null, 2);
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
    note: `Name: ${customerName}; Phone: ${customerPhone}; Email: ${customerEmail}`,
    createdAt: Date.now(),
  };
  await createReservation(reservation);

  await sendReservationEmail({
    to: customerEmail,
    restaurantName: restaurant.name,
    date, time, people,
    customerName,
  }).catch((e) => console.warn("[mail] sendReservationEmail failed:", e));

  const owner = await getUserById(restaurant.ownerId).catch(() => null);
  if (owner?.email) {
    await notifyOwnerEmail({
      to: owner.email,
      restaurantName: restaurant.name,
      customerName, customerPhone, customerEmail,
      date, time, people,
    }).catch((e) => console.warn("[mail] notifyOwnerEmail failed:", e));
  } else {
    console.log("[mail] owner email not found; skipping owner notification");
  }

  await render(ctx, "reservation_confirmed", {
    page: "reservation_confirmed",
    title: "הזמנה אושרה",
    restaurant,
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
  });
});

// שלב 2 → אישור סופי (POST)
restaurantsRouter.post("/restaurants/:id/confirm", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "restaurant not found";
    return;
  }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = toIntLoose(pickNonEmpty((payload as any).people, ctx.request.url.searchParams.get("people"))) ?? 2;

  const customerNameRaw  =
    (payload as any).name ?? (payload as any).customerName ?? (payload as any).fullName ??
    (payload as any)["customer_name"] ?? (payload as any)["full_name"];
  const customerPhoneRaw =
    (payload as any).phone ?? (payload as any).tel ?? (payload as any).customerPhone ?? (payload as any)["customer_phone"];
  const customerEmailRaw =
    (payload as any).email ?? (payload as any).customerEmail ?? (payload as any)["customer_email"];

  const customerName  = normalizePlain(customerNameRaw);
  const customerPhone = normalizePlain(customerPhoneRaw);
  const customerEmail = normalizeEmail(customerEmailRaw);

  const reqId = String(ctx.state?.reqId ?? crypto.randomUUID().slice(0, 8));
  debugLog(`[CONF ${reqId}] fields`, {
    date, time, people,
    customerNameRaw, customerName,
    customerPhoneRaw, customerPhone,
    customerEmailRaw, customerEmail
  });

  const bad = (m: string, extra?: unknown) => {
    const keys = Object.keys(payload ?? {});
    const dbg2 = { ...dbg, keys };
    if (extra) (dbg2 as any).extra = extra;
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg: dbg2 }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time))       return bad("שעה לא תקינה");
  if (!customerName)                     return bad("נא להזין שם");

  if (!customerPhone && !customerEmail)  return bad("נא להזין טלפון או אימייל");
  if (customerEmail && !isValidEmail(customerEmail))
    return bad("נא להזין אימייל תקין", { customerEmail, note: "normalize applied" });

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions: around.slice(0,4) }, null, 2);
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
    note: `Name: ${customerName}; Phone: ${customerPhone}; Email: ${customerEmail}`,
    createdAt: Date.now(),
  };
  await createReservation(reservation);

  await sendReservationEmail({
    to: customerEmail,
    restaurantName: restaurant.name,
    date, time, people,
    customerName,
  }).catch((e) => console.warn("[mail] sendReservationEmail failed:", e));

  const owner = await getUserById(restaurant.ownerId).catch(() => null);
  if (owner?.email) {
    await notifyOwnerEmail({
      to: owner.email,
      restaurantName: restaurant.name,
      customerName, customerPhone, customerEmail,
      date, time, people,
    }).catch((e) => console.warn("[mail] notifyOwnerEmail failed:", e));
  } else {
    console.log("[mail] owner email not found; skipping owner notification");
  }

  await render(ctx, "reservation_confirmed", {
    page: "reservation_confirmed",
    title: "הזמנה אושרה",
    restaurant,
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
  });
});

export default restaurantsRouter;
