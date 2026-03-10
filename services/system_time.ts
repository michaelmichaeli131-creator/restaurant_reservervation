import { kv } from "../database.ts";

export type RestaurantSystemTimeState = {
  restaurantId: string;
  enabled: boolean;
  iso: string;
  updatedAt: number;
  timezone?: string | null;
};

function key(restaurantId: string) {
  return ["restaurant_system_time", restaurantId] as const;
}

function isValidTimeZone(value?: string | null): value is string {
  const tz = String(value ?? "").trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidLocalIso(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return false;
  const d = new Date(s.length === 16 ? `${s}:00` : s);
  return Number.isFinite(d.getTime());
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function normalizeTime(value?: string | null) {
  const raw = String(value ?? "").trim();
  const m = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error("invalid_time");
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

export function buildLocalIso(date: string, time: string) {
  const d = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("invalid_date");
  const iso = `${d}T${normalizeTime(time)}`;
  if (!isValidLocalIso(iso)) throw new Error("invalid_local_iso");
  return iso;
}

function partsForTimeZone(timeZone: string, ref = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(ref);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    seconds: `${get("second")}`,
  };
}

export async function getRestaurantSystemTimeState(
  restaurantId: string,
): Promise<RestaurantSystemTimeState | null> {
  const row = await kv.get<RestaurantSystemTimeState>(key(restaurantId));
  return row.value ?? null;
}

export async function getRestaurantSystemTimezone(
  restaurantId: string,
  fallback?: string | null,
): Promise<string | null> {
  const state = await getRestaurantSystemTimeState(restaurantId);
  if (isValidTimeZone(state?.timezone)) return String(state!.timezone);
  if (isValidTimeZone(fallback)) return String(fallback);
  return null;
}

export async function getRestaurantSystemNow(
  restaurantId: string,
  fallbackTimeZone?: string | null,
): Promise<Date> {
  const state = await getRestaurantSystemTimeState(restaurantId);
  if (state?.enabled) {
    if (isValidLocalIso(state.iso)) {
      return new Date(state.iso.length === 16 ? `${state.iso}:00` : state.iso);
    }
    const legacy = new Date(String(state.iso ?? ""));
    if (Number.isFinite(legacy.getTime())) return legacy;
  }
  const tz = isValidTimeZone(state?.timezone) ? String(state!.timezone) : (isValidTimeZone(fallbackTimeZone) ? String(fallbackTimeZone) : "");
  if (!tz) return new Date();
  const parts = partsForTimeZone(tz);
  return new Date(`${parts.date}T${parts.time}:${parts.seconds}`);
}

export async function setRestaurantSystemTime(
  restaurantId: string,
  iso: string,
  timezone?: string | null,
) {
  const normalized = String(iso ?? "").trim();
  if (!isValidLocalIso(normalized)) {
    throw new Error("invalid_iso_datetime");
  }
  const next: RestaurantSystemTimeState = {
    restaurantId,
    enabled: true,
    iso: normalized.length === 16 ? `${normalized}:00` : normalized,
    updatedAt: Date.now(),
    timezone: isValidTimeZone(timezone) ? String(timezone).trim() : null,
  };
  await kv.set(key(restaurantId), next);
  return next;
}

export async function resetRestaurantSystemTime(
  restaurantId: string,
  timezone?: string | null,
) {
  const now = await getRestaurantSystemNow(restaurantId, timezone);
  const next: RestaurantSystemTimeState = {
    restaurantId,
    enabled: false,
    iso: splitIsoParts(now).iso,
    updatedAt: Date.now(),
    timezone: isValidTimeZone(timezone)
      ? String(timezone).trim()
      : (await getRestaurantSystemTimezone(restaurantId)) ?? null,
  };
  await kv.set(key(restaurantId), next);
  return next;
}

export async function updateRestaurantSystemTimezone(
  restaurantId: string,
  timezone?: string | null,
) {
  const tz = isValidTimeZone(timezone) ? String(timezone).trim() : null;
  const prev = await getRestaurantSystemTimeState(restaurantId);
  if (prev) {
    const next: RestaurantSystemTimeState = {
      ...prev,
      timezone: tz,
      updatedAt: Date.now(),
    };
    await kv.set(key(restaurantId), next);
    return next;
  }
  const now = await getRestaurantSystemNow(restaurantId, tz);
  const next: RestaurantSystemTimeState = {
    restaurantId,
    enabled: false,
    iso: splitIsoParts(now).iso,
    updatedAt: Date.now(),
    timezone: tz,
  };
  await kv.set(key(restaurantId), next);
  return next;
}

export function splitIsoParts(isoLike: string | Date) {
  const d = isoLike instanceof Date ? isoLike : new Date(isoLike);
  return {
    iso: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}
