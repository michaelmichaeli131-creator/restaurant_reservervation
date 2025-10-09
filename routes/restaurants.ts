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
  type WeeklySchedule,
  type DayOfWeek,
} from "../database.ts";
import { render } from "../lib/view.ts";
import { sendReservationEmail, notifyOwnerEmail } from "../lib/mail.ts";
import { debugLog } from "../lib/debug.ts";
import { makeReservationToken } from "../lib/token.ts";

/* ---------------- Utilities ---------------- */

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

/* ─────────── normalizeTime: תומך 24h וגם AM/PM ─────────── */
function normalizeTime(input: unknown): string {
  let s = String(input ?? "").trim();
  if (!s) return "";

  // 08.30 -> 08:30 (אפשרי עם AM/PM)
  if (/^\d{1,2}\.\d{2}(\s*[ap]m)?$/i.test(s)) s = s.replace(".", ":");

  // AM/PM -> 24h
  const ampm = s.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
  if (ampm) {
    let h = Math.max(0, Math.min(12, Number(ampm[1])));
    const mi = Math.max(0, Math.min(59, Number(ampm[2])));
    const isPM = /pm/i.test(ampm[3]);
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0; // 12:xx AM -> 00:xx
    return `${pad2(h)}:${pad2(mi)}`;
  }

  // ISO "T08:30" -> "08:30"
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) s = `${iso[1]}:${iso[2]}`;

  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  let mi = Math.max(0, Math.min(59, Number(m[2])));
  // יישור ל-15 דק’ לטובת בדיקות לוגיות; בפועל הפרונט יבנה סלוטים לפי קונפיג
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
function pickNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

/* -------- Normalizers (RTL / Unicode) -------- */

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

/* ---------------- Photos helper (normalize to string[]) ---------------- */
function photoStrings(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p: any) => (typeof p === "string" ? p : String(p?.dataUrl || "")))
    .filter(Boolean);
}

/* ---------------- Opening hours helpers ---------------- */

function toMinutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/* ---- detect if weekly has explicit key for date (even if null) ---- */
function hasScheduleForDate(
  weekly: WeeklySchedule | undefined | null,
  date: string,
): boolean {
  if (!weekly) return false;
  const d = new Date(date + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const dowNum = d.getDay();
  const long = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"] as const;
  const short = ["sun","mon","tue","wed","thu","fri","sat"] as const;

  const keys: Array<string | number> = [
    dowNum, String(dowNum),
    long[dowNum], short[dowNum],
    (long as readonly string[])[dowNum].toUpperCase(),
    (short as readonly string[])[dowNum].toUpperCase(),
  ];

  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(weekly as any, k)) return true;
  }
  return false;
}

/* ---- read windows for a given date; null => [] ---- */
function getWindowsForDate(
  weekly: WeeklySchedule | undefined | null,
  date: string,
): Array<{ open: string; close: string }> {
  if (!weekly) return [];
  const d = new Date(date + "T00:00:00");
  if (isNaN(d.getTime())) return [];
  const dowNum = d.getDay();
  const long = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"] as const;
  const short = ["sun","mon","tue","wed","thu","fri","sat"] as const;

  const candidates: Array<string | number> = [
    dowNum, String(dowNum),
    long[dowNum], short[dowNum],
    (long as readonly string[])[dowNum].toUpperCase(),
    (short as readonly string[])[dowNum].toUpperCase(),
  ];

  let found = false;
  let raw: any = undefined;

  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(weekly as any, k)) {
      found = true;
      raw = (weekly as any)[k];
      break;
    }
  }

  debugLog("[hours] getWindowsForDate", {
    date, dowNum, hadWeekly: !!weekly,
    candidateHit: found,
    candidateType: found ? (Array.isArray(raw) ? "array" : typeof raw) : "none",
  });

  if (!found || raw == null) return [];
  return Array.isArray(raw) ? raw.filter(Boolean) : [raw];
}

function withinAnyWindow(timeMin: number, windows: Array<{ open: string; close: string }>) {
  for (const w of windows) {
    let a = toMinutes(w.open);
    let b = toMinutes(w.close);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b <= a) b = 24 * 60 - 1;
    if (timeMin >= a && timeMin <= b) return true;
  }
  return false;
}

/* ---- final schedule logic ---- */
function isWithinSchedule(weekly: WeeklySchedule | undefined | null, date: string, time: string) {
  const t = toMinutes(time);
  if (!Number.isFinite(t)) return false;

  const hasDay = hasScheduleForDate(weekly, date);
  const windows = getWindowsForDate(weekly, date);

  if (!hasDay) return true;            // backward compatibility: no key ⇒ open all day
  if (windows.length === 0) return false; // explicit null ⇒ closed
  return withinAnyWindow(t, windows);
}

/* ----------- Suggestions helper ----------- */
async function suggestionsWithinSchedule(
  restaurantId: string,
  date: string,
  time: string,
  people: number,
  weekly: WeeklySchedule | undefined | null,
): Promise<string[]> {
  const around = await listAvailableSlotsAround(restaurantId, date, time, people, 120, 16);
  if (!around.length) return [];
  if (!hasScheduleForDate(weekly, date)) return around.slice(0, 8);
  const windows = getWindowsForDate(weekly, date);
  const ok = around.filter((t) => withinAnyWindow(toMinutes(t), windows));
  return ok.slice(0, 8);
}

/* ---------------- Strong body reader for Oak ---------------- */

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

  async function tryOak(kind: "form" | "form-data" | "json" | "text" | "bytes") {
    try {
      const b = await (ctx.request as any).body?.({ type: kind });
      if (!b) return;
      const t = b.type;
      if (t === "form") {
        const v = await b.value as URLSearchParams;
        const o = fromEntries(v);
        phase("oak.body(form)", o);
        merge(out, o);
      } else if (t === "form-data") {
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
        catch { const sp = new URLSearchParams(t); const o = fromEntries(sp); if (Object.keys(o).length) { phase("native.text->urlencoded)", o); merge(out, o); } }
      }
    }
  } catch (e) { phase("native.text.error", String(e)); }

  const qs = Object.fromEntries(ctx.request.url.searchParams);
  phase("querystring", qs);
  for (const [k, v] of Object.entries(qs)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }

  phase("keys", Object.keys(out));
  return { payload: out, dbg };
}

/* ---------------- Helpers: extract date/time ---------------- */

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
    (payload as any)["time_display"], (payload as any)["timeDisplay"],
    qs.get("time_display"), qs.get("timeDisplay"),
    (ref as any)["time_display"], (ref as any)["timeDisplay"],
    hhmmFromHM,
    payload["datetime"], payload["datetime_local"], (payload as any)["datetime-local"],
    qs.get("datetime"), qs.get("datetime_local"), qs.get("datetime-local"),
    (ref as any)["datetime"], (ref as any)["datetime_local"], (ref as any)["datetime-local"]
  );

  const date = normalizeDate(rawDate);
  const time = normalizeTime(rawTime);

  debugLog("[restaurants] extractDateAndTime", {
    from_payload: { date: payload["date"], time: payload["time"], time_display: (payload as any)["time_display"] },
    from_qs: { date: qs.get("date"), time: qs.get("time") },
    from_ref: { date: (ref as any)["date"], time: (ref as any)["time"] },
    rawDate, rawTime,
    normalized: { date, time }
  });

  return { date, time };
}

/* ---------------- Owner hours: parsing helpers ---------------- */

const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0, sun: 0, "0": 0,
  monday: 1, mon: 1, "1": 1,
  tuesday: 2, tue: 2, "2": 2,
  wednesday: 3, wed: 3, "3": 3,
  thursday: 4, thu: 4, "4": 4,
  friday: 5, fri: 5, "5": 5,
  saturday: 6, sat: 6, "6": 6,
  "א": 0, "א׳": 0, "ב": 1, "ב׳": 1, "ג": 2, "ג׳": 2, "ד": 3, "ד׳": 3, "ה": 4, "ה׳": 4, "ו": 5, "ו׳": 5, "ש": 6, "ש׳": 6,
};

type WeeklyHoursMap = { [day: string]: { open: string; close: string } | null };

/** מפענח שעות מ־payload שטוח: hours[1][open], hours.1.close, hours_mon_open וכו' */
function extractHoursFromFlatPayload(payload: Record<string, unknown>): WeeklyHoursMap | null {
  const out: WeeklyHoursMap = { "0": null, "1": null, "2": null, "3": null, "4": null, "5": null, "6": null };

  const entries = Object.entries(payload);
  let hit = false;

  for (const [rawKey, value] of entries) {
    const key = String(rawKey);

    // 1) hours[1][open] / hours[mon][close]
    let m = key.match(/^hours\[(.+?)\]\[(open|close)\]$/i);
    if (!m) {
      // 2) hours.1.open / hours.MON.close
      m = key.match(/^hours[.\-](.+?)[.\-](open|close)$/i);
    }
    if (!m) {
      // 3) hours_1_open / hours_mon_close
      m = key.match(/^hours[_\-](.+?)[_\-](open|close)$/i);
    }
    if (!m) continue;

    hit = true;
    const dayToken = m[1].toString().toLowerCase();
    const field = m[2].toLowerCase(); // open|close

    let idx: number | undefined;
    if (dayToken in DAY_NAME_TO_INDEX) idx = DAY_NAME_TO_INDEX[dayToken];
    else if (/^[0-6]$/.test(dayToken)) idx = parseInt(dayToken, 10);
    if (idx === undefined) continue;

    const rec = out[idx] ?? { open: "", close: "" };
    (rec as any)[field] = normalizeTime(value);
    out[idx] = (rec.open && rec.close) ? { open: rec.open, close: rec.close } : rec;
  }

  return hit ? out : null;
}

/** ממיר כל קלט (כולל JSON string, object או payload שטוח) למפה 0..6 → {open,close}|null */
function ensureWeeklyHours(input: unknown, payloadForFlat?: Record<string, unknown>): WeeklyHoursMap {
  if (payloadForFlat) {
    const flat = extractHoursFromFlatPayload(payloadForFlat);
    if (flat) return flat;
  }

  let obj: any = input ?? {};
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { obj = {}; }
  }
  const out: WeeklyHoursMap = {};
  for (let i = 0; i < 7; i++) out[i] = null;

  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    let idx: number | undefined;
    if (key in DAY_NAME_TO_INDEX) idx = DAY_NAME_TO_INDEX[key];
    else if (/^[0-6]$/.test(key)) idx = parseInt(key, 10);
    if (idx === undefined) continue;

    if (v == null || v === "" || v === false) { out[idx] = null; continue; }

    if (typeof v === "object") {
      const open = normalizeTime((v as any).open);
      const close = normalizeTime((v as any).close);
      out[idx] = (open && close) ? { open, close } : null;
      continue;
    }

    if (typeof v === "string") {
      const m = /^(\S+)\s*-\s*(\S+)$/.exec(v);
      if (m) {
        const open = normalizeTime(m[1]);
        const close = normalizeTime(m[2]);
        out[idx] = (open && close) ? { open, close } : null;
      } else {
        out[idx] = null;
      }
    }
  }
  return out;
}

/* ---------------- Router ---------------- */

export const restaurantsRouter = new Router();

function asOk(x: unknown): boolean {
  if (typeof x === "boolean") return x;
  if (x && typeof x === "object" && "ok" in (x as any)) return !!(x as any).ok;
  return !!x;
}

/* API: לאוטוקומפליט */
restaurantsRouter.get("/api/restaurants", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q") ?? "";
  const onlyApproved = (ctx.request.url.searchParams.get("approved") ?? "1") !== "0";
  const items = await listRestaurants(q, onlyApproved);

  // normalize photos for API consumers
  const out = items.map(r => ({
    ...r,
    photos: photoStrings(r.photos),
  }));

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(out, null, 2);
});

/* דף מסעדה — שלב 1 */
restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  const rawDate = ctx.request.url.searchParams.get("date") ?? "";
  const rawTime = ctx.request.url.searchParams.get("time") ?? "";
  const date = normalizeDate(rawDate) || todayISO();
  const time = normalizeTime(rawTime);

  const hasDay = hasScheduleForDate(restaurant.weeklySchedule as WeeklySchedule, date);
  const windows = getWindowsForDate(restaurant.weeklySchedule as WeeklySchedule, date);
  const openingWindows = hasDay ? windows : [{ open: "00:00", close: "23:59" }];

  // ברירת מחדל לקונפיג סלוטים אם לא נשמרו במסעדה
  const slotIntervalMinutes = (restaurant as any).slotIntervalMinutes ?? 15;
  const serviceDurationMinutes = (restaurant as any).serviceDurationMinutes ?? 120;

  debugLog("[restaurants][GET /restaurants/:id] view", {
    id, date, rawTime, time,
    hasWeekly: !!restaurant.weeklySchedule,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : [],
    openingWindows
  });

  // normalize photos for template (expects string[])
  const photos = photoStrings(restaurant.photos);

  // להעביר שעות פתיחה תחת כמה שמות לתמיכה בטמפלטים שונים + קונפיג סלוטים
  const restaurantForView = {
    ...restaurant,
    photos,
    weeklySchedule: (restaurant as any).weeklySchedule ?? null,
    openingHours: (restaurant as any).weeklySchedule ?? (restaurant as any).openingHours ?? null,
    hours:        (restaurant as any).weeklySchedule ?? (restaurant as any).hours ?? null,
    open_hours:   (restaurant as any).weeklySchedule ?? (restaurant as any).open_hours ?? null,
    slotIntervalMinutes,
    serviceDurationMinutes,
  };

  await render(ctx, "restaurant", {
    page: "restaurant",
    title: `${restaurant.name} — GeoTable`,
    restaurant: restaurantForView,
    openingWindows,           // חלונות ליום ההתחלתי (לנוחות הפרונט)
    slotIntervalMinutes,      // אופציונלי: אם התבנית משתמשת בזה
    serviceDurationMinutes,   // אופציונלי
    conflict: ctx.request.url.searchParams.get("conflict") === "1",
    suggestions: (ctx.request.url.searchParams.get("suggest") ?? "").split(",").filter(Boolean),
    date,
    time,
  });
});

/* API: בדיקת זמינות */
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
  const people = toIntLoose((payload as any).people) ?? 2;

  const hasDay = hasScheduleForDate(restaurant.weeklySchedule, date);
  const windows = getWindowsForDate(restaurant.weeklySchedule, date);
  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);

  debugLog("[restaurants][POST /api/.../check] input", {
    rid, date, time, people,
    body_ct: dbg.ct, body_keys: Object.keys(payload),
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : [],
    hasDay, windows, within
  });

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("bad time (HH:mm expected)");

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, reason: hasDay ? "closed" : "unspecified", suggestions }, null, 2);
    return;
  }

  const result = await checkAvailability(rid, date, time, people);
  const around = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  if (asOk(result)) {
    ctx.response.body = JSON.stringify({ ok: true, availableSlots: around.slice(0,4) }, null, 2);
  } else {
    const reason = (result as any)?.reason ?? "unavailable";
    ctx.response.body = JSON.stringify({ ok: false, reason, suggestions: around.slice(0,4) }, null, 2);
  }
});

/* שלב 1 → שלב 2 */
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
  const people = toIntLoose((payload as any).people) ?? 2;

  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);
  debugLog("[restaurants][POST reserve] before-redirect", {
    rid, date, time, within,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    debugLog("[restaurants][POST reserve] invalid-format", { date, time, dbg });
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:"אנא בחר/י תאריך ושעה תקינים" }, null, 2);
    return;
  }

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    if (suggestions.length) url.searchParams.set("suggest", suggestions.join(","));
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    if (suggestions.length) url.searchParams.set("suggest", suggestions.join(","));
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

/* שלב 2 */
restaurantsRouter.get("/restaurants/:id/details", async (ctx) => {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  const date = normalizeDate(ctx.request.url.searchParams.get("date") ?? "") || todayISO();
  const time = normalizeTime(ctx.request.url.searchParams.get("time") ?? "");
  const people = Number(ctx.request.url.searchParams.get("people") ?? "2") || 2;

  debugLog("[restaurants][GET details]", {
    id, date, time, people,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const photos = photoStrings(restaurant.photos);

  await render(ctx, "reservation_details", {
    page: "reservation_details",
    title: `פרטי הזמנה — ${restaurant.name}`,
    restaurant: { ...restaurant, photos, openingHours: restaurant.weeklySchedule },
    date, time, people
  });
});

/* שלב 2 → אישור סופי (GET) */
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

  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);
  debugLog("[restaurants][GET confirm] input", {
    rid, date, time, people, within,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

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

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"המסעדה סגורה בשעה שנבחרה", suggestions }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions }, null, 2);
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

  // normalize for template (אחידות)
  const photos = photoStrings(restaurant.photos);

  await render(ctx, "reservation_confirmed", {
    page: "reservation_confirmed",
    title: "הזמנה אושרה",
    restaurant: { ...restaurant, photos },
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
  });
});


const token = await makeReservationToken(reservation.id, user?.email);
const origin = Deno.env.get("APP_BASE_URL")?.replace(/\/+$/, "") || `${ctx.request.url.protocol}//${ctx.request.url.host}`;
const manageUrl = `${origin}/r/${encodeURIComponent(token)}`;

// שלב את `manageUrl` בגוף המייל (טקסט/HTML):
await sendReservationEmail({
  to: user.email,
  subject: "הזמנתך התקבלה",
  text: `שלום ${user.firstName ?? ""},\n\nלניהול ההזמנה:\n${manageUrl}\n\nלאשר, לבטל או לשנות מועד — בלחיצה אחת.`,
  html: `<p>שלום ${user.firstName ?? ""},</p>
         <p>להלן קישור לניהול ההזמנה (אישור/ביטול/שינוי מועד):<br>
         <a href="${manageUrl}" target="_blank" rel="noopener">${manageUrl}</a></p>`,
});



/* שלב 2 → אישור סופי (POST) */
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

  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);

  const customerNameRaw  =
    (payload as any).name ?? (payload as any).customerName ?? (payload as any).fullName ??
    (payload as any)["customer_name"] ?? (payload as any)["full_name"];
  const customerPhoneRaw =
    (payload as any).phone ?? (payload as any).tel ?? (payload as any).customerPhone ?? (payload as any)["customer_phone"];
  const customerEmailRaw =
    (payload as any).email ?? (payload as any).customerEmail ?? (payload as any)["customer_email"];

  debugLog("[restaurants][POST confirm] input", {
    rid, date, time, people,
    within, body_ct: dbg.ct, body_keys: Object.keys(payload),
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const customerName  = normalizePlain(customerNameRaw);
  const customerPhone = normalizePlain(customerPhoneRaw);
  const customerEmail = normalizeEmail(customerEmailRaw);

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
  if (customerEmail && !isValidEmail(customerEmail)) return bad("נא להזין אימייל תקין", { customerEmail, note: "normalize applied" });

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"המסעדה סגורה בשעה שנבחרה", suggestions }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions }, null, 2);
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

  const photos = photoStrings(restaurant.photos);

  await render(ctx, "reservation_confirmed", {
    page: "reservation_confirmed",
    title: "הזמנה אושרה",
    restaurant: { ...restaurant, photos },
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
  });
});

/* ---------------- Owner: save opening hours ---------------- */

/** POST /restaurants/:id/hours – תומך ב-JSON, form-data ו-urlencoded (כולל שדות שטוחים) */
restaurantsRouter.post("/restaurants/:id/hours", async (ctx) => {
  const rid = String(ctx.params.id ?? "");

  const { payload, dbg } = await readBody(ctx);

  debugLog("[restaurants][POST hours] input", {
    rid,
    body_ct: dbg.ct,
    body_keys: Object.keys(payload),
  });

  const capacity = Math.max(1, toIntLoose((payload as any).capacity ?? (payload as any).maxConcurrent) ?? 1);
  const slotIntervalMinutes = Math.max(5, toIntLoose((payload as any).slotIntervalMinutes ?? (payload as any).slot) ?? 15);
  const serviceDurationMinutes = Math.max(30, toIntLoose((payload as any).serviceDurationMinutes ?? (payload as any).span) ?? 120);

  // שימוש בנרמול המקיף כדי לתמוך בכל הצורות (JSON/שטוח/מחרוזות)
  const weeklyCandidate =
    (payload as any).weeklySchedule ??
    (payload as any).hours ??
    (payload as any).weeklyHours ??
    (payload as any).openingHours ??
    null;

  const normalizedMap = ensureWeeklyHours(weeklyCandidate, payload);

  // המרה ל־WeeklySchedule לפי DayOfWeek (0..6) → {open,close}|null
  const normalized: WeeklySchedule = {};
  for (let d = 0 as DayOfWeek; d <= 6; d = (d + 1) as DayOfWeek) {
    const row = (normalizedMap as any)[d] ?? null;
    normalized[d] = row && row.open && row.close ? { open: row.open, close: row.close } : null;
  }

  debugLog("[restaurants][POST hours] normalized", {
    capacity,
    slotIntervalMinutes,
    serviceDurationMinutes,
    weeklySchedule: normalized,
  });

  // עדכון DB
  const db = await import("../database.ts");
  const updater = (db as any).updateRestaurant;

  if (!updater) {
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = "No DB updater found";
    return;
  }

  try {
    await updater(rid, {
      weeklySchedule: normalized,
      capacity,
      slotIntervalMinutes,
      serviceDurationMinutes,
    });
    debugLog("[restaurants][POST hours] saved OK", { rid });
  } catch (e) {
    console.error("[hours.save] DB update failed", e);
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = "DB update failed: " + String(e);
    return;
  }

  const wantsJson =
    (ctx.request.headers.get("accept") || "").includes("application/json") ||
    (ctx.request.headers.get("content-type") || "").includes("application/json");

  if (wantsJson) {
    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, weeklySchedule: normalized, capacity, slotIntervalMinutes, serviceDurationMinutes }, null, 2);
  } else {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", `/restaurants/${encodeURIComponent(rid)}`);
  }
});

export const router = restaurantsRouter;
export default restaurantsRouter;
