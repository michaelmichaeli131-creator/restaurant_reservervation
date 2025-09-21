// database.ts
export const kv = await Deno.openKv();

export type User = {
  id: string;
  email: string;
  passwordHash?: string;
  provider?: "google" | "local";
  role: "user" | "owner";
  createdAt: number;
};

export type Restaurant = {
  id: string;
  ownerId: string;
  name: string;
  city: string;
  address: string;
  phone?: string;
  hours?: string;
  description?: string;
  menu?: { name: string; price: number }[];
  createdAt: number;
  updatedAt: number;
};

export type Reservation = {
  id: string;
  restaurantId: string;
  userId: string;
  date: string;
  time: string;
  people: number;
  note?: string;
  createdAt: number;
};

export async function createUser(u: Omit<User, "createdAt">) {
  const user = { ...u, createdAt: Date.now() };
  await kv.set(["user", u.id], user);
  await kv.set(["user_by_email", u.email], u.id);
  return user;
}

export async function findUserByEmail(email: string) {
  const id = (await kv.get<string>(["user_by_email", email])).value;
  if (!id) return null;
  return (await kv.get<User>(["user", id])).value ?? null;
}

export async function getUser(id: string) {
  return (await kv.get<User>(["user", id])).value ?? null;
}

export async function createRestaurant(r: Omit<Restaurant, "createdAt"|"updatedAt">) {
  const obj = { ...r, createdAt: Date.now(), updatedAt: Date.now() };
  await kv.set(["restaurant", r.id], obj);
  await kv.set(["restaurant_by_owner", r.ownerId, r.id], true);
  return obj;
}

export async function getRestaurant(id: string) {
  return (await kv.get<Restaurant>(["restaurant", id])).value ?? null;
}

export async function createReservation(res: Reservation) {
  await kv.set(["reservation", res.id], res);
  await kv.set(["reservation_by_restaurant", res.restaurantId, res.id], true);
  await kv.set(["reservation_by_user", res.userId, res.id], true);
  return res;
}

// --- חיפוש פשוט (שם/עיר/כתובת), case-insensitive ---
export async function listRestaurants(query = ""): Promise<Restaurant[]> {
  const q = query.trim().toLowerCase();
  const out: Restaurant[] = [];
  for await (const entry of kv.list<{ value: Restaurant }>({ prefix: ["restaurant"] })) {
    const r = (entry as any).value as Restaurant;
    if (!q) out.push(r);
    else {
      const hay = `${r.name} ${r.city} ${r.address}`.toLowerCase();
      if (hay.includes(q)) out.push(r);
    }
  }
  // סדר בסיסי: הכי חדשים למעלה
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
