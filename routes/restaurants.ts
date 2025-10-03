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
  const t = /^\d{2}\.\d{2}$/.test(s) ? s.replace(".", ":") : s;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  let h = Math.max(0, Math.min(23, Number(m[1])));
  let mi = Math.max(0, Math.min(59, Number(m[2])));
  mi = Math.floor(mi / 15) * 15; // סנאפ לרבע שעה
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

// ---------- Normalizers for tricky inputs (RTL, unicode spaces) ----------
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;               // תווי כיווניות
const ZSP  = /[\s\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]+/g; // רווחי Unicode
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

// ---------- Body Reader (deterministic & robust) ----------
async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const ct = (ctx.request.headers.get("content-type") ?? "").toLowerCase();
  const dbg: Record<string, unknown> = { ct, phases: [] as any[] };
  const phase = (name: string, data: unknown) => {
    try { (dbg.phases as any[]).push({ name, data }); } catch {}
  };

  // Helpers
  const fromURLSearchParams = (sp: URLSearchParams) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of sp.entries()) o[k] = v;
    return o;
  };

  // 1) URL-ENCODED (exact path first)
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      const b = ctx.request.body({ type: "form" });
      const sp: URLSearchParams = await b.value;
      const o = fromURLSearchParams(sp);
      phase("oak.form(urlencoded)", o);
      // גם אם ריק (למשל אם גוף כבר נקרא במקום אחר) ננסה טקסט כפול-גיבוי:
      if (Object.keys(o).length > 0) return { payload: o, dbg };
    } catch (e) {
      phase("oak.form.error", String(e));
    }
    try {
      const t = await ctx.request.body({ type: "text" }).value;
      phase("oak.text(raw)", t);
      const sp = new URLSearchParams(t || "");
      const o = fromURLSearchParams(sp);
      phase("oak.text->urlencoded", o);
      if (Object.keys(o).length > 0) return { payload: o, dbg };
    } catch (e) {
      phase("oak.text.error", String(e));
    }
  }

  // 2) MULTIPART (form-data)
  if (ct.includes("multipart/form-data")) {
    try {
      const b = ctx.request.body({ type: "form-data" });
      const reader = await b.value; // FormDataReader
      const fd = await reader.read(); // { fields, files }
      const o = fd?.fields ?? {};
      phase("oak.multipart.fields", o);
      if (Object.keys(o).length > 0) return { payload: o, dbg };
    } catch (e) {
      phase("oak.multipart.error", String(e));
    }
  }

  // 3) JSON
  if (ct.includes("application/json")) {
    try {
      const b = ctx.request.body({ type: "json" });
      const v = await b.value;
      const o = (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
      phase("oak.json", o);
      if (Object.keys(o).length > 0) return { payload: o, dbg };
    } catch (e) {
      phase("oak.json.error", String(e));
    }
  }

  // 4) Fallbacks (try in safe order)
  try {
    const b = ctx.request.body({ type: "form" });
    const sp: URLSearchParams = await b.value;
    const o = fromURLSearchParams(sp);
    phase("fallback.form", o);
    if (Object.keys(o).length > 0) return { payload: o, dbg };
  } catch {}
  try {
    const b = ctx.request.body({ type: "json" });
    const v = await b.value;
    const o = (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
    phase("fallback.json", o);
    if (Object.keys(o).length > 0) return { payload: o, dbg };
  } catch {}
  try {
    const t = await ctx.request.body({ type: "text" }).value;
    phase("fallback.text", t);
    // JSON attempt
    try {
      const j = JSON.parse(t || "null");
      if (j && typeof j === "object") {
        phase("fallback.text->json", j);
        return { payload: j as Record<string, unknown>, dbg };
      }
    } catch {}
    // urlencoded attempt
    const sp = new URLSearchParams(t || "");
    const o = fromURLSearchParams(sp);
    if (Object.keys(o).length > 0) {
      phase("fallback.text->urlencoded", o);
      return { payload: o, dbg };
    }
  } catch {}

  // 5) Querystring as last resort (and always log)
  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  return { payload: qs, dbg };
}

// ========= ROUTER =========
export const restaurantsRouter = new Router();

/** API: לאוטוקומפליט */
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(items, null, 2);
});

/** דף מסעדה — שלב 1: בחירת תאריך/שעה בלבד */
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

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

/** כלי קטן לשקלול בוליאני מתוצאה שיכולה להיות boolean או אובייקט { ok } */
function asOk(x: unknown): boolean {
  if (typeof x === "boolean") return x;
  if (x && typeof x === "object" && "ok" in (x as any)) return !!(x as any).ok;
  return !!x;
}

/** API: בדיקת זמינות + חלופות (מוצגות בכרטיס, לא alert) */
restaurantsRouter.post("/api/restaurants/:id/check", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload } = await readBody(ctx);
  const date = normalizeDate((payload as any).date ?? "");
  const time = normalizeTime((payload as any).time ?? "");
  const people = 2; // ברירת מחדל בשלב 1

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m }, null, 2);
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

/** שלב 1 → שלב 2: אם אין זמינות → 303 חזרה עם חלופות; אם יש → ניווט לדף פרטים */
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload } = await readBody(ctx);
  const date = normalizeDate((payload as any).date ?? ctx.request.url.searchParams.get("date"));
  const time = normalizeTime((payload as any).time ?? ctx.request.url.searchParams.get("time"));
  const people = 2;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
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

  // יש זמינות → מעבר למסך פרטי לקוח (משמרים את date/time אחרי normalize)
  const u = new URL(`/restaurants/${encodeURIComponent(rid)}/details`, "http://local");
  u.searchParams.set("date", date);
  u.searchParams.set("time", time);
  u.searchParams.set("people", String(people));
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", u.pathname + u.search);
});

/** דף פרטי לקוח (שלב 2) */
restaurantsRouter.get("/restaurants/:id/details", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

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

/** אישור ויצירת ההזמנה (POST משלב 2) — תומך בשמות שדה אלטרנטיביים */
restaurantsRouter.post("/restaurants/:id/confirm", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload, dbg } = await readBody(ctx);

  const date   = normalizeDate((payload as any).date ?? ctx.request.url.searchParams.get("date") ?? "");
  const time   = normalizeTime((payload as any).time ?? ctx.request.url.searchParams.get("time") ?? "");
  const people = toIntLoose((payload as any).people ?? ctx.request.url.searchParams.get("people")) ?? 2;

  const customerNameRaw  =
    (payload as any).name ??
    (payload as any).customerName ??
    (payload as any).fullName ??
    (payload as any)["customer_name"];

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
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg: extra ? { ...dbg, extra } : dbg }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time))       return bad("שעה לא תקינה");
  if (!customerName)                     return bad("נא להזין שם");

  // מספיק טלפון *או* אימייל
  if (!customerPhone && !customerEmail)  return bad("נא להזין טלפון או אימייל");
  if (customerEmail && !isValidEmail(customerEmail)) return bad("נא להזין אימייל תקין", { customerEmail, note: "normalize applied" });

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

  // מיילים
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
