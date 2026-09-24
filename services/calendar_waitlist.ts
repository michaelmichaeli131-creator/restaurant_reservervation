// SpotBook Calendar 2.0 — isolated waitlist storage.
// New keys coexist with the existing reservation indices; no legacy migrations.
import { kv, getReservationById } from "../database.ts";

export type WaitlistStatus = "waiting" | "offered" | "converted" | "cancelled";
export interface CalendarWaitlistEntry {
  id: string;
  restaurantId: string;
  date: string;
  time: string;
  name: string;
  phone: string;
  people: number;
  area: string;
  note: string;
  status: WaitlistStatus;
  source: "staff" | "guest";
  createdAt: number;
  updatedAt: number;
  reservationId?: string;
}

const key = (rid: string, date: string, id: string): Deno.KvKey =>
  ["calendar_waitlist_v2", rid, date, id];
const prefix = (rid: string, date: string): Deno.KvKey =>
  ["calendar_waitlist_v2", rid, date];

export function validateWaitlistDate(date: unknown): string {
  if (typeof date !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date)) {
    throw new RangeError("Invalid date");
  }
  const parsed = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError("Invalid date");
  }
  return date;
}

function bounded(value: unknown, label: string, max: number, required = false): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new RangeError("Invalid " + label);
  }
  const text = String(value ?? "").trim();
  if ((required && !text) || text.length > max || (label === "note" ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(text)) {
    throw new RangeError("Invalid " + label);
  }
  return text;
}

export function validateWaitlistInput(input: Record<string, unknown>) {
  const date = validateWaitlistDate(input.date);
  const time = bounded(input.time, "time", 5, true);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError("Invalid time");
  const name = bounded(input.name, "name", 100, true);
  const phone = bounded(input.phone, "phone", 40, true);
  const digits = phone.replace(/\D/g, "");
  if (!/^[+\d][\d()\s.+-]*$/.test(phone) || digits.length < 6 || digits.length > 20) {
    throw new RangeError("Invalid phone");
  }
  const people = Number(input.people);
  if (!Number.isInteger(people) || people < 1 || people > 30) {
    throw new RangeError("Invalid party size");
  }
  return {
    date, time, name, phone, people,
    area: bounded(input.area, "area", 90),
    note: bounded(input.note, "note", 500),
  };
}

export async function createCalendarWaitlist(
  rid: string,
  input: Record<string, unknown>,
  source: "staff" | "guest" = "staff",
): Promise<CalendarWaitlistEntry> {
  const data = validateWaitlistInput(input);
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = crypto.randomUUID();
    const at = Date.now();
    const value: CalendarWaitlistEntry = {
      id, restaurantId: rid, ...data, status: "waiting",
      source, createdAt: at, updatedAt: at,
    };
    const inserted = await kv.atomic().check({ key: key(rid, data.date, id), versionstamp: null })
      .set(key(rid, data.date, id), value, { expireIn: 90 * 86400000 }).commit();
    if (inserted.ok) return value;
  }
  throw new Error("Could not create waitlist entry");
}

export async function listCalendarWaitlist(rid: string, date: string) {
  validateWaitlistDate(date);
  const rows: CalendarWaitlistEntry[] = [];
  for await (const row of kv.list<CalendarWaitlistEntry>({ prefix: prefix(rid, date) })) {
    if (row.value?.restaurantId === rid && row.value?.date === date) rows.push(row.value);
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function updateCalendarWaitlistStatus(
  rid: string, date: string, id: string,
  target: "waiting" | "offered" | "cancelled",
): Promise<CalendarWaitlistEntry | null> {
  validateWaitlistDate(date);
  if (!/^[\da-f-]{36}$/i.test(id)) throw new RangeError("Invalid entry");
  if (!["waiting", "offered", "cancelled"].includes(target)) throw new RangeError("Invalid status");
  const k = key(rid, date, id);
  const current = await kv.get<CalendarWaitlistEntry>(k);
  if (!current.value) return null;
  if (current.value.restaurantId !== rid || current.value.date !== date) return null;
  const allowed: Record<WaitlistStatus, readonly string[]> = {
    waiting: ["offered", "cancelled"],
    offered: ["waiting", "cancelled"],
    converted: [],
    cancelled: [],
  };
  if (current.value.status === target) return current.value;
  if (!allowed[current.value.status]?.includes(target)) throw new RangeError("Invalid status transition");
  const next = { ...current.value, status: target, updatedAt: Date.now() };
  const result = await kv.atomic().check(current).set(k, next, { expireIn: Math.max(1, current.value.createdAt + 90 * 86400000 - Date.now()) }).commit();
  if (!result.ok) throw new Error("Waitlist entry changed; reload before editing");
  return next;
}

// Conversion must only be recorded after an actual reservation exists.
// Never "convert" a waiting party by changing a badge alone.
export async function markWaitlistConverted(
  rid: string, date: string, id: string, reservationId: string,
): Promise<CalendarWaitlistEntry | null> {
  validateWaitlistDate(date);
  const k = key(rid, date, id);
  const current = await kv.get<CalendarWaitlistEntry>(k);
  if (!current.value) return null;
  if (current.value.restaurantId !== rid || current.value.date !== date) return null;
  if (!["waiting", "offered"].includes(current.value.status)) throw new RangeError("Invalid conversion");
  const reservation = await getReservationById(reservationId);
  if (!reservation || reservation.restaurantId !== rid || reservation.date !== date) {
    throw new RangeError("Reservation does not belong to this restaurant and date");
  }
  const next: CalendarWaitlistEntry = {
    ...current.value, status: "converted", reservationId, updatedAt: Date.now(),
  };
  const changed = await kv.atomic().check(current).set(k, next).commit();
  if (!changed.ok) throw new Error("Waitlist entry changed; reload before converting");
  return next;
}
