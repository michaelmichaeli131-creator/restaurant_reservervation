// src/database.ts
// Deno KV – אינדקסים עם prefix ועסקאות atomic

export interface User {
  id: string;
  email: string;
  passwordHash?: string;
  role: "user" | "owner";
  provider: "local" | "google";
  emailVerified?: boolean;             // אימות מייל
  createdAt: number;
}

export type DayOfWeek = 0|1|2|3|4|5|6; // 0=Sunday .. 6=Saturday
export interface OpeningWindow { open: string; close: string; }
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
export async function createUser(u: {
  id: string; email: string; passwordHash?: string; role: "user" | "owner"; provider: "local" | "google";
}): Promise<User> {
  const user: User = { ...u, email: lower(u.email), emailVerified: false, createdAt: now() };
  const tx = kv.atomic()
    .check({ key: ["user_by_email", user.email], versionstamp: null })
    .set(["user", user.id], user)
    .set(["user_by_email", user.email], user.id);
  const res = await tx.commit();
  if (!res.ok) throw new Error("email_used");
  return user;
}
export async function findUserByEmail(email: string) {
  const ref = await kv.get<string>(["user_by_email", lower(email)]);
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
export async function updateUserRole(id: string, role: User["role"]) {
  const cur = await kv.get<User>(["user", id]);
  if (!cur.value) return null;
  const next = { ...cur.value, role };
  await kv.set(["user", id], next);
  return next;
}

// ---------- Email Verification ----------
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
  weeklySchedule?: WeeklySchedule; approved?: boolean;
}): Promise<Restaurant> {
  const restaurant: Restaurant = {
    ...r,
    name: r.name.trim(),
    city: r.city.trim(),
    address: r.address.trim(),
    menu: r.menu ?? [],
    capacity: r.capacity ?? 30,
    slotIntervalMinutes: r.slotIntervalMinutes ?? 15,
    serviceDurationMinutes: r.serviceDurationMinutes ?? 120,
    weeklySchedule: r.weeklySchedule,
    approved: !!r.approved, // ברירת מחדל false
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
export async function getRestaurant(id: string) {
  return (await kv.get<Restaurant>(["restaurant", id])).value ?? null;
}
export async function updateRestaurant(
  id: string,
  patch: Partial<Omit<Restaurant, "id"|"ownerId"|"createdAt">>,
) {
  const cur = await kv.get<Restaurant>(["restaurant", id]);
  if (!cur.value) return null;
  const prev = cur.value;
  const next: Restaurant = { ...prev, ...patch };
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
export async function listRestaurants(q?: string, onlyApproved = true): Promise<Restaurant[]> {
  const out = new Map<string, Restaurant>();
  const needle = lower(q);
  async function push(r?: Restaurant | null) {
    if (!r) return;
    if (onlyApproved && !r.approved) return;
    out.set(r.id, r);
  }
  async function byIndex(prefix: readonly unknown[]) {
    for await (const e of kv.list({ prefix })) {
      const rid = e.key[e.key.length - 1] as string;
      await push((await kv.get<Restaurant>(["restaurant", rid])).value ?? null);
    }
  }
  if (!needle) {
    for await (const e of kv.list<Restaurant>({ prefix: ["restaurant"] })) {
      await push(e.value as unknown as Restaurant);
    }
  } else {
    await byIndex(["restaurant_name", needle]);
    await byIndex(["restaurant_city", needle]);
    if (out.size < 10) {
      for await (const e of kv.list<Restaurant>({ prefix: ["restaurant"] })) {
        const r = e.value as unknown as Restaurant;
        if (!r) continue;
        const hay = `${r.name} ${r.city} ${r.address}`.toLowerCase();
        if (hay.includes(needle)) await push(r);
        if (out.size > 25) break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Reservations / Blocks ----------
export async function createReservation(r: Reservation) {
  const tx = kv.atomic()
    .set(["reservation", r.id], r)
    .set(["reservation_by_user", r.userId, r.id], 1)
    .set(["reservation_by_restaurant", r.restaurantId, r.id], 1);
  const res = await tx.commit();
  if (!res.ok) throw new Error("reservation_create_race");
  return r;
}
export async function listReservationsByRestaurant(restaurantId: string): Promise<Reservation[]> {
  const out: Reservation[] = [];
  for await (const row of kv.list({ prefix: ["reservation_by_restaurant", restaurantId] })) {
    const id = row.key[row.key.length - 1] as string;
    const r = (await kv.get<Reservation>(["reservation", id])).value;
    if (r) out.push(r);
  }
  out.sort((a, b) => (a.date + " " + a.time).localeCompare(b.date + " " + b.time));
  return out;
}
export async function listReservationsByOwner(ownerId: string) {
  const my: { id: string; name: string }[] = [];
  for await (const k of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = k.key[k.key.length - 1] as string;
    const r = (await kv.get<Restaurant>(["restaurant", rid])).value;
    if (r) my.push({ id: r.id, name: r.name });
  }
  const results: Array<{ restaurantId: string; restaurantName: string; reservation: Reservation }> = [];
  for (const r of my) {
    for await (const row of kv.list({ prefix: ["reservation_by_restaurant", r.id] })) {
      const resid = row.key[row.key.length - 1] as string;
      const resv = (await kv.get<Reservation>(["reservation", resid])).value;
      if (resv) results.push({ restaurantId: r.id, restaurantName: r.name, reservation: resv });
    }
  }
  results.sort((a, b) =>
    (a.reservation.date + " " + a.reservation.time)
      .localeCompare(b.reservation.date + " " + b.reservation.time)
  );
  return results;
}
export async function updateReservationStatus(id: string, status: NonNullable<Reservation["status"]>) {
  const cur = await kv.get<Reservation>(["reservation", id]);
  if (!cur.value) return null;
  const next = { ...cur.value, status };
  await kv.set(["reservation", id], next);
  return next;
}

// ---------- Availability / Capacity ----------
function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map((x) => Number(x));
  return (h * 60) + (m || 0);
}
function fmtHHMM(mins: number): string {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function jsDayOfWeek(dateStr: string): DayOfWeek {
  const d = new Date(dateStr + "T00:00:00");
  return d.getDay() as DayOfWeek;
}

export interface SlotLoad {
  slot: string;      // "HH:mm"
  booked: number;    // כמה אנשים בסלוט (כולל חפיפה של השירות)
  capacity: number;
  free: number;
  percent: number;
}

export function getSlotsForDate(r: Restaurant, date: string): string[] {
  const dow = jsDayOfWeek(date);
  const win = r.weeklySchedule?.[dow] ?? null;
  const open = parseHHMM(win?.open ?? "12:00");
  const close = parseHHMM(win?.close ?? "23:00");
  const step = Math.max(5, r.slotIntervalMinutes || 15);
  const dur = Math.max(15, r.serviceDurationMinutes || 120);
  const slots: string[] = [];
  for (let s = open; s + dur <= close; s += step) slots.push(fmtHHMM(s));
  return slots;
}

export async function computeOccupancy(restaurant: Restaurant, date: string): Promise<SlotLoad[]> {
  const slots = getSlotsForDate(restaurant, date);
  const resvs = (await listReservationsByRestaurant(restaurant.id))
    .filter(r => r.date === date && r.status !== "canceled");

  const dur = Math.max(15, restaurant.serviceDurationMinutes || 120);
  const loads: SlotLoad[] = slots.map(s => ({ slot: s, booked: 0, capacity: restaurant.capacity, free: restaurant.capacity, percent: 0 }));

  for (const r of resvs) {
    const start = parseHHMM(r.time);
    const end = start + dur;
    for (const L of loads) {
      const t = parseHHMM(L.slot);
      if (t >= start && t < end) L.booked += r.people;
    }
  }
  for (const L of loads) {
    L.free = Math.max(0, L.capacity - L.booked);
    L.percent = L.capacity ? Math.min(100, Math.round((L.booked / L.capacity) * 100)) : 0;
  }
  return loads;
}

export interface AvailabilityCheck {
  ok: boolean;
  reason?: "full" | "invalid" | "closed";
  suggestions?: string[];
}

export async function checkAvailability(restaurant: Restaurant, date: string, time: string, people: number): Promise<AvailabilityCheck> {
  if (people <= 0) return { ok: false, reason: "invalid" };
  const slots = getSlotsForDate(restaurant, date);
  if (!slots.includes(time)) return { ok: false, reason: "closed" };

  const dur = Math.max(15, restaurant.serviceDurationMinutes || 120);
  const loads = await computeOccupancy(restaurant, date);

  const wantedStart = parseHHMM(time);
  const overlapped = loads.filter(L => {
    const t = parseHHMM(L.slot);
    return t >= wantedStart && t < wantedStart + dur;
  });

  const can = overlapped.every(L => L.booked + people <= L.capacity);
  if (can) return { ok: true };

  // הצעות קדימה
  const idx = slots.indexOf(time);
  const sugg: string[] = [];
  for (let i = idx + 1; i < slots.length && sugg.length < 12; i++) {
    const sTime = slots[i];
    const sStart = parseHHMM(sTime);
    const span = loads.filter(L => {
      const t = parseHHMM(L.slot);
      return t >= sStart && t < sStart + dur;
    });
    const ok = span.every(L => L.booked + people <= L.capacity);
    if (ok) sugg.push(sTime);
  }
  return { ok: false, reason: "full", suggestions: sugg };
}
