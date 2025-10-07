// src/database.ts
// Deno KV – אינדקסים עם prefix ועסקאות atomic
// שדרוגים: נירמול חלקי מפתח (Key Parts) + קשיחות createUser לגזירת username מה-email במקרה הצורך.

export interface User {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  age?: number;
  businessType?: string;
  passwordHash?: string;
  role: "user" | "owner";
  provider: "local" | "google";
  emailVerified?: boolean;
  createdAt: number;
}

export type DayOfWeek = 0|1|2|3|4|5|6; // 0=Sunday .. 6=Saturday
export interface OpeningWindow { open: string; close: string; } // "HH:mm"
// אפשר גם לתמוך במערכים מרובים לכל יום בהמשך; כרגע חלון יחיד ליום:
export type WeeklySchedule = Partial<Record<DayOfWeek, OpeningWindow | null>>;

export interface Restaurant {
  id: string;
  ownerId: string;
  name: string;
  city: string;
  address: string;
  phone?: string;
  hours?: string;                 // טקסט חופשי, נשאר לפורמט ישן
  description?: string;
  menu: Array<{ name: string; price?: number; desc?: string }>;
  capacity: number;                 // קיבולת בו־זמנית
  slotIntervalMinutes: number;      // גריד הסלוטים (ברירת מחדל 15 דק׳)
  serviceDurationMinutes: number;   // משך ישיבה (ברירת מחדל 120 דק׳)
  weeklySchedule?: WeeklySchedule;  // הגבלת פתיחה (אופציונלי)
  photos?: string[];
  approved?: boolean;               // דורש אישור אדמין
  createdAt: number;
}

export interface Reservation {
  id: string;
  restaurantId: string;
  userId: string; // גם ל-block ידני אפשר "manual-block:<ownerId>"
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm (תחילת הישיבה)
  people: number;
  note?: string;
  status?: "new" | "confirmed" | "canceled" | "completed" | "blocked";
  createdAt: number;
}

// KV יחיד לכל התהליכים
export const kv = await Deno.openKv();

const lower = (s?: string) => (s ?? "").trim().toLowerCase();
const now = () => Date.now();

/* ─────────────── Key helpers: הבטחת טיפוסים חוקיים לכל חלק מפתח ─────────────── */

type KeyPart = string | number | bigint | boolean | Uint8Array;
function ensureKeyPart(p: unknown): KeyPart {
  if (typeof p === "string" || typeof p === "number" || typeof p === "bigint" || typeof p === "boolean") return p;
  if (p instanceof Uint8Array) return p;
  if (p === undefined || p === null) return "";          // אין undefined/null ב־KV key
  return String(p);                                      // כל השאר -> מחרוזת
}
function toKey(...parts: unknown[]): Deno.KvKey {
  return parts.map(ensureKeyPart) as Deno.KvKey;
}

/* ───────────────────────────── Users ───────────────────────────── */

export async function createUser(u: {
  id?: string;
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  businessType?: string;
  passwordHash?: string;
  role?: "user" | "owner";
  provider?: "local" | "google";
}): Promise<User> {
  const id = u.id || crypto.randomUUID();

  const emailNorm = lower(u.email);
  if (!emailNorm) throw new Error("email_required");

  // אם לא הגיע username – נגזור מ-email (לפני ה־@); אם עדיין ריק, ניצור מחולל קצר
  const usernameNorm =
    lower(u.username) ||
    lower(emailNorm.split("@")[0] || "") ||
    ("user_" + crypto.randomUUID().slice(0, 8));

  const firstName = (u.firstName ?? "").trim();
  const lastName  = (u.lastName ?? "").trim();

  const user: User = {
    id,
    email: emailNorm,
    username: usernameNorm,
    firstName,
    lastName,
    age: u.age,
    businessType: u.businessType?.trim(),
    passwordHash: u.passwordHash,
    role: u.role ?? "owner",
    provider: u.provider ?? "local",
    emailVerified: false,
    createdAt: now(),
  };

  const tx = kv.atomic()
    .check({ key: toKey("user_by_email", user.email), versionstamp: null })
    .check({ key: toKey("user_by_username", user.username), versionstamp: null })
    .set(toKey("user", user.id), user)
    .set(toKey("user_by_email", user.email), user.id)
    .set(toKey("user_by_username", user.username), user.id);

  const res = await tx.commit();
  if (!res.ok) throw new Error("user_exists");
  return user;
}

export async function findUserByEmail(email: string) {
  const ref = await kv.get<string>(toKey("user_by_email", lower(email)));
  if (!ref.value) return null;
  return (await kv.get<User>(toKey("user", ref.value))).value ?? null;
}

export async function findUserByUsername(username: string) {
  const ref = await kv.get<string>(toKey("user_by_username", lower(username)));
  if (!ref.value) return null;
  return (await kv.get<User>(toKey("user", ref.value))).value ?? null;
}

export async function getUserById(id: string) {
  return (await kv.get<User>(toKey("user", id))).value ?? null;
}

export async function setEmailVerified(userId: string) {
  const cur = await kv.get<User>(toKey("user", userId));
  if (!cur.value) return null;
  const next = { ...cur.value, emailVerified: true };
  await kv.set(toKey("user", userId), next);
  return next;
}

export async function updateUserPassword(userId: string, passwordHash: string) {
  const cur = await kv.get<User>(toKey("user", userId));
  if (!cur.value) return null;
  const next = { ...cur.value, passwordHash };
  await kv.set(toKey("user", userId), next);
  return next;
}

/* אימות/שחזור */

export async function createVerifyToken(userId: string, email: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await kv.set(toKey("verify", token), { userId, email, createdAt: now() });
  return token;
}

export async function useVerifyToken(token: string) {
  const v = await kv.get<{ userId: string; email: string; createdAt: number }>(toKey("verify", token));
  if (!v.value) return null;
  await kv.delete(toKey("verify", token));
  return v.value;
}

export async function createResetToken(userId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await kv.set(toKey("reset", token), { userId, createdAt: now() });
  return token;
}

export async function useResetToken(token: string) {
  const v = await kv.get<{ userId: string; createdAt: number }>(toKey("reset", token));
  if (!v.value) return null;
  await kv.delete(toKey("reset", token));
  const THIRTY_MIN = 30 * 60 * 1000;
  if (now() - v.value.createdAt > THIRTY_MIN) return null;
  return v.value;
}

/* ─────────────────────── Helpers: time & grid ─────────────────────── */

function toMinutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const h = Number(m[1]), mi = Number(m[2]);
  return h * 60 + mi;
}

function fromMinutes(total: number): string {
  // הגנה: נשארים בטווח היום (00:00..23:59) וללא "24:45"
  const t = Math.max(0, Math.min(1439, Math.trunc(total)));
  const h = Math.floor(t / 60).toString().padStart(2, "0");
  const mi = (t % 60).toString().padStart(2, "0");
  return `${h}:${mi}`;
}

/** שואב מטה לגריד הקרוב (למשל ל־15 דקות) */
function snapToGrid(mins: number, step: number): number {
  return Math.floor(mins / step) * step;
}

/** פרסינג מקומי בטוח ל-YYYY-MM-DD → Date ב-00:00 בזמן מקומי */
function parseLocalYMD(dateISO: string): Date | null {
  const m = String(dateISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mon = Number(m[2]) - 1, d = Number(m[3]);
  const dt = new Date(y, mon, d, 0, 0, 0, 0); // מקומי, לא UTC
  if (dt.getFullYear() !== y || dt.getMonth() !== mon || dt.getDate() !== d) return null;
  return dt;
}

/* ─────────────── דיפולטים + שעות פתיחה ─────────────── */

function coerceRestaurantDefaults(r: Restaurant): Restaurant {
  const step = (r.slotIntervalMinutes && r.slotIntervalMinutes > 0) ? r.slotIntervalMinutes : 15;
  const span = (r.serviceDurationMinutes && r.serviceDurationMinutes > 0) ? r.serviceDurationMinutes : 120;
  const capacity = (typeof r.capacity === "number" && r.capacity > 0) ? r.capacity : 30;
  return { ...r, slotIntervalMinutes: step, serviceDurationMinutes: span, capacity };
}

/** מחזיר מערך טווחי פתיחה [start,end] בדקות לאותו יום לפי weeklySchedule (אם קיים) — לפי התאריך שהלקוח ביקש */
function openingRangesForDate(r: Restaurant, date: string): Array<[number, number]> {
  const weekly: any = r.weeklySchedule ?? (r as any).openingHours ?? null;
  if (!weekly) return []; // אין מגבלה → פתוח כל היום (handled by caller)

  // ✅ תאריך מקומי (לא new Date("YYYY-MM-DD") שעלול להתפרש כ-UTC)
  const d = parseLocalYMD(date);
  if (!d) return [];

  // JS getDay: 0=Sunday..6=Saturday — תואם למפתחות 0..6 שלנו
  const dow = d.getDay() as DayOfWeek;

  const def = weekly[dow] ?? weekly[String(dow)] ?? null;
  if (!def) return []; // אין מפתח מפורש → פתוח כל היום (כמו בדרישת ברירת המחדל)

  const toMin = (hhmm: string) => {
    const m = hhmm?.match?.(/^(\d{2}):(\d{2})$/);
    if (!m) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const start = toMin((def as any).open ?? (def as any).start ?? "");
  const end   = toMin((def as any).close ?? (def as any).end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

  if (end <= start) {
    // קלט בעייתי: לא נקרוס — נאפשר עד סוף היום
    return [[start, 24*60 - 1]];
  }
  return [[start, end]];
}

function isWithinOpening(r: Restaurant, date: string, startMin: number, span: number): boolean {
  const ranges = openingRangesForDate(r, date);
  if (!ranges.length) return true; // אין מגבלה = פתוח כל היום
  const end = startMin + span;
  for (const [a,b] of ranges) {
    if (startMin >= a && end <= b) return true;
  }
  return false;
}

// מחזיר חלונות פתיחה כתווים {open, close} ליום נתון.
// אם אין מגבלה באותו יום (אין מפתח מפורש) – ברירת המחדל: פתוח כל היום.

export function openingWindowsForDate(
  r: Restaurant,
  dateISO: string,
): Array<{ open: string; close: string }> {
  const weekly: any = r.weeklySchedule ?? (r as any).openingHours ?? null;

  // אין כל מגבלה → פתוח כל היום
  if (!weekly) return [{ open: "00:00", close: "24:00" }];

  // פרסינג מקומי בטוח
  const m = String(dateISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [{ open: "00:00", close: "24:00" }];
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (isNaN(d.getTime())) return [{ open: "00:00", close: "24:00" }];

  const dow = d.getDay() as DayOfWeek;
  const keyNum = dow as any;
  const keyStr = String(dow);

  const hasNum = Object.prototype.hasOwnProperty.call(weekly, keyNum);
  const hasStr = Object.prototype.hasOwnProperty.call(weekly, keyStr);
  const hasKey = hasNum || hasStr;

  const def = hasNum ? weekly[keyNum] : (hasStr ? weekly[keyStr] : null);

  // מפתח קיים והערך null → סגור
  if (hasKey && (def == null)) return [];

  // מפתח לא קיים → פתוח כל היום (fallback)
  if (!hasKey) return [{ open: "00:00", close: "24:00" }];

  // יש הגדרה לאותו יום → לקרוא open/close
  const open = String(def.open ?? def.start ?? "");
  const close = String(def.close ?? def.end ?? "");
  const toMin = (hhmm: string) => {
    const mm = hhmm.match(/^(\d{2}):(\d{2})$/);
    return mm ? Number(mm[1]) * 60 + Number(mm[2]) : NaN;
  };
  const s = toMin(open), e = toMin(close);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return [];

  // סוף לפני התחלה → חתוך עד סוף היום
  if (e <= s) return [{ open, close: "23:59" }];

  return [{ open, close }];
}



/* ─────────────────── Restaurants / Reservations ─────────────────── */

export async function createRestaurant(r: {
  id: string; ownerId: string; name: string; city: string; address: string;
  phone?: string; hours?: string; description?: string;
  menu?: Array<{ name: string; price?: number; desc?: string }>;
  capacity?: number; slotIntervalMinutes?: number; serviceDurationMinutes?: number;
  weeklySchedule?: WeeklySchedule; photos?: string[]; approved?: boolean;
}): Promise<Restaurant> {
  const restaurant: Restaurant = {
    ...r,
    name: r.name.trim(),
    city: r.city.trim(),
    address: r.address.trim(),
    menu: r.menu ?? [],
    photos: (r.photos ?? []).filter(Boolean),
    capacity: r.capacity ?? 30,
    slotIntervalMinutes: r.slotIntervalMinutes ?? 15,
    serviceDurationMinutes: r.serviceDurationMinutes ?? 120,
    weeklySchedule: r.weeklySchedule,
    approved: !!r.approved,
    createdAt: now(),
  };

  const tx = kv.atomic()
    .set(toKey("restaurant", restaurant.id), restaurant)
    .set(toKey("restaurant_by_owner", restaurant.ownerId, restaurant.id), 1)
    .set(toKey("restaurant_name", lower(restaurant.name), restaurant.id), 1)
    .set(toKey("restaurant_city", lower(restaurant.city), restaurant.id), 1);

  const res = await tx.commit();
  if (!res.ok) throw new Error("create_restaurant_race");
  return restaurant;
}

export async function updateRestaurant(id: string, patch: Partial<Restaurant>) {
  const cur = await kv.get<Restaurant>(toKey("restaurant", id));
  const prev = cur.value;
  if (!prev) return null;

  function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }

  const next: Restaurant = {
    ...prev,
    // אל תדרוס שדות שלא הגיעו
    capacity: patch.capacity !== undefined ? patch.capacity : prev.capacity,
    slotIntervalMinutes: patch.slotIntervalMinutes !== undefined ? patch.slotIntervalMinutes : prev.slotIntervalMinutes,
    weeklySchedule: patch.weeklySchedule !== undefined ? patch.weeklySchedule : prev.weeklySchedule,

    // שדות טקסט — שמירה עם trim
    name: (patch.name ?? prev.name).trim(),
    city: (patch.city ?? prev.city).trim(),
    address: (patch.address ?? prev.address).trim(),

    // שדות נוספים
    photos: (patch.photos ?? prev.photos ?? []).filter(Boolean),

    // פריסות נוספות (אם יש) מתוך patch/prev:
    ...patch, // (נשאיר בסוף, אך הוא לא ידרוס כי כבר קבענו למעלה את העיקריים)
  };

  const tx = kv.atomic().set(toKey("restaurant", id), next);

  if (patch.name && lower(patch.name) !== lower(prev.name)) {
    tx.delete(toKey("restaurant_name", lower(prev.name), id))
      .set(toKey("restaurant_name", lower(patch.name), id), 1);
  }
  if (patch.city && lower(patch.city) !== lower(prev.city)) {
    tx.delete(toKey("restaurant_city", lower(prev.city), id))
      .set(toKey("restaurant_city", lower(patch.city), id), 1);
  }

  const res = await tx.commit();
  if (!res.ok) throw new Error("update_restaurant_race");

  console.log("[DB] updateRestaurant saved:", {
    id,
    weeklySchedule: next.weeklySchedule,
    capacity: next.capacity,
    slotIntervalMinutes: next.slotIntervalMinutes,
  });

  return next;
}

export async function getRestaurant(id: string) {
  return (await kv.get<Restaurant>(toKey("restaurant", id))).value ?? null;
}

export async function listRestaurants(q?: string, onlyApproved = true): Promise<Restaurant[]> {
  const out = new Map<string, Restaurant>();
  const needle = lower(q ?? "");
  const push = (r?: Restaurant | null) => {
    if (!r) return;
    if (onlyApproved && !r.approved) return;
    out.set(r.id, r);
  };

  if (!needle) {
    const items: Restaurant[] = [];
    for await (const row of kv.list({ prefix: toKey("restaurant") })) {
      const r = (await kv.get<Restaurant>(row.key as any)).value;
      if (r && (!onlyApproved || r.approved)) items.push(r);
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, 50);
  }

  for await (const k of kv.list({ prefix: toKey("restaurant_name", needle) })) {
    const id = k.key[k.key.length - 1] as string;
    push((await kv.get<Restaurant>(toKey("restaurant", id))).value);
  }
  for await (const k of kv.list({ prefix: toKey("restaurant_city", needle) })) {
    const id = k.key[k.key.length - 1] as string;
    push((await kv.get<Restaurant>(toKey("restaurant", id))).value);
  }

  // Fallback לסריקה מלאה (מכיל גם כתובת)
  for await (const row of kv.list({ prefix: toKey("restaurant") })) {
    const r = (await kv.get<Restaurant>(row.key as any)).value;
    if (!r) continue;
    const hay = `${lower(r.name)} ${lower(r.city)} ${lower(r.address)}`;
    if (hay.includes(needle)) push(r);
  }

  return Array.from(out.values()).sort((a, b) => {
    const aName = lower(a.name).indexOf(needle);
    const bName = lower(b.name).indexOf(needle);
    if (aName !== bName) return (aName === -1 ? 1 : aName) - (bName === -1 ? 1 : bName);
    const aCity = lower(a.city).indexOf(needle);
    const bCity = lower(b.city).indexOf(needle);
    if (aCity !== bCity) return (aCity === -1 ? 1 : aCity) - (bCity === -1 ? 1 : bCity);
    return b.createdAt - a.createdAt;
  });
}

/* ─────────────── NEW: Photos API (מחבר בין העלאות הבעלים לבין restaurant.photos) ─────────────── */

/**
 * מחזיר את מערך התמונות של המסעדה.
 * כרגע אנחנו שומרים ישירות ב-restaurant.photos, לכן פשוט קורא מהמסעדה.
 * אם בעתיד תרצה לעבור לטבלת owner_photos, כאן המקום לשנות מימוש.
 */
export async function listOwnerPhotosByRestaurant(restaurantId: string): Promise<string[]> {
  const r = await getRestaurant(restaurantId);
  if (!r) return [];
  return Array.isArray(r.photos) ? r.photos.filter(Boolean).map(String) : [];
}

/** קובע מערך תמונות מלא למסעדה (מחליף את הקיים) */
export async function setRestaurantPhotos(restaurantId: string, photos: string[]): Promise<void> {
  const r = await getRestaurant(restaurantId);
  if (!r) return;
  await updateRestaurant(restaurantId, { photos: (photos ?? []).filter(Boolean) });
}

/** מוסיף תמונה אחת למסעדה (dataURL או URL חיצוני) לסוף המערך */
export async function addOwnerPhoto(restaurantId: string, dataURL: string): Promise<void> {
  const r = await getRestaurant(restaurantId);
  if (!r) return;
  const cur = Array.isArray(r.photos) ? r.photos.slice() : [];
  cur.push(String(dataURL));
  await updateRestaurant(restaurantId, { photos: cur });
}

/* ─────────────── Reservations, occupancy & availability ─────────────── */

export async function listReservationsFor(restaurantId: string, date: string): Promise<Reservation[]> {
  const out: Reservation[] = [];
  for await (const row of kv.list({ prefix: toKey("reservation_by_day", restaurantId, date) })) {
    const id = row.key[row.key.length - 1] as string;
    const r = (await kv.get<Reservation>(toKey("reservation", id))).value;
    if (r) out.push(r);
  }
  out.sort((a, b) => (a.time).localeCompare(b.time));
  return out;
}

export async function createReservation(r: Reservation) {
  const tx = kv.atomic()
    .set(toKey("reservation", r.id), r)
    .set(toKey("reservation_by_day", r.restaurantId, r.date, r.id), 1);
  const res = await tx.commit();
  if (!res.ok) throw new Error("create_reservation_race");
  return r;
}

export async function listReservationsByOwner(ownerId: string) {
  const my: { id: string; name: string }[] = [];
  for await (const k of kv.list({ prefix: toKey("restaurant_by_owner", ownerId) })) {
    const rid = k.key[k.key.length - 1] as string;
    const r = (await kv.get<Restaurant>(toKey("restaurant", rid))).value;
    if (r) my.push({ id: r.id, name: r.name });
  }

  const results: Array<{ restaurantName: string; reservation: Reservation }> = [];
  for (const r of my) {
    for await (const k of kv.list({ prefix: toKey("reservation_by_day", r.id) })) {
      const id = k.key[k.key.length - 1] as string;
      const resv = (await kv.get<Reservation>(toKey("reservation", id))).value;
      if (resv) results.push({ restaurantName: r.name, reservation: resv });
    }
  }

  results.sort((a, b) =>
    (a.reservation.date + a.reservation.time).localeCompare(b.reservation.date + b.reservation.time),
  );

  return results.slice(0, 200);
}

export async function computeOccupancy(restaurant: Restaurant, date: string) {
  const r = coerceRestaurantDefaults(restaurant);
  const resv = await listReservationsFor(r.id, date);
  const map = new Map<string, number>(); // time -> used seats

  const step = r.slotIntervalMinutes;
  const span = r.serviceDurationMinutes;

  for (const rr of resv) {
    const start = snapToGrid(toMinutes(rr.time), step);
    const end = start + span;
    for (let t = start; t < end; t += step) {
      const key = fromMinutes(t);
      map.set(key, (map.get(key) ?? 0) + rr.people);
    }
  }
  return map;
}

/** בדיקת זמינות ל-slot (מיושר לגריד) */
export async function checkAvailability(restaurantId: string, date: string, time: string, people: number) {
  const r0 = await getRestaurant(restaurantId);
  if (!r0) return { ok: false, reason: "not_found" as const };
  const r = coerceRestaurantDefaults(r0);

  const seats = Math.max(1, Number.isFinite(people) ? people : 2);
  if (seats > r.capacity) return { ok: false as const, reason: "full" as const };

  const startRaw = toMinutes(time);
  if (!Number.isFinite(startRaw)) return { ok: false as const, reason: "bad_time" as const };

  const step = r.slotIntervalMinutes;
  const span = r.serviceDurationMinutes;
  const start = snapToGrid(startRaw, step);
  const end = start + span;

  if (end > 24 * 60) return { ok: false as const, reason: "out_of_day" as const };

  // ✅ לפי התאריך שהלקוח בחר
  if (!isWithinOpening(r, date, start, span)) {
    return { ok: false as const, reason: "closed" as const };
  }

  const occ = await computeOccupancy(r, date);
  for (let t = start; t < end; t += step) {
    const used = occ.get(fromMinutes(t)) ?? 0;
    if (used + seats > r.capacity) return { ok: false, reason: "full" as const };
  }
  return { ok: true as const };
}

/** סלוטים זמינים סביב שעה נתונה (±windowMinutes), מיושרים לגריד, בטווח היום בלבד. */
export async function listAvailableSlotsAround(
  restaurantId: string,
  date: string,
  centerTime: string,
  people: number,
  windowMinutes = 120,
  maxSlots = 16,
): Promise<string[]> {
  const r0 = await getRestaurant(restaurantId);
  if (!r0) return [];
  const r = coerceRestaurantDefaults(r0);

  const step = r.slotIntervalMinutes;
  const span = r.serviceDurationMinutes;
  const capacity = r.capacity;

  let base = toMinutes(centerTime);
  if (!Number.isFinite(base)) return [];

  base = snapToGrid(Math.max(0, Math.min(1439, base)), step);

  const occ = await computeOccupancy(r, date);
  const startWin = Math.max(0, base - windowMinutes);
  const endWin = Math.min(1439, base + windowMinutes);

  const tryTime = (t: number) => {
    if (t < 0 || t + span > 24 * 60) return false;
    // ✅ לפי התאריך שהלקוח בחר
    if (!isWithinOpening(r, date, t, span)) return false;
    for (let x = t; x < t + span; x += step) {
      const used = occ.get(fromMinutes(x)) ?? 0;
      if (used + people > capacity) return false;
    }
    return true;
  };

  const found = new Set<string>();
  for (let delta = 0; ; delta += step) {
    let pushed = false;
    const before = snapToGrid(base - delta, step);
    const after  = snapToGrid(base + delta, step);

    if (before >= startWin && tryTime(before)) { found.add(fromMinutes(before)); pushed = true; }
    if (after <= endWin && tryTime(after))  { found.add(fromMinutes(after));  pushed = true; }

    if (found.size >= maxSlots) break;
    if (!pushed && (before < startWin && after > endWin)) break;
    if (delta > windowMinutes) break;
  }

  const out = Array.from(found.values());
  out.sort((a, b) => {
    const da = Math.abs(toMinutes(a) - base);
    const db = Math.abs(toMinutes(b) - base);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  return out.slice(0, Math.min(maxSlots, 4));
}

/* ───────────────────────── Admin Utilities ───────────────────────── */

export async function deleteRestaurantCascade(restaurantId: string): Promise<number> {
  const r = await getRestaurant(restaurantId);
  if (!r) return 0;

  const reservationIds: string[] = [];
  for await (const k of kv.list({ prefix: toKey("reservation_by_day", restaurantId) })) {
    const id = k.key[k.key.length - 1] as string;
    reservationIds.push(id);
  }

  // מחיקה במנות
  const chunk = <T>(arr: T[], size: number) =>
    arr.reduce<T[][]>((acc, v, i) => {
      if (i % size === 0) acc.push([]);
      acc[acc.length - 1].push(v);
      return acc;
    }, []);

  let deleted = 0;
  for (const ids of chunk(reservationIds, 50)) {
    const tx = kv.atomic();
    for (const id of ids) {
      const resv = (await kv.get<Reservation>(toKey("reservation", id))).value;
      if (resv) {
        tx.delete(toKey("reservation", id));
        tx.delete(toKey("reservation_by_day", restaurantId, resv.date, id));
        deleted++;
      } else {
        tx.delete(toKey("reservation", id));
      }
    }
    await tx.commit().catch(() => {});
  }

  const tx2 = kv.atomic()
    .delete(toKey("restaurant", restaurantId))
    .delete(toKey("restaurant_by_owner", r.ownerId, restaurantId))
    .delete(toKey("restaurant_name", lower(r.name), restaurantId))
    .delete(toKey("restaurant_city", lower(r.city), restaurantId));
  await tx2.commit().catch(() => {});

  return deleted;
}

/* ──────────────────────────── Admin reset ─────────────────────────── */

export async function resetReservations(): Promise<{ deleted: number }> {
  let deleted = 0;
  for await (const e of kv.list({ prefix: toKey("reservation") })) {
    await kv.delete(e.key);
    deleted++;
  }
  for await (const e of kv.list({ prefix: toKey("reservation_by_day") })) {
    await kv.delete(e.key);
  }
  return { deleted };
}

export async function resetRestaurants(): Promise<{ restaurants: number; reservations: number }> {
  const ids: string[] = [];
  for await (const e of kv.list({ prefix: toKey("restaurant") })) {
    const rid = e.key[e.key.length - 1] as string;
    ids.push(rid);
  }
  let resDeleted = 0;
  for (const rid of ids) {
    resDeleted += await deleteRestaurantCascade(rid);
  }
  return { restaurants: ids.length, reservations: resDeleted };
}

export async function resetUsers(): Promise<{ users: number }> {
  let users = 0;
  for await (const e of kv.list({ prefix: toKey("user") })) {
    await kv.delete(e.key);
    users++;
  }
  for await (const e of kv.list({ prefix: toKey("user_by_email") })) await kv.delete(e.key);
  for await (const e of kv.list({ prefix: toKey("user_by_username") })) await kv.delete(e.key);
  for await (const e of kv.list({ prefix: toKey("verify") })) await kv.delete(e.key);
  for await (const e of kv.list({ prefix: toKey("reset") })) await kv.delete(e.key);
  return { users };
}

export async function resetAll(): Promise<void> {
  const prefixes: Deno.KvKey[] = [
    toKey("user"),
    toKey("user_by_email"),
    toKey("user_by_username"),
    toKey("verify"),
    toKey("reset"),
    toKey("restaurant"),
    toKey("restaurant_by_owner"),
    toKey("restaurant_name"),
    toKey("restaurant_city"),
    toKey("reservation"),
    toKey("reservation_by_day"),
  ];

  async function deleteByPrefix(prefix: Deno.KvKey, batchSize = 100) {
    const keys: Deno.KvKey[] = [];
    for await (const e of kv.list({ prefix })) {
      keys.push(e.key);
      if (keys.length >= batchSize) {
        const tx = kv.atomic();
        for (const k of keys) tx.delete(k);
        await tx.commit().catch(() => {});
        keys.length = 0;
      }
    }
    if (keys.length) {
      const tx = kv.atomic();
      for (const k of keys) tx.delete(k);
      await tx.commit().catch(() => {});
    }
  }

  for (const p of prefixes) await deleteByPrefix(p);
}

/* אופציונלי — מתקנת רשומות ישנות עם capacity/step/span לא תקינים */
export async function fixRestaurantsDefaults(): Promise<number> {
  let changed = 0;
  for await (const row of kv.list({ prefix: toKey("restaurant") })) {
    const id = row.key[row.key.length - 1] as string;
    const cur = (await kv.get<Restaurant>(toKey("restaurant", id))).value;
    if (!cur) continue;
    const r = coerceRestaurantDefaults(cur);
    if (r.capacity !== cur.capacity ||
        r.slotIntervalMinutes !== cur.slotIntervalMinutes ||
        r.serviceDurationMinutes !== cur.serviceDurationMinutes) {
      await kv.set(toKey("restaurant", id), r);
      changed++;
    }
  }
  return changed;
}

/* ─────────────────────── NEW: Hours updaters & normalizers ─────────────────────── */

function normHHmm(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // 8:00 -> 08:00 ; 08.30 -> 08:30 ; AM/PM -> 24h
  if (/^\d{1,2}\.\d{2}(\s*[ap]m)?$/i.test(s)) s = s.replace(".", ":");
  const ampm = s.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
  if (ampm) {
    let h = Math.max(0, Math.min(12, Number(ampm[1])));
    const mi = Math.max(0, Math.min(59, Number(ampm[2])));
    const isPM = /pm/i.test(ampm[3]);
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;
  }
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) s = `${iso[1]}:${iso[2]}`;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mi = Math.max(0, Math.min(59, Number(m[2])));
  return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;
}

/** ממיר אובייקט "0..6" או 0..6 עם {open,close}|null ל־WeeklySchedule טיפוסי */
function normalizeWeeklySchedule(anyHours: any): WeeklySchedule {
  const out: WeeklySchedule = {};
  for (let d = 0 as DayOfWeek; d <= 6; d = (d + 1) as DayOfWeek) {
    const row = (anyHours?.[d] ?? anyHours?.[String(d)] ?? null) as any;
    if (!row) { out[d] = null; continue; }
    const open  = normHHmm(row.open ?? row.start);
    const close = normHHmm(row.close ?? row.end);
    out[d] = (open && close) ? { open, close } : null;
  }
  return out;
}

/**
 * עדכון שעות פתיחה (+ אופציונלי: slotIntervalMinutes, capacity)
 * תואם חתימות שהקוד בצד ה־router עלול לקרוא.
 */
export async function updateRestaurantHours(
  id: string,
  hours: WeeklySchedule | Record<string, OpeningWindow | null>,
  slotIntervalMinutes?: number,
  capacity?: number,
) {
  const current = await getRestaurant(id);
  if (!current) return null;

  const weekly = normalizeWeeklySchedule(hours);

  const patch: Partial<Restaurant> = {
    weeklySchedule: weekly,
  };

  if (Number.isFinite(slotIntervalMinutes as number)) {
    patch.slotIntervalMinutes = Math.max(5, (slotIntervalMinutes as number));
  }
  if (Number.isFinite(capacity as number)) {
    patch.capacity = Math.max(1, (capacity as number));
  }

  // לשמירה על תאימות לאזכורים ישנים
  // @ts-ignore
  (patch as any).openingHours = weekly;
  // @ts-ignore
  (patch as any).hours = (current.hours ?? "");

  return await updateRestaurant(id, patch);
}

/** שם חלופי נפוץ */
export const setRestaurantOpeningHours = updateRestaurantHours;
