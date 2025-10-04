// src/database.ts
// Deno KV – אינדקסים עם prefix ועסקאות atomic

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
export type WeeklySchedule = Partial<Record<DayOfWeek, OpeningWindow | null>>;

export interface Restaurant {
  id: string;
  ownerId: string;
  name: string;
  city: string;
  address: string;
  phone?: string;
  hours?: string;
  description?: string;
  menu: Array<{ name: string; price?: number; desc?: string }>;
  capacity: number;                 // קיבולת בו־זמנית
  slotIntervalMinutes: number;      // גריד הסלוטים (ברירת מחדל 15 דק׳)
  serviceDurationMinutes: number;   // משך ישיבה (ברירת מחדל 120 דק׳)
  weeklySchedule?: WeeklySchedule;  // אופציונלי – ניתן לממש בהמשך הגבלות פתיחה
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

/* ───────────────────────────── Users ───────────────────────────── */

export async function createUser(u: {
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
}): Promise<User> {
  const user: User = {
    ...u,
    email: lower(u.email),
    username: lower(u.username),
    firstName: u.firstName.trim(),
    lastName: u.lastName.trim(),
    age: u.age,
    businessType: u.businessType?.trim(),
    emailVerified: false,
    createdAt: now(),
  };

  const tx = kv.atomic()
    .check({ key: ["user_by_email", user.email], versionstamp: null })
    .check({ key: ["user_by_username", user.username], versionstamp: null })
    .set(["user", user.id], user)
    .set(["user_by_email", user.email], user.id)
    .set(["user_by_username", user.username], user.id);

  const res = await tx.commit();
  if (!res.ok) throw new Error("user_exists");
  return user;
}

export async function findUserByEmail(email: string) {
  const ref = await kv.get<string>(["user_by_email", lower(email)]);
  if (!ref.value) return null;
  return (await kv.get<User>(["user", ref.value])).value ?? null;
}

export async function findUserByUsername(username: string) {
  const ref = await kv.get<string>(["user_by_username", lower(username)]);
  if (!ref.value) return null;
  return (await kv.get<User>(["user", ref.value])).value ?? null;
}

export async function getUserById(id: string) {
  return (await kv.get<User>(["user", id])).value ?? null;
}

export async function setEmailVerified(userId: string) {
  const cur = await kv.get<User>(["user", userId]);
  if (!cur.value) return null;
  const next = { ...cur.value, emailVerified: true };
  await kv.set(["user", userId], next);
  return next;
}

export async function updateUserPassword(userId: string, passwordHash: string) {
  const cur = await kv.get<User>(["user", userId]);
  if (!cur.value) return null;
  const next = { ...cur.value, passwordHash };
  await kv.set(["user", userId], next);
  return next;
}

/* אימות/שחזור */

export async function createVerifyToken(userId: string, email: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await kv.set(["verify", token], { userId, email, createdAt: now() });
  return token;
}

export async function useVerifyToken(token: string) {
  const v = await kv.get<{ userId: string; email: string; createdAt: number }>(["verify", token]);
  if (!v.value) return null;
  await kv.delete(["verify", token]);
  return v.value;
}

export async function createResetToken(userId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await kv.set(["reset", token], { userId, createdAt: now() });
  return token;
}

export async function useResetToken(token: string) {
  const v = await kv.get<{ userId: string; createdAt: number }>(["reset", token]);
  if (!v.value) return null;
  await kv.delete(["reset", token]);
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

/* ─────────── Opening hours helpers (NEW, לא שוברים כלום) ─────────── */

/** ברירת מחדל: פתוח כל יום 10:00–22:00; שישי־שבת עד 23:00 */
function defaultWeeklySchedule(): WeeklySchedule {
  return {
    0: { open: "10:00", close: "22:00" }, // Sunday
    1: { open: "10:00", close: "22:00" },
    2: { open: "10:00", close: "22:00" },
    3: { open: "10:00", close: "22:00" },
    4: { open: "10:00", close: "22:00" },
    5: { open: "10:00", close: "23:00" },
    6: { open: "10:00", close: "23:00" },
  };
}

/** מחזיר טווח פתיחה בדקות עבור תאריך נתון, או null אם סגור. מטפל גם בחלון שחוצה חצות (נגזר עד סוף היום בלבד). */
function getOpeningRangeForDate(r: Restaurant, date: string): { start: number; end: number } | null {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getDay() as DayOfWeek;

  const ws = (r.weeklySchedule ?? defaultWeeklySchedule());
  const win = ws[dow];

  if (win == null) return null; // סגור
  const open = toMinutes((win.open || "").padStart(5, "0"));
  const close = toMinutes((win.close || "").padStart(5, "0"));
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;

  if (close <= open) {
    // חלון שחוצה חצות → נחתוך עד סוף היום
    return { start: open, end: 24 * 60 };
  }
  return { start: open, end: close };
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
    weeklySchedule: r.weeklySchedule ?? defaultWeeklySchedule(), // ← ברירת מחדל אם לא הוגדר
    approved: !!r.approved,
    createdAt: now(),
  };

  const tx = kv.atomic()
    .set(["restaurant", restaurant.id], restaurant)
    .set(["restaurant_by_owner", restaurant.ownerId, restaurant.id], 1)
    .set(["restaurant_name", lower(restaurant.name), restaurant.id], 1)
    .set(["restaurant_city", lower(restaurant.city), restaurant.id], 1);

  const res = await tx.commit();
  if (!res.ok) throw new Error("create_restaurant_race");
  return restaurant;
}

export async function updateRestaurant(id: string, patch: Partial<Restaurant>) {
  const cur = await kv.get<Restaurant>(["restaurant", id]);
  const prev = cur.value;
  if (!prev) return null;

  const next: Restaurant = {
    ...prev,
    ...patch,
    name: (patch.name ?? prev.name).trim(),
    city: (patch.city ?? prev.city).trim(),
    address: (patch.address ?? prev.address).trim(),
    photos: (patch.photos ?? prev.photos ?? []).filter(Boolean),
    // אם המחזיק הסיר schedule (undefined) — נשאיר את הקיים; אם שם null במפורש לא נשבור, רק נעביר כ-nullים לימים שצוינו
    weeklySchedule: (patch.weeklySchedule ?? prev.weeklySchedule),
  };

  const tx = kv.atomic().set(["restaurant", id], next);
  if (patch.name && lower(patch.name) !== lower(prev.name)) {
    tx.delete(["restaurant_name", lower(prev.name), id])
      .set(["restaurant_name", lower(patch.name), id], 1);
  }
  if (patch.city && lower(patch.city) !== lower(prev.city)) {
    tx.delete(["restaurant_city", lower(prev.city), id])
      .set(["restaurant_city", lower(patch.city), id], 1);
  }
  const res = await tx.commit();
  if (!res.ok) throw new Error("update_restaurant_race");
  return next;
}

export async function getRestaurant(id: string) {
  return (await kv.get<Restaurant>(["restaurant", id])).value ?? null;
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
    for await (const row of kv.list({ prefix: ["restaurant"] })) {
      const r = (await kv.get<Restaurant>(row.key as any)).value;
      if (r && (!onlyApproved || r.approved)) items.push(r);
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, 50);
  }

  for await (const k of kv.list({ prefix: ["restaurant_name", needle] })) {
    const id = k.key[k.key.length - 1] as string;
    push((await kv.get<Restaurant>(["restaurant", id])).value);
  }
  for await (const k of kv.list({ prefix: ["restaurant_city", needle] })) {
    const id = k.key[k.key.length - 1] as string;
    push((await kv.get<Restaurant>(["restaurant", id])).value);
  }

  // Fallback לסריקה מלאה (מכיל גם כתובת)
  for await (const row of kv.list({ prefix: ["restaurant"] })) {
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

/* ─────────────── Reservations, occupancy & availability ─────────────── */

export async function listReservationsFor(restaurantId: string, date: string): Promise<Reservation[]> {
  const out: Reservation[] = [];
  for await (const row of kv.list({ prefix: ["reservation_by_day", restaurantId, date] })) {
    const id = row.key[row.key.length - 1] as string;
    const r = (await kv.get<Reservation>(["reservation", id])).value;
    if (r) out.push(r);
  }
  out.sort((a, b) => (a.time).localeCompare(b.time));
  return out;
}

export async function createReservation(r: Reservation) {
  const tx = kv.atomic()
    .set(["reservation", r.id], r)
    .set(["reservation_by_day", r.restaurantId, r.date, r.id], 1);
  const res = await tx.commit();
  if (!res.ok) throw new Error("create_reservation_race");
  return r;
}

export async function listReservationsByOwner(ownerId: string) {
  const my: { id: string; name: string }[] = [];
  for await (const k of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = k.key[k.key.length - 1] as string;
    const r = (await kv.get<Restaurant>(["restaurant", rid])).value;
    if (r) my.push({ id: r.id, name: r.name });
  }

  const results: Array<{ restaurantName: string; reservation: Reservation }> = [];
  for (const r of my) {
    for await (const k of kv.list({ prefix: ["reservation_by_day", r.id] })) {
      const id = k.key[k.key.length - 1] as string;
      const resv = (await kv.get<Reservation>(["reservation", id])).value;
      if (resv) results.push({ restaurantName: r.name, reservation: resv });
    }
  }

  results.sort((a, b) =>
    (a.reservation.date + a.reservation.time).localeCompare(b.reservation.date + b.reservation.time),
  );

  return results.slice(0, 200);
}

export async function computeOccupancy(restaurant: Restaurant, date: string) {
  const resv = await listReservationsFor(restaurant.id, date);
  const map = new Map<string, number>(); // time -> used seats

  const step = restaurant.slotIntervalMinutes || 15;
  const span = restaurant.serviceDurationMinutes || 120;

  for (const r of resv) {
    const start = snapToGrid(toMinutes(r.time), step);
    const end = start + span;
    for (let t = start; t < end; t += step) {
      const key = fromMinutes(t);
      map.set(key, (map.get(key) ?? 0) + r.people);
    }
  }
  return map;
}

/** בדיקת זמינות ל-slot (מיושר לגריד) + אכיפת שעות פתיחה */
export async function checkAvailability(restaurantId: string, date: string, time: string, people: number) {
  const r = await getRestaurant(restaurantId);
  if (!r) return { ok: false, reason: "not_found" as const };

  const step = r.slotIntervalMinutes || 15;
  const span = r.serviceDurationMinutes || 120;

  // אכיפת שעות פתיחה
  const range = getOpeningRangeForDate(r, date);
  if (!range) return { ok: false, reason: "closed" as const };

  const start = snapToGrid(toMinutes(time), step);
  const end = start + span;

  // חייב להיות כולו בתוך חלון הפתיחה
  if (start < range.start || end > range.end) return { ok: false, reason: "closed" as const };

  const occ = await computeOccupancy(r, date);
  for (let t = start; t < end; t += step) {
    const used = occ.get(fromMinutes(t)) ?? 0;
    if (used + people > r.capacity) return { ok: false, reason: "full" as const };
  }
  return { ok: true as const };
}

/** סלוטים זמינים סביב שעה נתונה (±windowMinutes), מיושרים לגריד, בטווח היום בלבד + אכיפת שעות פתיחה. */
export async function listAvailableSlotsAround(
  restaurantId: string,
  date: string,
  centerTime: string,
  people: number,
  windowMinutes = 120,
  maxSlots = 16,
): Promise<string[]> {
  const r = await getRestaurant(restaurantId);
  if (!r) return [];

  const step = r.slotIntervalMinutes || 15;
  const span = r.serviceDurationMinutes || 120;

  let base = toMinutes(centerTime);
  if (!Number.isFinite(base)) return [];

  // התאמה לגריד ולימיט יומי
  base = snapToGrid(Math.max(0, Math.min(1439, base)), step);

  const range = getOpeningRangeForDate(r, date);
  if (!range) return []; // סגור ביום זה

  const occ = await computeOccupancy(r, date);

  // חלון חיפוש מצומצם לשעות פתיחה (כך ש- slot מלא ייכנס)
  const earliest = Math.max(range.start, base - windowMinutes);
  const latest   = Math.min(range.end - span, base + windowMinutes);
  if (earliest > latest) return [];

  const tryTime = (t: number) => {
    // לא חוצים את היום (אין 24:xx), וחייב כולו להיכנס לחלו"פ
    if (t < 0 || t + span > 24 * 60) return false;
    if (t < range.start || t + span > range.end) return false;
    for (let x = t; x < t + span; x += step) {
      const used = occ.get(fromMinutes(x)) ?? 0;
      if (used + people > r.capacity) return false;
    }
    return true;
  };

  const found = new Set<string>();
  for (let delta = 0; ; delta += step) {
    let pushed = false;
    const before = snapToGrid(base - delta, step);
    const after  = snapToGrid(base + delta, step);

    if (before >= earliest && tryTime(before)) { found.add(fromMinutes(before)); pushed = true; }
    if (after  <= latest   && tryTime(after))  { found.add(fromMinutes(after));  pushed = true; }

    if (found.size >= maxSlots) break;
    if (!pushed && (before < earliest && after > latest)) break;
    if (delta > windowMinutes) break;
  }

  const out = Array.from(found.values());
  out.sort((a, b) => {
    const da = Math.abs(toMinutes(a) - base);
    const db = Math.abs(toMinutes(b) - base);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  // מגביל להצעות קומפקטיות (עד 4) לבקשתך
  return out.slice(0, Math.min(maxSlots, 4));
}

/* ───────────────────────── Admin Utilities ───────────────────────── */

export async function deleteRestaurantCascade(restaurantId: string): Promise<number> {
  const r = await getRestaurant(restaurantId);
  if (!r) return 0;

  const reservationIds: string[] = [];
  for await (const k of kv.list({ prefix: ["reservation_by_day", restaurantId] })) {
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
      const resv = (await kv.get<Reservation>(["reservation", id])).value;
      if (resv) {
        tx.delete(["reservation", id]);
        tx.delete(["reservation_by_day", restaurantId, resv.date, id]);
        deleted++;
      } else {
        tx.delete(["reservation", id]);
      }
    }
    await tx.commit().catch(() => {});
  }

  const tx2 = kv.atomic()
    .delete(["restaurant", restaurantId])
    .delete(["restaurant_by_owner", r.ownerId, restaurantId])
    .delete(["restaurant_name", lower(r.name), restaurantId])
    .delete(["restaurant_city", lower(r.city), restaurantId]);
  await tx2.commit().catch(() => {});

  return deleted;
}

/* ──────────────────────────── Admin reset ─────────────────────────── */

export async function resetReservations(): Promise<{ deleted: number }> {
  let deleted = 0;
  for await (const e of kv.list({ prefix: ["reservation"] })) {
    await kv.delete(e.key);
    deleted++;
  }
  for await (const e of kv.list({ prefix: ["reservation_by_day"] })) {
    await kv.delete(e.key);
  }
  return { deleted };
}

export async function resetRestaurants(): Promise<{ restaurants: number; reservations: number }> {
  const ids: string[] = [];
  for await (const e of kv.list({ prefix: ["restaurant"] })) {
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
  for await (const e of kv.list({ prefix: ["user"] })) {
    await kv.delete(e.key);
    users++;
  }
  for await (const e of kv.list({ prefix: ["user_by_email"] })) await kv.delete(e.key);
  for await (const e of kv.list({ prefix: ["user_by_username"] })) await kv.delete(e.key);
  for await (const e of kv.list({ prefix: ["verify"] })) await kv.delete(e.key);
  for await (const e of kv.list({ prefix: ["reset"] })) await kv.delete(e.key);
  return { users };
}

export async function resetAll(): Promise<void> {
  const prefixes: Deno.KvKey[] = [
    ["user"],
    ["user_by_email"],
    ["user_by_username"],
    ["verify"],
    ["reset"],
    ["restaurant"],
    ["restaurant_by_owner"],
    ["restaurant_name"],
    ["restaurant_city"],
    ["reservation"],
    ["reservation_by_day"],
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
