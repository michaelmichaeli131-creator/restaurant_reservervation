// /src/routes/owner_calendar.ts
// ניהול תפוסה יומי — לוח שנה → יום → רבעי שעה (בעלים בלבד)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

// שכבת נתונים
import {
  getRestaurant,
  openingWindowsForDate,
  type Restaurant,
  type Reservation,
} from "../database.ts";

// Utilities קיימים בפרויקט (קריאת body מותאמת Oak 17)
import { readBody } from "./restaurants/_utils/body.ts";

// שירותי טיימליין ותפוסה
import { buildDayTimeline, slotRange } from "../services/timeline.ts";
import { computeOccupancyForDay, summarizeDay } from "../services/occupancy.ts";

const ownerCalendarRouter = new Router();

/* ---------------- Helpers ---------------- */
function pad2(n: number) { return n.toString().padStart(2, "0"); }
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function isISODate(s?: string | null): s is string { return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isHHMM(s?: string | null): s is string { return !!s && /^\d{1,2}:\d{2}$/.test(s ?? ""); }
function toHHMM(s: string): string {
  // מקבל "9:00" → מחזיר "09:00"
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mi = Math.max(0, Math.min(59, Number(m[2])));
  return `${pad2(h)}:${pad2(mi)}`;
}
function hmToMinutes(hhmm: string): number {
  const [h, m] = toHHMM(hhmm).split(":").map(Number);
  return h * 60 + m;
}
function minutesToHM(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}
function json(ctx: any, data: unknown, status = Status.OK) {
  ctx.response.status = status;
  ctx.response.type = "application/json; charset=utf-8";
  ctx.response.body = data;
}

async function ensureOwnerAccess(ctx: any, rid: string): Promise<Restaurant> {
  const user = await requireOwner(ctx); // זורק אם אין גישה
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "Restaurant not found");
  if (r.ownerId !== user.id && (r as any).userId !== user.id) {
    ctx.throw(Status.Forbidden, "Not your restaurant");
  }
  return r as Restaurant;
}

function deriveCapacities(r: Restaurant) {
  const capacityPeople = Math.max(1, Number((r as any).capacity ?? 0));
  const avgPeoplePerTable = Number((r as any).avgPeoplePerTable ?? 3);
  let capacityTables = Number((r as any).capacityTables ?? 0);
  if (!capacityTables || capacityTables <= 0) {
    capacityTables = Math.max(1, Math.ceil(capacityPeople / Math.max(1, avgPeoplePerTable)));
  }
  const slotMinutes = Number((r as any).slotIntervalMinutes ?? 15);
  const durationMinutes = Number((r as any).serviceDurationMinutes ?? (r as any).reservationDurationMinutes ?? 120);
  return { capacityPeople, capacityTables, slotMinutes, durationMinutes, avgPeoplePerTable };
}

// ממיר {open,close} → {start,end} לשירות ה-timeline
function mapOpenWindowsForTimeline(wins: Array<{ open: string; close: string }>) {
  return wins.map(w => ({
    start: toHHMM(w.open) as `${number}${number}:${number}${number}`,
    end: toHHMM(w.close) as `${number}${number}:${number}${number}`,
  }));
}

/* ---- Enrichment for Customer drawer (fallback from 'note') ---- */
function splitName(full?: string): { first: string; last: string } {
  const s = String(full ?? "").trim().replace(/\s+/g, " ");
  if (!s) return { first: "", last: "" };
  const parts = s.split(" ");
  const first = parts.shift() || "";
  const last = parts.join(" ");
  return { first, last };
}
function extractFromNote(note?: string): { name?: string; phone?: string } {
  const t = String(note ?? "");
  const mName = t.match(/\bName:\s*([^;]+)\b/i);
  const mPhone = t.match(/\bPhone:\s*([^;]+)/i);
  return { name: mName ? mName[1].trim() : undefined, phone: mPhone ? mPhone[1].trim() : undefined };
}

/* ---- Allowed slots from opening windows (open ≤ t < close) ---- */
type OpenWin = { open: string; close: string };
function expandWinsToSlots(wins: OpenWin[], slotMinutes: number): Set<string> {
  const out = new Set<string>();
  for (const w of wins) {
    const start = hmToMinutes(w.open);
    const end = hmToMinutes(w.close);
    // כלל: כולל פתיחה, לא כולל סגירה (שיהיה מסונכרן להזמנות)
    for (let t = start; t < end; t += slotMinutes) {
      out.add(minutesToHM(t));
    }
  }
  return out;
}
/* ---------------------------------------------------------------- */

/* ---------------- Routes ---------------- */

// HTML
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  debugLog("owner_calendar", "GET /calendar", { rid, selected });

  await render(ctx, "owner_calendar.eta", {
    title: "ניהול תפוסה יומי",
    rid,
    date: selected,
    restaurant: { id: r.id, name: (r as any).name ?? "Restaurant" },
  });
});

// JSON — יום (רק שעות פתיחה)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = (await openingWindowsForDate(r.id, selected))
    .map(w => ({ open: toHHMM(w.open), close: toHHMM(w.close) })); // נרמול
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const allowed = expandWinsToSlots(openWinsRaw, slotMinutes);

  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await db.listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const occupancyAll = computeOccupancyForDay({
    reservations,
    timeline,
    slotMinutes,
    capacityPeople,
    capacityTables,
    defaultDurationMinutes: durationMinutes,
    avgPeoplePerTable: (r as any).avgPeoplePerTable ?? 3,
    deriveTables: (people: number, avg = 3) => Math.max(1, Math.ceil(people / Math.max(1, avg))),
  });

  // סינון סופי לפי קבוצת סלוטים מותרת (מנורמלת)
  const slots = Array.isArray(occupancyAll)
    ? occupancyAll.filter((s: any) => typeof s?.time === "string" && allowed.has(toHHMM(s.time)))
    : occupancyAll;

  json(ctx, {
    ok: true,
    date: selected,
    openWindows: openWinsRaw,
    slotMinutes,
    capacityPeople,
    capacityTables,
    slots,
  });
});

// JSON — סלוט (מגירת לקוחות)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const timeRaw = ctx.request.url.searchParams.get("time");
  if (!isISODate(date) || !isHHMM(timeRaw)) ctx.throw(Status.BadRequest, "Bad date/time");
  const time = toHHMM(timeRaw!);

  const { slotMinutes, durationMinutes } = deriveCapacities(r);

  // ודא שהסלוט המבוקש פתוח – אחרת נחזיר ריק (או 404 אם תרצה)
  const openWinsRaw = (await openingWindowsForDate(r.id, date!))
    .map(w => ({ open: toHHMM(w.open), close: toHHMM(w.close) }));
  const allowed = expandWinsToSlots(openWinsRaw, slotMinutes);
  if (!allowed.has(time)) {
    // אפשר גם: ctx.throw(Status.NotFound, "Slot is closed");
    return json(ctx, { ok: true, date, time, range: [], items: [] });
  }

  const range = slotRange(time, durationMinutes, slotMinutes);

  const db = await import("../database.ts");
  const items: Reservation[] =
    (await db.listReservationsCoveringSlot?.(rid, date!, time, {
      slotMinutes,
      durationMinutes,
    })) ?? [];

  // העשרה משדה note כאשר חסרים first/last/phone
  const enriched = items.map((it: any) => {
    let first = String(it.firstName ?? "");
    let last  = String(it.lastName ?? "");
    let phone = String(it.phone ?? "");
    const notes = it.note ?? it.notes ?? "";

    if ((!first || !last || !phone) && notes) {
      const ext = extractFromNote(String(notes));
      if ((!first || !last) && ext.name) {
        const s = splitName(ext.name);
        if (!first) first = s.first;
        if (!last)  last  = s.last;
      }
      if (!phone && ext.phone) phone = ext.phone;
    }

    return {
      id: it.id,
      firstName: first,
      lastName: last,
      phone,
      people: Number(it.people ?? 0),
      status: it.status ?? "approved",
      notes,
      at: it.time ?? time,
    };
  });

  json(ctx, {
    ok: true,
    date,
    time,
    range,
    items: enriched,
  });
});

// JSON — פעולות סלוט: create/update/cancel/arrived
ownerCalendarRouter.patch("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);

  const body = await readBody(ctx).catch(() => ({}));
  const action = String(body?.action ?? "").trim();
  const date = String(body?.date ?? "");
  const time = toHHMM(String(body?.time ?? ""));

  if (!["create", "update", "cancel", "arrived"].includes(action)) {
    ctx.throw(Status.BadRequest, "Unknown action");
  }
  if (!isISODate(date) || !isHHMM(time)) {
    ctx.throw(Status.BadRequest, "Bad date/time");
  }

  debugLog("owner_calendar", "PATCH /slot", { rid, action, date, time });

  const db = await import("../database.ts");
  let result: any = null;

  if (action === "create") {
    const reservation = body?.reservation ?? {};
    const payload = {
      firstName: String(reservation?.firstName ?? "").trim(),
      lastName: String(reservation?.lastName ?? "").trim(),
      phone: String(reservation?.phone ?? "").trim(),
      people: Number(reservation?.people ?? 0),
      notes: String(reservation?.notes ?? reservation?.note ?? "").trim(),
      status: String(reservation?.status ?? "approved"),
      date, time,
    };
    if (!payload.firstName || !payload.lastName || !payload.people) {
      ctx.throw(Status.BadRequest, "Missing fields");
    }
    if (!db.createManualReservation) ctx.throw(Status.NotImplemented, "createManualReservation not implemented yet");
    result = await db.createManualReservation(rid, payload);
  }

  if (action === "update") {
    const reservation = body?.reservation ?? {};
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    const patch: Partial<Reservation> = {
      firstName: reservation?.firstName,
      lastName: reservation?.lastName,
      phone: reservation?.phone,
      people: reservation?.people ? Number(reservation?.people) : undefined,
      note: reservation?.notes ?? reservation?.note,
      status: reservation?.status,
    } as any;
    if (!db.updateReservationFields) ctx.throw(Status.NotImplemented, "updateReservationFields not implemented yet");
    result = await db.updateReservationFields(id, patch);
  }

  if (action === "cancel") {
    const reservation = body?.reservation ?? {};
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!db.cancelReservation) ctx.throw(Status.NotImplemented, "cancelReservation not implemented yet");
    result = await db.cancelReservation(id, String(reservation?.reason ?? ""));
  }

  if (action === "arrived") {
    const reservation = body?.reservation ?? {};
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!db.markArrived) ctx.throw(Status.NotImplemented, "markArrived not implemented yet");
    result = await db.markArrived(id);
  }

  json(ctx, { ok: true, result });
});

// JSON — חיפוש ליום
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/search", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date");
  const qraw = ctx.request.url.searchParams.get("q") ?? "";
  const q = qraw.trim().toLowerCase();

  if (!isISODate(date) || !q) ctx.throw(Status.BadRequest, "Bad date or empty query");

  const db = await import("../database.ts");
  const reservations: Reservation[] = (await db.listReservationsByRestaurantAndDate?.(rid, date!)) ?? [];

  const matches = reservations.filter((r: any) => {
    const f = String(r.firstName ?? "").toLowerCase();
    const l = String(r.lastName ?? "").toLowerCase();
    return f.includes(q) || l.includes(q);
  });

  json(ctx, {
    ok: true,
    date,
    q: qraw,
    count: matches.length,
    items: matches.map((it: any) => ({
      id: it.id,
      time: it.time,
      firstName: it.firstName ?? "",
      lastName: it.lastName ?? "",
      people: Number(it.people ?? 0),
      status: it.status ?? "",
    })),
  });
});

// JSON — סיכום יומי (מושפע רק מסלוטים פתוחים)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/summary", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = (await openingWindowsForDate(r.id, selected))
    .map(w => ({ open: toHHMM(w.open), close: toHHMM(w.close) }));
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const allowed = expandWinsToSlots(openWinsRaw, slotMinutes);

  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await db.listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const occupancyAll = computeOccupancyForDay({
    reservations,
    timeline,
    slotMinutes,
    capacityPeople,
    capacityTables,
    defaultDurationMinutes: durationMinutes,
    avgPeoplePerTable: (r as any).avgPeoplePerTable ?? 3,
    deriveTables: (p: number, avg = 3) => Math.max(1, Math.ceil(p / Math.max(1, avg))),
  });

  const filtered = Array.isArray(occupancyAll)
    ? occupancyAll.filter((s: any) => typeof s?.time === "string" && allowed.has(toHHMM(s.time)))
    : occupancyAll;

  const summary = summarizeDay(filtered, reservations);
  json(ctx, { ok: true, date: selected, ...summary });
});

export { ownerCalendarRouter };
export default ownerCalendarRouter;
