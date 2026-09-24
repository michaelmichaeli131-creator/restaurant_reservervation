// Calendar writes share the reservation-day CAS lock used by public booking.
import { kv, getRestaurant, listReservationsByRestaurantAndDate, openingWindowsForDate, getReservationPreferredLayoutId } from "../database.ts";
import { listFloorLayouts } from "./floor_service.ts";
import { validateWaitlistDate } from "./calendar_waitlist.ts";

export const inactive = new Set(["canceled", "cancelled", "completed", "rescheduled", "rejected", "declined", "no_show", "no-show", "noshow"]);
const minute = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
const text = (v: unknown, max = 100) => { const s = String(v ?? "").trim(); if (s.length > max) throw new RangeError("Text is too long"); return s; };
const capacity = (l: any) => Number(l.capacity) > 0 ? Number(l.capacity) : (l.tables || []).reduce((n: number, t: any) => n + Math.max(0, Number(t.seats) || 0), 0);

export async function saveCalendarReservation(rid: string, input: any, actorId: string, waitlistId?: string) {
  const restaurant: any = await getRestaurant(rid);
  if (!restaurant) throw new RangeError("Restaurant not found");
  const id = text(input.id || (waitlistId ? `waitlist:${waitlistId}` : crypto.randomUUID()), 100);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await kv.get<any>(["reservation", id]);
    if (current.value && current.value.restaurantId !== rid) throw new RangeError("Reservation not found");
    const prev = current.value;
    if (input.updatedAt && prev && Number(input.updatedAt) !== prev.updatedAt) throw new RangeError("This reservation has changed. Reload before saving.");
    const date = validateWaitlistDate(input.date ?? prev?.date);
    const time = text(input.time ?? prev?.time, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError("Invalid time");
    const lock = await kv.get(["reservation_day_lock", rid, date]);
    const oldLock = prev && prev.date !== date ? await kv.get(["reservation_day_lock", rid, prev.date]) : null;
    const waiting = waitlistId ? await kv.get<any>(["calendar_waitlist_v2", rid, date, waitlistId]) : null;
    if (waiting) {
      if (waiting.value?.status === "converted" && waiting.value.reservationId === id && prev) return prev;
      if (!waiting.value || !["waiting", "offered"].includes(waiting.value.status)) throw new RangeError("Waitlist request is no longer waiting");
    }
    const duration = Number(input.durationMinutes ?? prev?.durationMinutes ?? restaurant.serviceDurationMinutes ?? 120);
    const people = Number(input.people ?? prev?.people);
    const start = minute(time), end = start + duration;
    if (!Number.isInteger(people) || people < 1 || people > 10000) throw new RangeError("Invalid guest count");
    if (!Number.isInteger(duration) || duration < 15 || duration > 1440 || end > 1440) throw new RangeError("Invalid duration");
    const status = text(input.status ?? prev?.status ?? "confirmed");
    if (!["new", "confirmed", "arrived", "completed", "canceled", "cancelled", "no_show", "blocked"].includes(status)) throw new RangeError("Invalid status");
    const kind = text(input.calendarKind ?? prev?.calendarKind ?? "reservation");
    if (!["reservation", "event", "block"].includes(kind)) throw new RangeError("Invalid event type");
    const room = text(input.preferredLayoutId ?? prev?.preferredLayoutId ?? "");
    const tableId = text(input.tableId ?? prev?.tableId ?? "");
    const layouts: any[] = await listFloorLayouts(rid);
    const selected = room ? layouts.find(l => l.id === room) : null;
    if (room && !selected) throw new RangeError("Choose a valid room");
    const table = tableId ? selected?.tables?.find((t: any) => t.id === tableId) : null;
    if (tableId && (!table || Number(table.seats) < people)) throw new RangeError("Table is invalid or too small");
    const total = layouts.map(capacity).filter(c => c > 0).reduce((a,b) => a+b,0) || Number(restaurant.capacity);
    if (!inactive.has(status)) {
      const windows = openingWindowsForDate(restaurant, date);
      if (!windows.some((w: any) => start >= minute(w.open) && end <= minute(w.close))) throw new RangeError("Outside opening hours");
      const existing: any[] = (await listReservationsByRestaurantAndDate(rid, date)).filter((r: any) => r.id !== id && !inactive.has(String(r.status || "new")));
      const overlap = existing.filter(r => minute(r.time) < end && minute(r.time) + Number(r.durationMinutes || restaurant.serviceDurationMinutes || 120) > start);
      // Check every occupancy boundary, including bookings starting between ruler ticks.
      for (const t of [start, ...overlap.map(r => minute(r.time)).filter(t => t > start && t < end)]) {
        const active = overlap.filter(r => minute(r.time) <= t && minute(r.time) + Number(r.durationMinutes || restaurant.serviceDurationMinutes || 120) > t);
        if (active.reduce((n,r) => n + Number(r.people || 0), people) > total) throw new RangeError("Not enough availability for this time");
        // Unassigned guests may use this room; reserve conservatively until assigned.
        if (room && active.filter(r => !getReservationPreferredLayoutId(r) || getReservationPreferredLayoutId(r) === room).reduce((n,r) => n + Number(r.people || 0), people) > capacity(selected)) throw new RangeError("Not enough availability in this room");
        if (tableId && active.some(r => r.tableId === tableId || r.assignedTableId === tableId || r.tableIds?.includes(tableId))) throw new RangeError("This table already has a reservation");
      }
    }
    const value: any = { ...prev, id, restaurantId: rid, userId: prev?.userId || `manual:${rid}`, date, time, people,
      durationMinutes: duration, status, calendarKind: kind, preferredLayoutId: room, tableId,
      firstName: text(input.firstName ?? prev?.firstName), lastName: text(input.lastName ?? prev?.lastName),
      phone: text(input.phone ?? prev?.phone, 40), note: text(input.notes ?? input.note ?? prev?.note, 1000),
      eventTitle: text(input.eventTitle ?? prev?.eventTitle), createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(), updatedBy: actorId };
    if (kind !== "reservation" && !value.eventTitle) throw new RangeError("Event title is required");
    const tx = kv.atomic().check(lock).check(current).set(["reservation", id], value)
      .set(["reservation_by_day", rid, date, id], 1).set(["reservation_user", value.userId, id], 1)
      .set(lock.key, crypto.randomUUID());
    if (oldLock) tx.check(oldLock).set(oldLock.key, crypto.randomUUID()).delete(["reservation_by_day", rid, prev.date, id]);
    if (waiting) tx.check(waiting).set(waiting.key, { ...waiting.value, status: "converted", reservationId: id, updatedAt: Date.now() }, { expireIn: Math.max(1, waiting.value.createdAt + 90 * 86400000 - Date.now()) });
    if ((await tx.commit()).ok) return value;
  }
  throw new Error("Calendar changed. Please reload and try again.");
}
