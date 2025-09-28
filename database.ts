// database.ts
// שימוש ב-Deno KV כמסד נתונים פשוט

export interface User {
  id: string;
  email: string;
  passwordHash?: string; // לפעמים OAUTH
  role: "user" | "owner";
  provider: "local" | "google";
  createdAt: number;
}

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
  createdAt: number;
}

export interface Reservation {
  id: string;
  restaurantId: string;
  userId: string;
  date: string;  // YYYY-MM-DD
  time: string;  // HH:mm
  people: number;
  note?: string;
  createdAt: number;
}

// פתח KV פעם אחת
export const kv = await Deno.openKv();

// ------------------------
// Users
// ------------------------
// keys:
// ["user", id] -> User
// ["user_by_email", email] -> id

export async function createUser(u: {
  id: string;
  email: string;
  passwordHash?: string;
  role: "user" | "owner";
  provider: "local" | "google";
}): Promise<User> {
  const now = Date.now();
  const user: User = { ...u, createdAt: now };
  // ודא שאין כפילות אימייל
  const exists = await kv.get<string>(["user_by_email", user.email]);
  if (exists.value) throw new Error("email_used");

  const tx = kv.atomic()
    .check({ key: ["user_by_email", user.email], versionstamp: null })
    .set(["user", user.id], user)
    .set(["user_by_email", user.email], user.id);

  const ok = await tx.commit();
  if (!ok.ok) throw new Error("user_create_race");

  return user;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const ref = await kv.get<string>(["user_by_email", email]);
  if (!ref.value) return null;
  const u = await kv.get<User>(["user", ref.value]);
  return u.value ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
  const u = await kv.get<User>(["user", id]);
  return u.value ?? null;
}

// ------------------------
// Restaurants
// ------------------------
// keys:
// ["restaurant", id] -> Restaurant
// ["restaurant_by_owner", ownerId, id] -> 1
// ["restaurant_name", nameLower, id] -> 1      (לאינדוקס לחיפוש מהיר)
// ["restaurant_city", cityLower, id] -> 1      (לאינדוקס לפי עיר)
// ניתן להרחיב בעתיד עוד אינדקסים (קטגוריות וכו')

export async function createRestaurant(r: {
  id: string;
  ownerId: string;
  name: string;
  city: string;
  address: string;
  phone?: string;
  hours?: string;
  description?: string;
  menu?: Array<{ name: string; price?: number; desc?: string }>;
}): Promise<Restaurant> {
  const now = Date.now();
  const restaurant: Restaurant = {
    ...r,
    menu: r.menu ?? [],
    createdAt: now,
  };

  const nameKey = ["restaurant_name", restaurant.name.trim().toLowerCase(), restaurant.id] as const;
  const cityKey = ["restaurant_city", restaurant.city.trim().toLowerCase(), restaurant.id] as const;

  const tx = kv.atomic()
    .set(["restaurant", restaurant.id], restaurant)
    .set(["restaurant_by_owner", restaurant.ownerId, restaurant.id], 1)
    .set(nameKey, 1)
    .set(cityKey, 1);

  const ok = await tx.commit();
  if (!ok.ok) throw new Error("create_restaurant_race");

  return restaurant;
}

export async function getRestaurant(id: string): Promise<Restaurant | null> {
  const r = await kv.get<Restaurant>(["restaurant", id]);
  return r.value ?? null;
}

export async function listRestaurants(q?: string): Promise<Restaurant[]> {
  // חיפוש פשוט: אם q ריק -> כל המסעדות; אחרת, חיתוך לפי שם/עיר (אינדקסים)
  const results: Map<string, Restaurant> = new Map();

  async function byIndex(prefix: readonly unknown[]) {
    for await (const entry of kv.list({ prefix })) {
      const rid = entry.key[entry.key.length - 1] as string;
      const r = (await kv.get<Restaurant>(["restaurant", rid])).value;
      if (r) results.set(r.id, r);
    }
  }

  if (!q || !q.trim()) {
    // כל המסעדות: prefix על ["restaurant"] + סינון רק הערכים (לא מפתחות אינדקס)
    for await (const entry of kv.list<Restaurant>({ prefix: ["restaurant"] })) {
      // כאשר list על ["restaurant"] יחזיר רק את רשומות ה-restaurant (ולא אינדקסים)
      const r = entry.value as unknown as Restaurant;
      if (r?.id && r?.name) results.set(r.id, r);
    }
    return Array.from(results.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  const needle = q.trim().toLowerCase();
  await byIndex(["restaurant_name", needle]); // התאמה מלאה לפי שם
  await byIndex(["restaurant_city", needle]); // התאמה מלאה לפי עיר

  // בנוסף: "חיפוש חלקי" נאיבי — נטען את כל הרשומות ונעשה includes מקומי
  if (results.size < 10) {
    for await (const entry of kv.list<Restaurant>({ prefix: ["restaurant"] })) {
      const r = entry.value as unknown as Restaurant;
      if (!r) continue;
      const hay = `${r.name} ${r.city} ${r.address}`.toLowerCase();
      if (hay.includes(needle)) results.set(r.id, r);
      if (results.size > 25) break;
    }
  }

  return Array.from(results.values())
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------
// Reservations
// ------------------------
// keys:
// ["reservation", id] -> Reservation
// ["reservation_by_user", userId, id] -> 1
// ["reservation_by_restaurant", restaurantId, id] -> 1

export async function createReservation(r: Reservation): Promise<Reservation> {
  const tx = kv.atomic()
    .set(["reservation", r.id], r)
    .set(["reservation_by_user", r.userId, r.id], 1)
    .set(["reservation_by_restaurant", r.restaurantId, r.id], 1);

  const ok = await tx.commit();
  if (!ok.ok) throw new Error("reservation_create_race");
  return r;
}
