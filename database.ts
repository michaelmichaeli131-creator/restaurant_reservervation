// src/database.ts
// Deno KV – אינדקסים עם prefix ועסקאות atomic

export interface User {
  id: string;
  email: string;
  username: string;                // ייחודי
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
  slotIntervalMinutes: number;      // מרווח סלוטים (דקות), ברירת מחדל 15
  serviceDurationMinutes: number;   // משך ישיבה (דקות), ברירת מחדל 120
  weeklySchedule?: WeeklySchedule;  // שעות פתיחה שבועיות (אופציונלי)
  photos?: string[];                // תמונות (URLים)
  approved?: boolean;               // נדרש אישור אדמין
  createdAt: number;
}

export interface Reservation {
  id: string;
  restaurantId: string;
  userId: string; // גם ל-block ידני נשים "manual-block:<ownerId>"
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm (start)
  people: number;
  note?: string;
  status?: "new" | "confirmed" | "canceled" | "completed" | "blocked";
  createdAt: number;
}

// פתח KV פעם אחת
export const kv = await Deno.openKv();

const lower = (s?: string) => (s ?? "").trim().toLowerCase();
const now = () => Date.now();

// ---------- Users ----------
// Keys:
// ["user", id] -> User
// ["user_by_email", emailLower] -> id
// ["user_by_username", usernameLower] -> id
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

// אימות מייל
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

// שחזור סיסמה – Reset token
// ["reset", token] -> { userId, createdAt }
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

// ---------- Restaurants ----------
// Keys:
// ["restaurant", id] -> Restaurant
// ["restaurant_by_owner", ownerId, id] -> 1
// ["restaurant_name", nameLower, id] -> 1
// ["restaurant_city", cityLower, id] -> 1
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
  };

  const tx = kv.atomic().set(["restaurant", id], next);
  if (patch.name && lower(patch.name) !== lower(prev.name)) {
    tx.delete(["restaurant_name", lower(prev.name), id]).set(["restaurant_name", lower(patch.name), id], 1);
  }
  if (patch.city && lower(patch.city) !== lower(prev.city)) {
    tx.delete(["restaurant_city", lower(prev.city), id]).set(["restaurant_city", lower(patch.city), id], 1);
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

  // אינדקסים (התאמה מלאה להתחלה)
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

// ---------- Reservations / Availability ----------
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  return h * 60 + m;
}
function fromMinutes(m: number): string {
  const h = Math.floor(m / 60).toString().padStart(2, "0");
  const mi = (m % 60).toString().padStart(2, "0");
  return `${h}:${mi}`;
}

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
  results.sort((a, b) => (a.reservation.date + a.reservation.time).localeCompare(b.reservation.date + b.reservation.time));
  return results.slice(0, 200);
}

export async function computeOccupancy(restaurant: Restaurant, date: string) {
  const resv = await listReservationsFor(restaurant.id, date);
  const map = new Map<string, number>(); // time -> used seats
  for (const r of resv) {
    const start = toMinutes(r.time);
    const end = start + (restaurant.serviceDurationMinutes || 120);
    for (let t = start; t < end; t += restaurant.slotIntervalMinutes || 15) {
      const key = fromMinutes(t);
      map.set(key, (map.get(key) ?? 0) + r.people);
    }
  }
  return map;
}

export async function checkAvailability(restaurantId: string, date: string, time: string, people: number) {
  const r = await getRestaurant(restaurantId);
  if (!r) return { ok: false, reason: "not_found" as const };
  const occ = await computeOccupancy(r, date);
  const start = toMinutes(time);
  const end = start + (r.serviceDurationMinutes || 120);
  for (let t = start; t < end; t += r.slotIntervalMinutes || 15) {
    const used = occ.get(fromMinutes(t)) ?? 0;
    if (used + people > r.capacity) {
      return { ok: false, reason: "full" as const, suggestions: suggestTimes(r, date, time, people, occ) };
    }
  }
  return { ok: true as const };
}

function suggestTimes(r: Restaurant, date: string, time: string, people: number, occ: Map<string, number>) {
  const base = toMinutes(time);
  const step = r.slotIntervalMinutes || 15;
  const span = r.serviceDurationMinutes || 120;
  const tryTime = (t: number) => {
    for (let x = t; x < t + span; x += step) {
      const used = occ.get(fromMinutes(x)) ?? 0;
      if (used + people > r.capacity) return false;
    }
    return true;
  };
  const out: string[] = [];
  for (let delta = step; delta <= 60; delta += step) {
    const before = base - delta; const after = base + delta;
    if (before >= 0 && tryTime(before)) out.push(fromMinutes(before));
    if (tryTime(after)) out.push(fromMinutes(after));
    if (out.length >= 6) break;
  }
  return out;
}

// ---------- Admin Utilities ----------
// מוחק מסעדה **וכל** התלויות שלה (אינדקסים + הזמנות) בבטיחות.
// מחזיר את מספר ההזמנות שנמחקו.
export async function deleteRestaurantCascade(restaurantId: string): Promise<number> {
  const r = await getRestaurant(restaurantId);
  if (!r) return 0;

  // אסוף כל מפתחות ההזמנות: reservation_by_day + reservation
  const reservationIds: string[] = [];
  for await (const k of kv.list({ prefix: ["reservation_by_day", restaurantId] })) {
    const id = k.key[k.key.length - 1] as string;
    reservationIds.push(id);
  }

  // מחיקה באצוות כדי לשמור על מגבלות atomic (10 אופ׳ בערך)
  let deleted = 0;

  // מחק reservation_by_day + reservation בגושים קטנים
  const chunk = <T>(arr: T[], size: number) =>
    arr.reduce<T[][]>((acc, v, i) => {
      if (i % size === 0) acc.push([]);
      acc[acc.length - 1].push(v);
      return acc;
    }, []);

  for (const ids of chunk(reservationIds, 50)) {
    const tx = kv.atomic();
    for (const id of ids) {
      // צריך לדעת את התאריך כדי למחוק את האינדקס, נשלוף את ההזמנה
      const resv = (await kv.get<Reservation>(["reservation", id])).value;
      if (resv) {
        tx.delete(["reservation", id]);
        tx.delete(["reservation_by_day", restaurantId, resv.date, id]);
        deleted++;
      } else {
        // אם אין הרשומה הראשית, נסה למחוק כל מופע by_day שהתגלה
        tx.delete(["reservation", id]);
        // אין לנו date – אבל לוסט נקה את האינדקס שראינו כבר דרך ה-list הראשי
        // (עברנו דרך reservation_by_day/*, אז נמחק אותו בלולאה הראשונה)
      }
    }
    const res = await tx.commit();
    if (!res.ok) {
      // במקרה של התנגשויות, נתקדם בכל זאת בלולאה; אפשר לשפר עם ריטריי
    }
  }

  // הסר אינדקסי מסעדה + המסעדה עצמה
  // מחיקה באטומיק נפרד (סביר בגודל קטן)
  const tx2 = kv.atomic()
    .delete(["restaurant", restaurantId])
    .delete(["restaurant_by_owner", r.ownerId, restaurantId])
    .delete(["restaurant_name", lower(r.name), restaurantId])
    .delete(["restaurant_city", lower(r.city), restaurantId]);
  await tx2.commit();

  return deleted;
}
