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

// Utilities
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
  if (!s) {
    // אם אין קלט — נחזיר מחרוזת ריקה כדי לא לגרום לברירת מחדל מפוקפקת
    return "";
  }
  const t = /^\d{2}\.\d{2}$/.test(s) ? s.replace(".", ":") : s;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  let h = Math.max(0, Math.min(23, Number(m[1])));
  let mi = Math.max(0, Math.min(59, Number(m[2])));
  mi = Math.round(mi / 15) * 15;
  if (mi === 60) {
    mi = 0;
    h = (h + 1) % 24;
  }
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

// Normalizers (RTL / Unicode)
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

// ---------- helpers: coalesce date/time from various keys ----------
function coalesceDateLike(obj: Record<string, unknown> | URLSearchParams | null | undefined): string | null {
  if (!obj) return null;
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = obj instanceof URLSearchParams ? obj.get(n) : (obj as any)[n];
      if (v != null && String(v).trim() !== "") return String(v);
    }
    return null;
  };
  const candidates = pick("date", "day", "when_date", "dt", "reservation_date");
  if (candidates) return normalizeDate(candidates);
  // נסה לחלץ מכל שדה שפוי
  const entries = obj instanceof URLSearchParams ? Array.from(obj.entries()) : Object.entries(obj as any);
  for (const [, v] of entries) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    // yyyy-mm-dd או dd/mm/yyyy וכד'
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{2})[\/.](\d{2})[\/.](\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return null;
}
function coalesceTimeLike(obj: Record<string, unknown> | URLSearchParams | null | undefined): string {
  if (!obj) return "";
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = obj instanceof URLSearchParams ? obj.get(n) : (obj as any)[n];
      if (v != null && String(v).trim() !== "") return String(v);
    }
    return null;
  };
  const direct =
    pick("time", "slot", "hour", "hhmm", "when", "time_display", "time-display", "timeDisplay", "timeSelected") ??
    "";
  if (direct) {
    const norm = normalizeTime(direct);
    if (/^\d{2}:\d{2}$/.test(norm)) return norm;
  }
  // נסה לחלץ HH:MM מכל שדה
  const entries = obj instanceof URLSearchParams ? Array.from(obj.entries()) : Object.entries(obj as any);
  for (const [, v] of entries) {
    const s = String(v ?? "").trim();
    const m = s.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m) {
      return normalizeTime(`${pad2(Number(m[1]))}:${pad2(Number(m[2]))}`);
    }
  }
  return "";
}

// Body reader (REWORKED: קודם Oak → ואז native; לא שותים את הזרם פעמיים)
async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const ct = (ctx.request.headers.get("content-type") ?? "").toLowerCase();
  const dbg: Record<string, unknown> = { ct, phases: [] as any[] };
  const phase = (name: string, data: unknown) => {
    try { (dbg.phases as any[]).push({ name, data }); } catch {}
  };

  const out: Record<string, unknown> = {};
  const fromEntries = (iter: Iterable<[string, FormDataEntryValue]> | URLSearchParams | any) => {
    const o: Record<string, unknown> = {};
    if (iter && typeof (iter as any).entries === "function") {
      for (const [k, v] of iter.entries()) o[k] = typeof v === "string" ? v : v?.name ?? "";
    } else if (iter && typeof iter === "object") {
      for (const [k, v] of Object.entries(iter)) o[k] = v as any;
    }
    return o;
  };
  const merge = (src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== null && v !== "") out[k] = v;
    }
  };

  // 1) OAK FIRST: ctx.request.body() (auto detect)
  try {
    const bb = await ctx.request.body(); // auto-detect
    phase("oak.fn.detected", bb?.type ?? null);

    if (bb?.type === "json") {
      const v = await bb.value;
      phase("oak.fn.json", v);
      if (v && typeof v === "object") merge(v as any);
    } else if (bb?.type === "form") {
      const v = await bb.value; // URLSearchParams
      const o = fromEntries(v as URLSearchParams);
      phase("oak.fn.form(urlencoded)", o);
      merge(o);
    } else if (bb?.type === "form-data") {
      const v = await bb.value;
      // @ts-ignore read exists on form-data body in Oak
      const r = await v.read();
      const o = (r?.fields ?? {}) as Record<string, unknown>;
      phase("oak.fn.multipart", Object.keys(o));
      merge(o);
    } else if (bb?.type === "text") {
      const t: string = await bb.value;
      phase("oak.fn.text", t.length > 200 ? t.slice(0,200) + "…" : t);
      try {
        const j = JSON.parse(t);
        phase("oak.fn.text->json", true);
        merge(j as any);
      } catch {
        const sp = new URLSearchParams(t);
        const o = fromEntries(sp);
        if (Object.keys(o).length) {
          phase("oak.fn.text->urlencoded", o);
          merge(o);
        }
      }
    } else if (bb?.type === "bytes") {
      const u8: Uint8Array = await bb.value;
      const t = new TextDecoder().decode(u8);
      phase("oak.fn.bytes", t.length > 200 ? t.slice(0,200) + "…" : t);
      try {
        const j = JSON.parse(t);
        phase("oak.fn.bytes->json", true);
        merge(j as any);
      } catch {
        const sp = new URLSearchParams(t);
        const o = fromEntries(sp);
        if (Object.keys(o).length) {
          phase("oak.fn.bytes->urlencoded", o);
          merge(o);
        }
      }
    } else {
      phase("oak.fn.type", bb?.type ?? "none");
    }
  } catch (e) {
    phase("oak.fn.error", String(e));
  }

  // 2) NATIVE (run only if needed; לא חובה, אבל עוזר אם מישהו עוקף את Oak)
  try {
    // formData
    // deno-lint-ignore no-explicit-any
    const reqAny: any = ctx.request;
    if (Object.keys(out).length === 0 && typeof reqAny?.formData === "function") {
      const fd = await reqAny.formData();
      const o = fromEntries(fd);
      if (Object.keys(o).length) { phase("native.ctx.formData", o); merge(o); }
    }
  } catch (e) { phase("native.ctx.formData.error", String(e)); }

  try {
    const reqAny: any = ctx.request;
    if (Object.keys(out).length === 0 && typeof reqAny?.json === "function") {
      const j = await reqAny.json();
      if (j && typeof j === "object") { phase("native.ctx.json", j); merge(j as any); }
    }
  } catch (e) { phase("native.ctx.json.error", String(e)); }

  try {
    const reqAny: any = ctx.request;
    if (Object.keys(out).length === 0 && typeof reqAny?.text === "function") {
      const t: string = await reqAny.text();
      if (t) {
        phase("native.ctx.text", t.length > 200 ? t.slice(0,200) + "…" : t);
        try {
          const j = JSON.parse(t);
          phase("native.ctx.text->json", true);
          merge(j as any);
        } catch {
          const sp = new URLSearchParams(t);
          const o = fromEntries(sp);
          if (Object.keys(o).length) { phase("native.ctx.text->urlencoded", o); merge(o); }
        }
      }
    }
  } catch (e) { phase("native.ctx.text.error", String(e)); }

  // 3) Query fallback
  const qs = ctx.request.url.searchParams;
  const qsObj = Object.fromEntries(qs.entries());
  phase("querystring", qsObj);
  for (const [k, v] of Object.entries(qsObj)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }

  phase("keys", Object.keys(out));
  return { payload: out, dbg };
}

// Router setup
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
  debugLog("check payload", payload);

  // ★ חדש: שימוש ב-coalesce
  const date = coalesceDateLike(payload) ?? coalesceDateLike(ctx.request.url.searchParams) ?? todayISO();
  const time = coalesceTimeLike(payload) || coalesceTimeLike(ctx.request.url.searchParams);

  debugLog("check normalized date,time", { date, time });

  const people = 2;

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("bad time (HH:mm expected)");

  const result = await checkAvailability(rid, date, time, people);
  debugLog("checkAvailability result", result);
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
  debugLog("reserve payload", payload);

  // ★ חדש: שימוש ב-coalesce גם כאן (payload + query)
  const date =
    coalesceDateLike(payload) ??
    coalesceDateLike(ctx.request.url.searchParams) ??
    normalizeDate((payload as any).date ?? ctx.request.url.searchParams.get("date"));
  const time =
    coalesceTimeLike(payload) ||
    coalesceTimeLike(ctx.request.url.searchParams) ||
    normalizeTime((payload as any).time ?? ctx.request.url.searchParams.get("time"));

  debugLog("reserve normalized date,time", { date, time });

  const people = 2;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    debugLog("reserve error invalid format", { date, time, dbg });
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:"אנא בחר/י תאריך ושעה תקינים", dbg }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  debugLog("reserve availability", avail);

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
  const date   = normalizeDate(sp.get("date") ?? "");
  const time   = normalizeTime(sp.get("time") ?? "");
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
  debugLog("confirm availability", avail);
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
  debugLog("confirm POST payload", payload);

  const date   = coalesceDateLike(payload) ?? coalesceDateLike(ctx.request.url.searchParams) ?? "";
  const time   = coalesceTimeLike(payload) || coalesceTimeLike(ctx.request.url.searchParams) || "";
  debugLog("confirm POST normalized date,time", { date, time });

  const people = toIntLoose((payload as any).people ?? ctx.request.url.searchParams.get("people")) ?? 2;

  const customerNameRaw  =
    (payload as any).name ??
    (payload as any).customerName ??
    (payload as any).fullName ??
    (payload as any)["customer_name"] ??
    (payload as any)["full_name"];

  const customerPhoneRaw =
    (payload as any).phone ??
    (payload as any).tel ??
    (payload as any).customerPhone ??
    (payload as any)["customer_phone"];

  const customerEmailRaw =
    (payload as any).email ??
    (payload as any).customerEmail ??
    (payload as any)["customer_email"];

  const customerName  = normalizePlain(customerNameRaw);
  const customerPhone = normalizePlain(customerPhoneRaw);
  const customerEmail = normalizeEmail(customerEmailRaw);

  const reqId = String(ctx.state?.reqId ?? crypto.randomUUID().slice(0, 8));
  console.log(`[CONF ${reqId}] fields`, {
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
  debugLog("confirm availability (POST)", avail);
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
