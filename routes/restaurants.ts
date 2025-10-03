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

// ---------- Body Reader (MERGE all sources robustly) ----------
async function readBody(ctx: any): Promise<{ payload: Record<string, unknown>; dbg: Record<string, unknown> }> {
  const ct = (ctx.request.headers.get("content-type") ?? "").toLowerCase();
  const reqAny: any = ctx.request as any;
  const original: Request | undefined = (reqAny.originalRequest ?? undefined);

  const dbg: Record<string, unknown> = { ct, phases: [] as any[] };
  const phase = (name: string, data: unknown) => {
    try { (dbg.phases as any[]).push({ name, data }); } catch {}
  };

  const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(b)) {
      if (v !== undefined && v !== null && v !== "") a[k] = v;
    }
    return a;
  };

  const fromForm = (form: FormData | URLSearchParams) => {
    const o: Record<string, unknown> = {};
    // @ts-ignore
    for (const [k, v] of form.entries()) o[k] = v;
    return o;
  };

  const out: Record<string, unknown> = {};

  // Try: Oak typed readers first (json/form/form-data/text/bytes)
  try {
    if (typeof reqAny.body === "function") {
      const b = await reqAny.body();
      if (b?.type === "json") {
        const v = await b.value; if (v && typeof v === "object") { phase("oak.json", v); merge(out, v as any); }
      } else if (b?.type === "form") {
        const v = await b.value; const o = fromForm(v as URLSearchParams); phase("oak.form", o); merge(out, o);
      } else if (b?.type === "form-data") {
        const v = await b.value; const o = fromForm(v as FormData); phase("oak.multipart", o); merge(out, o);
      } else if (b?.type === "text") {
        const t: string = await b.value; phase("oak.text", t);
        try { const j = JSON.parse(t); phase("oak.text->json", j); merge(out, j); } catch {}
      } else if (b?.type === "bytes") {
        const u8: Uint8Array = await b.value; const t = new TextDecoder().decode(u8);
        phase("oak.bytes", t); try { const j = JSON.parse(t); phase("oak.bytes->json", j); merge(out, j); } catch {}
      }
    }
  } catch (e) { phase("oak.error", String(e)); }

  // Try: native Request helpers (Deploy)
  try {
    if (original && (original as any).formData) {
      const fd = await (original as any).formData();
      const o = fromForm(fd); phase("native.formData", o); merge(out, o);
    }
  } catch (e) { phase("native.formData.error", String(e)); }

  try {
    if (original && (original as any).json) {
      const v = await (original as any).json();
      if (v && typeof v === "object") { phase("native.json", v); merge(out, v); }
    }
  } catch (e) { phase("native.json.error", String(e)); }

  try {
    if (original && (original as any).text) {
      const t = await (original as any).text();
      phase("native.text", t);
      if (t) { try { const j = JSON.parse(t); phase("native.text->json", j); merge(out, j); } catch {} }
    }
  } catch (e) { phase("native.text.error", String(e)); }

  // Always merge querystring last (lowest priority)
  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  // נמזג רק אם חסר (לא נדרוס שדות שכבר הגיעו מה-body)
  for (const [k, v] of Object.entries(qs)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }

  return { payload: out, dbg };
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
  const people = 2; // ברירת-מחדל בשלב זה

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
  const reqId = String(ctx.state?.reqId ?? crypto.randomUUID().slice(0,8));
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload, dbg } = await readBody(ctx);

  // לוג: מה באמת הגיע
  console.log(`[CONF ${reqId}] payload`, payload);
  console.log(`[CONF ${reqId}] dbg`, dbg);

  const date = normalizeDate((payload as any).date ?? "");
  const time = normalizeTime((payload as any).time ?? "");
  const people = toIntLoose((payload as any).people) ?? 2;

  const customerName = String((payload as any).name ?? (payload as any).customerName ?? "").trim();
  const customerPhone = String((payload as any).phone ?? (payload as any).customerPhone ?? "").trim();
  const customerEmail = String((payload as any).email ?? (payload as any).customerEmail ?? "").trim();

  const badJSON = (m: string, status = Status.BadRequest, extras: Record<string, unknown> = {}) => {
    ctx.response.status = status;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: false, error: m, ...extras }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badJSON("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time)) return badJSON("שעה לא תקינה");
  if (!customerName) return badJSON("נא להזין שם");
  if (!customerPhone) return badJSON("נא להזין מספר נייד");
  if (!customerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) return badJSON("נא להזין אימייל תקין");

  const avail = await checkAvailability(rid, date, time, people);
  if (!avail.ok) {
    const around = await listAvailableSlotsAround(rid, date, time, people, 120, 16);
    return badJSON("אין זמינות במועד שבחרת", Status.Conflict, { suggestions: around.slice(0,4) });
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

  // מייל לבעל המסעדה (אם ידוע)
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

  // עמוד אישור (HTML מלא)
  await render(ctx, "reservation_confirmed", {
    page: "reservation_confirmed",
    title: "הזמנה אושרה",
    restaurant,
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
  });
});
