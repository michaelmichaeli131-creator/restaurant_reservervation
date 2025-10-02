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
  // חיתוך לשתי ספרות-נקודתיים-שתי ספרות
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  let h = Math.max(0, Math.min(23, Number(m[1])));
  let mi = Math.max(0, Math.min(59, Number(m[2])));
  // יישור לרבע שעה
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

// ---------- Body Reader ----------
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

  if (ct.includes("application/json")) {
    try {
      if (typeof reqAny.body === "function") {
        const v = await reqAny.body({ type: "json" }).value;
        if (v && typeof v === "object") { phase("oak.json", v); return { payload: v, dbg }; }
        phase("oak.json.empty", v);
      }
    } catch (e) { phase("oak.json.error", String(e)); }

    try {
      if (typeof reqAny.body === "function") {
        const b = await reqAny.body();
        if (b?.type === "json") { const v = await b.value; if (v && typeof v === "object") { phase("oak.generic.json", v); return { payload: v, dbg }; } }
        else if (b?.type === "bytes") {
          const u8: Uint8Array = await b.value; const text = new TextDecoder().decode(u8);
          phase("oak.bytes", text); try { const j = JSON.parse(text); phase("oak.bytes->json", j); return { payload: j, dbg }; } catch {}
        } else if (b?.type === "text") {
          const text: string = await b.value; phase("oak.text", text);
          try { const j = JSON.parse(text); phase("oak.text->json", j); return { payload: j, dbg }; } catch {}
        }
      }
    } catch (e) { phase("oak.generic.error", String(e)); }

    try {
      if (original && (original as any).json) {
        const v = await (original as any).json();
        if (v && typeof v === "object") { phase("native.json", v); return { payload: v, dbg }; }
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

  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      if (typeof reqAny.body === "function") {
        const v = await reqAny.body({ type: "form" }).value;
        const o = fromForm(v as URLSearchParams); phase("oak.form", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("oak.form.error", String(e)); }
    try {
      if (original && (original as any).formData) {
        const fd = await (original as any).formData();
        const o = fromForm(fd); phase("native.formData(urlencoded)", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("native.formData.error", String(e)); }
  }

  if (ct.includes("multipart/form-data")) {
    try {
      if (typeof reqAny.body === "function") {
        const v = await reqAny.body({ type: "form-data" }).value;
        const o = fromForm(v as FormData); phase("oak.multipart", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("oak.multipart.error", String(e)); }
    try {
      if (original && (original as any).formData) {
        const fd = await (original as any).formData();
        const o = fromForm(fd); phase("native.formData(multipart)", o);
        return { payload: o, dbg };
      }
    } catch (e) { phase("native.formData(multipart).error", String(e)); }
  }

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

  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  return { payload: qs, dbg };
}

// ייצוא יחיד
export const restaurantsRouter = new Router();

/** API: לאוטוקומפליט */
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(items, null, 2);
});

/** דף מסעדה — שלב 1: בחירת תאריך ושעה בלבד */
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

/** API: בדיקת זמינות + חלופות במסך (לא alert) — משמש JS */
restaurantsRouter.post("/api/restaurants/:id/check", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload } = await readBody(ctx);
  const date = normalizeDate((payload as any).date ?? "");
  const time = normalizeTime((payload as any).time ?? "");
  // כרגע, מספר סועדים יקבע בשלב הבא; לצורך בדיקת עומס נשתמש בברירת מחדל 2
  const people = 2;

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
  if (result.ok) {
    ctx.response.body = JSON.stringify({ ok: true, availableSlots: around.slice(0,4) }, null, 2);
  } else {
    ctx.response.body = JSON.stringify({ ok: false, reason: (result as any).reason, suggestions: around.slice(0,4) }, null, 2);
  }
});

/** שלב 1 → שלב 2 (פרטי לקוח): אם יש זמינות ננווט לדף פרטים, אחרת נחזיר 303 עם חלופות */
restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload } = await readBody(ctx);
  const date = normalizeDate((payload as any).date ?? ctx.request.url.searchParams.get("date"));
  const time = normalizeTime((payload as any).time ?? ctx.request.url.searchParams.get("time"));
  const people = 2; // בשלב זה קובעים ברירת־מחדל; ניתן להרחיב בהמשך לפי דרישתך

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:"אנא בחר/י תאריך ושעה תקינים" }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!avail.ok) {
    const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    if (around.length) url.searchParams.set("suggest", around.slice(0,4).join(","));
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    ctx.response.status = Status.SeeOther; // 303
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  // יש זמינות → מעבר למסך פרטי לקוח
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

  const date = ctx.request.url.searchParams.get("date") ?? "";
  const time = ctx.request.url.searchParams.get("time") ?? "";
  const people = Number(ctx.request.url.searchParams.get("people") ?? "2") || 2;

  await render(ctx, "reservation_details", {
    page: "reservation_details",
    title: `פרטי הזמנה — ${restaurant.name}`,
    restaurant,
    date, time, people
  });
});

/** אישור ויצירת ההזמנה (POST משלב 2) */
restaurantsRouter.post("/restaurants/:id/confirm", async (ctx) => {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload } = await readBody(ctx);
  const date = normalizeDate((payload as any).date ?? "");
  const time = normalizeTime((payload as any).time ?? "");
  const people = toIntLoose((payload as any).people) ?? 2;

  const customerName = String((payload as any).name ?? "").trim();
  const customerPhone = String((payload as any).phone ?? "").trim();
  const customerEmail = String((payload as any).email ?? "").trim();

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("שעה לא תקינה");
  if (!customerName) return bad("נא להזין שם");
  if (!customerPhone) return bad("נא להזין מספר נייד");
  if (!customerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) return bad("נא להזין אימייל תקין");

  const avail = await checkAvailability(rid, date, time, people);
  if (!avail.ok) {
    const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions: around.slice(0,4) }, null, 2);
    return;
  }

  // יצירת ההזמנה
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

  // מייל ללקוח
  await sendReservationEmail({
    to: customerEmail,
    restaurantName: restaurant.name,
    date, time, people,
    customerName,
  }).catch((e) => console.warn("[mail] sendReservationEmail failed:", e));

  // מייל לבעל המסעדה
  // ננסה להביא את המייל של הבעלים דרך טבלת המשתמשים:
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

  // עמוד אישור
  await render(ctx, "reservation_confirmed", {
    page: "reservation_confirmed",
    title: "הזמנה אושרה",
    restaurant,
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
  });
});
