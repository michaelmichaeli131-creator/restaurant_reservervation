import { kv } from "../database.ts";

export type RestaurantSystemTimeState = {
  restaurantId: string;
  enabled: boolean;
  iso: string;
  updatedAt: number;
};

function key(restaurantId: string) {
  return ["restaurant_system_time", restaurantId] as const;
}

function isValidIso(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime());
}

export async function getRestaurantSystemTimeState(
  restaurantId: string,
): Promise<RestaurantSystemTimeState | null> {
  const row = await kv.get<RestaurantSystemTimeState>(key(restaurantId));
  return row.value ?? null;
}

export async function getRestaurantSystemNow(restaurantId: string): Promise<Date> {
  const state = await getRestaurantSystemTimeState(restaurantId);
  if (state?.enabled && isValidIso(state.iso)) {
    return new Date(state.iso);
  }
  return new Date();
}

export async function setRestaurantSystemTime(restaurantId: string, iso: string) {
  const normalized = String(iso ?? "").trim();
  if (!isValidIso(normalized)) {
    throw new Error("invalid_iso_datetime");
  }
  const next: RestaurantSystemTimeState = {
    restaurantId,
    enabled: true,
    iso: new Date(normalized).toISOString(),
    updatedAt: Date.now(),
  };
  await kv.set(key(restaurantId), next);
  return next;
}

export async function resetRestaurantSystemTime(restaurantId: string) {
  await kv.delete(key(restaurantId));
  return {
    restaurantId,
    enabled: false,
    iso: new Date().toISOString(),
    updatedAt: Date.now(),
  } satisfies RestaurantSystemTimeState;
}

export function splitIsoParts(isoLike: string | Date) {
  const d = isoLike instanceof Date ? isoLike : new Date(isoLike);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    iso: d.toISOString(),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}
