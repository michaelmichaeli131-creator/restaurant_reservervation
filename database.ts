// src/database.ts
// Deno KV – מסד נתונים מובנה. שימוש ב-openKv, אינדקסים עם prefix, ועסקאות atomic.
// Docs: openKv, list prefix selectors, atomic operations.
// https://docs.deno.com/api/deno/~/Deno.openKv
// https://docs.deno.com/api/deno/~/Deno.Kv.prototype.list
// https://docs.deno.com/api/deno/~/Deno.Kv.prototype.atomic

// ---------- Types ----------
export interface User {
  id: string;
  email: string;
  passwordHash?: string;    // ל-local auth; ב-OAuth לא חובה
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
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  people: number;
  note?: string;
  status?: "new" | "confirmed" | "canceled" | "completed";
  createdAt: number;
}

// ---------- KV ----------
export const kv = await Deno.openKv(); // בדפלוי: Zero-config. בלוקאל אפשר לתת path לקובץ. :contentReference[oaicite:1]{index=1}

// ---------- Utils ----------
function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }
function now() { return Date.now(); }

// ---------- Users ----------
// Keys:
// ["user", id] -> User
// ["user_by_email", email] -> id

export async function createUser(u: {
  id: string;
  email: string;
  passwordHash?: string;
  role: "user" | "owner";
  provider: "local" | "google";
}): Promise<User> {
  const user: User = { ...u, email: lower(u.email), createdAt: now() };
  const tx = kv.atomic()
    .check({ key: ["user_by_email", user.email], versionstamp: null })
    .set(["user", user.id], user)
    .set(["user_by_email", user.email], user.id);

  const res = await tx.commit(); // commit אטומי; ייכשל אם האימייל תפוס. :contentReference[oaicite:2]{index=2}
  if (!res.ok) throw new Error("email_used");
  return user;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const ref = await kv.get<string>(["user_by_email", lower(email)]);
  if (!ref.value) return null;
  return (await kv.get<User>(["user", ref.value])).value ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
  return (await kv.get<User>(["user", id])).value ?? null;
}

export async function updateUserRole(id: string, role: User["role"]): Promise<User | null> {
  const cur = await kv.get<User>(["user", id]);
  if (!cur.value) return null;
  const next: User = { ...cur.value, role };
  await kv.set(["user", id], next);
  return next;
}

// ---------- Restaurants ----------
// Keys:
// ["restaurant", id] -> Restaurant
// ["restaurant_by_owner", ownerId, id] -> 1
// ["restaurant_name", nameLower, id] -> 1
// ["restaurant_city", cityLower, id] -> 1
// הערה: list({prefix}) ב-KV תומך רק בחלקי־מפתח מלאים, לא "תווים ראשונים" של חלק. :contentReference[oaicite:3]{index=3}

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
  const restaurant: Restaurant = {
    ...r,
    name: r.name.trim(),
    city: r.city.trim(),
    address: r.address.trim(),
    menu: r.menu ?? [],
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

export async function getRestaurant(id: string): Promise<Restaurant | null> {
  return (await kv.get<Restaurant>(["restaurant", id])).value ?? null;
}

export async function updateRestaurant(id: string, patch: Partial<Omit<Restaurant, "id"|"ownerId"|"createdAt">>): Promise<Restaurant | null> {
  const cur = await kv.get<Restaurant>(["restaurant", id]);
  if (!cur.value) return null;

  const next: Restaurant = { ...cur.value, ...patch };
  const tx = kv.atomic().set(["restaurant", id], next);

  // עדכון אינדקסים אם השתנו name/city
  if (typeof patch.name === "string" && lower(patch.name) !== lower(cur.value.name)) {
    tx.delete(["restaurant_name", lower(cur.value.name), id])
      .set(["restaurant_name", lower(patch.name), id], 1);
  }
  if (typeof patch.city === "string" && lower(patch.city) !== lower(cur.value.city)) {
    tx.delete(["restaurant_city", lower(cur.value.city), id])
      .set(["restaurant_city", lower(patch.city), id], 1);
  }
  const res = await tx.commit();
  if (!res.ok) throw new Error("update_restaurant_race");
  return next;
}

export async function deleteRestaurant(id: string): Promise<boolean> {
  const cur = await kv.get<Restaurant>(["restaurant", id]);
  if (!cur.value) return false;
  const r = cur.value;
  const tx = kv.atomic()
    .delete(["restaurant", id])
    .delete(["restaurant_by_owner", r.ownerId, id])
    .delete(["restaurant_name", lower(r.name), id])
    .delete(["restaurant_city", lower(r.city), id]);
  const res = await tx.commit();
  return res.ok;
}

export interface ListPage<T> {
  items: T[];
  next?: string; // cursor
}

// עימוד פשוט עם startKey ב-list; next = JSON של המפתח האחרון
export async function listRestaurantsPaged(q: string | undefined, cursor?: string, pageSize = 20): Promise<ListPage<Restaurant>> {
  const results: Restaurant[] = [];
  const needle = lower(q);
  let start: readonly unknown[] | undefined;

  if (cursor) {
    try { start = JSON.parse(cursor); } catch { /* ignore */ }
  }

  async function readByPrefix(prefixBase: readonly unknown[]) {
    const iter = kv.list({ prefix: prefixBase, start }, { limit: pageSize + 1 }); // נביא +1 כדי לדעת אם יש עוד
    for await (const entry of iter) {
      const rid = entry.key[entry.key.length - 1] as string;
      const r = (await kv.get<Restaurant>(["restaurant", rid])).value;
      if (r) results.push(r);
      if (results.length >= pageSize + 1) break;
      start = entry.key; // נשמור אחרון כדי לחשב cursor הבא
    }
  }

  if (!needle) {
    // כל המסעדות (לפי ["restaurant"]) — פחות יעיל כי זה כולל נתונים מלאים; לרוב עדיף אינדקסים.
    const iter = kv.list<Restaurant>({ prefix: ["restaurant"], start }, { limit: pageSize + 1 });
    for await (const entry of iter) {
      const r = entry.value as unknown as Restaurant;
      if (r?.id) results.push(r);
      if (results.length >= pageSize + 1) break;
      start = entry.key;
    }
  } else {
    // חיפוש לפי אינדקס שם/עיר (התאמה מלאה של חלק מפתח)
    await readByPrefix(["restaurant_name", needle]);
    if (results.length < pageSize) await readByPrefix(["restaurant_city", needle]);
    // אם עדיין מעט – Fallback "כוללני" בזיכרון (includes)
    if (results.length < pageSize) {
      const iter = kv.list<Restaurant>({ prefix: ["restaurant"], start }, { limit: pageSize + 1 });
      for await (const entry of iter) {
        const r = entry.value as unknown as Restaurant;
        if (!r) continue;
        const hay = `${r.name} ${r.city} ${r.address}`.toLowerCase();
        if (hay.includes(needle)) results.push(r);
        if (results.length >= pageSize + 1) break;
        start = entry.key;
      }
    }
  }

  const hasMore = results.length > pageSize;
  const items = results.slice(0, pageSize).sort((a, b) => a.name.localeCompare(b.name));
  const next = hasMore && start ? JSON.stringify(start) : undefined;
  return { items, next };
}

// גרסה לא-מעומדת (MVP פשוט) – נשמרת אצלך לשימוש קיים
export async function listRestaurants(q?: string): Promise<Restaurant[]> {
  const out: Map<string, Restaurant> = new Map();
  const needle = lower(q);

  async function byIndex(prefix: readonly unknown[]) {
    for await (const entry of kv.list({ prefix })) {
      const rid = entry.key[entry.key.length - 1] as string;
      const r = (await kv.get<Restaurant>(["restaurant", rid])).value;
      if (r) out.set(r.id, r);
    }
  }

  if (!needle) {
    for await (const entry of kv.list<Restaurant>({ prefix: ["restaurant"] })) {
      const r = entry.value as unknown as Restaurant;
      if (r?.id) out.set(r.id, r);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  await byIndex(["restaurant_name", needle]);
  await byIndex(["restaurant_city", needle]);

  if (out.size < 10) {
    for await (const entry of kv.list<Restaurant>({ prefix: ["restaurant"] })) {
      const r = entry.value as unknown as Restaurant;
      if (!r) continue;
      const hay = `${r.name} ${r.city} ${r.address}`.toLowerCase();
      if (hay.includes(needle)) out.set(r.id, r);
      if (out.size > 25) break;
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Reservations ----------
// Keys:
// ["reservation", id] -> Reservation
// ["reservation_by_user", userId, id] -> 1
// ["reservation_by_restaurant", restaurantId, id] -> 1

export async function createReservation(r: Reservation): Promise<Reservation> {
  const tx = kv.atomic()
    .set(["reservation", r.id], r)
    .set(["reservation_by_user", r.userId, r.id], 1)
    .set(["reservation_by_restaurant", r.restaurantId, r.id], 1);
  const res = await tx.commit();
  if (!res.ok) throw new Error("reservation_create_race");
  return r;
}

export async function updateReservationStatus(id: string, status: NonNullable<Reservation["status"]>): Promise<Reservation | null> {
  const cur = await kv.get<Reservation>(["reservation", id]);
  if (!cur.value) return null;
  const next: Reservation = { ...cur.value, status };
  await kv.set(["reservation", id], next);
  return next;
}

export async function listReservationsByRestaurant(restaurantId: string): Promise<Reservation[]> {
  const out: Reservation[] = [];
  for await (const row of kv.list({ prefix: ["reservation_by_restaurant", restaurantId] })) {
    const resid = row.key[row.key.length - 1] as string;
    const resv = (await kv.get<Reservation>(["reservation", resid])).value;
    if (resv) out.push(resv);
  }
  out.sort((a, b) => (a.date + " " + a.time).localeCompare(b.date + " " + b.time));
  return out;
}

export async function listReservationsByOwner(ownerId: string): Promise<
  Array<{ restaurantId: string; restaurantName: string; reservation: Reservation }>
> {
  // אסוף את כל המסעדות של הבעלים
  const my: { id: string; name: string }[] = [];
  for await (const key of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = key.key[key.key.length - 1] as string;
    const r = (await kv.get<Restaurant>(["restaurant", rid])).value;
    if (r) my.push({ id: r.id, name: r.name });
  }

  // כנס את כל ההזמנות של כל המסעדות
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
