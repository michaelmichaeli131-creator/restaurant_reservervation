// /src/routes/owner_calendar.ts
// ניהול תפוסה יומי — לוח שנה → יום → רבעי שעה (בעלים בלבד)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

// שכבת נתונים
import {
  getRestaurant,
  openingWindowsForDate, // ← כמו בקוד שעבד: נקרא עם r ולא עם r.id
  type Restaurant,
  type Reservation,
} from "../database.ts";

// Utilities קיימים בפרויקט
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
function isHHMM(s?: string | null): s is string { return !!s && /^\d{2}:\d{2}$/.test(s); }
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
  return wins.map(w => ({ start: w.open as `${number}${number}:${number}${number}`, end: w.close as `${number}${number}:${number}${number}` }));
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

// JSON — יום (מחזיר סלוטים רק בשעות פתיחה — כמו שעבד בעבר)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  // ⚠️ חשוב: בדיוק כמו בקוד שעבד — הפונקציה מקבלת את האובייקט r (לא r.id), ואין await
  const openWinsRaw = openingWindowsForDate(r, selected); // ← מה-DB
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes); // timeline רק לטווחי פתיחה

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await db.listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const occupancy = computeOccupancyForDay({
    reservations,
    timeline,
    slotMinutes,
    capacityPeople,
    capacityTables,
    defaultDurationMinutes: durationMinutes,
    avgPeoplePerTable: (r as any).avgPeoplePerTable ?? 3,
    deriveTables: (people: number, avg = 3) => Math.max(1, Math.ceil(people / Math.max(1, avg))),
  });

  json(ctx, {
    ok: true,
    date: selected,
    openWindows: openWinsRaw, // מחזירים במבנה {open,close} ל-UI
    slotMinutes,
    capacityPeople,
    capacityTables,
    slots: occupancy, // ← כבר מכיל רק סלוטים בתוך שעות פתיחה
  });
});

// JSON — סלוט (מגירת לקוחות + העשרה משדה note)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const time = ctx.request.url.searchParams.get("time");
  if (!isISODate(date) || !isHHMM(time)) ctx.throw(Status.BadRequest, "Bad date/time");

  const { slotMinutes, durationMinutes } = deriveCapacities(r);
  const range = slotRange(time!, durationMinutes, slotMinutes);

  const db = await import("../database.ts");
  const items: Reservation[] =
    (await db.listReservationsCoveringSlot?.(rid, date!, time!, {
      slotMinutes,
      durationMinutes,
    })) ?? [];

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
  const time = String(body?.time ?? "");
  const reservation = body?.reservation ?? {};

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
    const payload = {
      firstName: String(reservation?.firstName ?? "").trim(),
      lastName: String(reservation?.lastName ?? "").trim(),
      phone: String(reservation?.phone ?? "").trim(),
      people: Number(reservation?.people ?? 0),
      // DB שומר note יחיד — ממפים notes→note
      note: String(reservation?.notes ?? reservation?.note ?? "").trim(),
      status: String(reservation?.status ?? "approved"),
      date,
      time,
      source: "owner", // תיוג שימושי
    };

    if (!payload.firstName || !payload.lastName || !payload.people) {
      ctx.throw(Status.BadRequest, "Missing fields");
    }

    // ✅ Fallback: אם createManualReservation לא קיים — נשתמש ב-createReservation
    const hasManual = typeof (db as any).createManualReservation === "function";
    const hasCreate = typeof (db as any).createReservation === "function";

    if (hasManual) {
      // חתימה אופיינית: (rid, payload)
      result = await (db as any).createManualReservation(rid, payload);
    } else if (hasCreate) {
      // שמירה דרך הזרימה המשותפת
      // רוב המימושים תומכים ב-(rid, payload). אם אצלך זה (payload) — זה עדיין יעבוד כי TS מסתיר אופציונליות.
      result = await (db as any).createReservation(rid, payload);
    } else {
      ctx.throw(Status.NotImplemented, "createReservation is not available in database.ts");
    }
  }

  if (action === "update") {
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
    if (!(db as any).updateReservationFields) ctx.throw(Status.NotImplemented, "updateReservationFields not implemented yet");
    result = await (db as any).updateReservationFields(id, patch);
  }

  if (action === "cancel") {
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).cancelReservation) ctx.throw(Status.NotImplemented, "cancelReservation not implemented yet");
    result = await (db as any).cancelReservation(id, String(reservation?.reason ?? ""));
  }

  if (action === "arrived") {
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).markArrived) ctx.throw(Status.NotImplemented, "markArrived not implemented yet");
    result = await (db as any).markArrived(id);
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

// JSON — סיכום יומי
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/summary", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  // כמו בקוד שעבד: משתמשים ב-r (לא r.id), ובונים timeline רק מחלונות פתיחה
  const openWinsRaw = openingWindowsForDate(r, selected); // ← מה-DB
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await db.listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const occupancy = computeOccupancyForDay({
    reservations,
    timeline,
    slotMinutes,
    capacityPeople,
    capacityTables,
    defaultDurationMinutes: durationMinutes,
    avgPeoplePerTable: (r as any).avgPeoplePerTable ?? 3,
    deriveTables: (p: number, avg = 3) => Math.max(1, Math.ceil(p / Math.max(1, avg))),
  });

  const summary = summarizeDay(occupancy, reservations);
  json(ctx, { ok: true, date: selected, ...summary });
});

export { ownerCalendarRouter };
export default ownerCalendarRouter;
