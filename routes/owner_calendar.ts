// /src/routes/owner_calendar.ts
// ניהול תפוסה יומי — Calendar לבעלים: יום/סלוט/חיפוש/סיכום + פעולות סלוט

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

import {
  getRestaurant,
  openingWindowsForDate,
  type Restaurant,
  type Reservation,
} from "../database.ts";

import { readBody } from "./restaurants/_utils/body.ts";
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
  const user = await requireOwner(ctx);
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
function mapOpenWindowsForTimeline(wins: Array<{ open: string; close: string }>) {
  return wins.map(w => ({ start: w.open as `${number}${number}:${number}${number}`, end: w.close as `${number}${number}:${number}${number}` }));
}

/* ---- Enrichment from note / names ---- */
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

/* ---------- Body parser wrapper (uses your readBody) ---------- */
async function readActionBody(ctx: any): Promise<any> {
  try {
    const { payload, dbg } = await readBody(ctx);
    debugLog("owner_calendar", "readBody payload & dbg", { payload, dbg });
    return payload || {};
  } catch (e) {
    debugLog("owner_calendar", "readBody threw", { error: String(e) });
    return {};
  }
}

/* ---------- DB create resolver ---------- */
function pickCreateFn(db: any) {
  return (
    db?.createReservation ||
    db?.createManualReservation ||
    db?.createReservationAtTime ||
    db?.addReservation ||
    db?.insertReservation ||
    null
  );
}
async function tryCreateWithVariants(fn: Function, rid: string, r: Restaurant, date: string, time: string, payload: Record<string, unknown>) {
  const variants = [
    () => fn(rid, payload),
    () => fn(r, payload),
    () => fn(rid, date, time, payload),
    () => fn(r, date, time, payload),
    () => fn({ rid, restaurant: r, date, time, ...payload }),
  ];
  let lastErr: unknown = null;
  for (const v of variants) {
    try { return await v(); } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("createReservation failed for all variants");
}

/* ---------- Unified Slot Action Handler ---------- */
async function handleSlotAction(ctx: any) {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const method = ctx.request.method;
  const ct = ctx.request.headers.get("content-type") || "";
  debugLog("owner_calendar", "handleSlotAction ENTER", { rid, method, contentType: ct });

  const body = await readActionBody(ctx);
  debugLog("owner_calendar", "Body (payload) after readActionBody", { body });

  let action = String(body?.action ?? "").trim();
  if (!action && typeof body === "object") {
    const alias = (body as any).type ?? (body as any).op ?? (body as any).mode;
    if (alias && typeof alias === "string") {
      action = alias.trim();
      debugLog("owner_calendar", "Alias used for action", { alias });
    }
  }
  const normalized =
    action === "add" || action === "new" ? "create" :
    action === "edit" ? "update" :
    action === "cancel" ? "cancel" :
    action === "arrived" ? "arrived" :
    action;

  const date = String(body?.date ?? "");
  const time = String(body?.time ?? "");

  // reservation may arrive as string
  let reservation: any = (body as any)?.reservation ?? {};
  if (typeof reservation === "string") {
    try {
      reservation = JSON.parse(reservation);
      debugLog("owner_calendar", "reservation parsed from string", { reservation });
    } catch (e) {
      debugLog("owner_calendar", "reservation parse failed", { error: String(e), raw: (body as any).reservation });
      reservation = {};
    }
  }

  debugLog("owner_calendar", "Parsed action info", { action, normalized, date, time, reservation });

  if (!["create", "update", "cancel", "arrived"].includes(normalized)) {
    ctx.throw(Status.BadRequest, `Unknown action: ${action}`);
  }
  if (!isISODate(date) || !isHHMM(time)) {
    ctx.throw(Status.BadRequest, "Bad date/time");
  }

  const db = await import("../database.ts");
  let result: any = null;

  if (normalized === "create") {
    const fallbackName = (reservation?.fullName ?? reservation?.name ?? reservation?.customerName ?? "").toString().trim();
    let firstName = (reservation?.firstName ?? "").toString().trim();
    let lastName  = (reservation?.lastName  ?? "").toString().trim();
    if ((!firstName || !lastName) && fallbackName) {
      const s = splitName(fallbackName);
      if (!firstName) firstName = s.first;
      if (!lastName)  lastName  = s.last;
    }

    const noteRaw = (reservation?.notes ?? reservation?.note ?? "").toString().trim();
    if ((!firstName || !lastName || !reservation?.phone) && noteRaw) {
      const ext = extractFromNote(noteRaw);
      if ((!firstName || !lastName) && ext.name) {
        const s = splitName(ext.name);
        if (!firstName) firstName = s.first;
        if (!lastName)  lastName  = s.last;
      }
      if (!reservation?.phone && ext.phone) reservation.phone = ext.phone;
    }

    const { durationMinutes } = deriveCapacities(r);
    const user = (ctx.state as any)?.user;

    // === PAYLOAD עם אליאסים נפוצים כדי להתאים לשליפות קיימות ===
    const payload: Record<string, unknown> = {
      // בסיס
      firstName,
      lastName,
      phone    : (reservation?.phone ?? "").toString().trim(),
      people   : Math.max(1, Number(reservation?.people ?? 1)),
      note     : noteRaw,
      status   : (reservation?.status ?? "approved").toString(),

      // הקשרים
      restaurantId: rid,
      date,
      time,
      datetime: `${date}T${time}`,
      startsAt: `${date}T${time}`,           // אליאס נפוץ
      durationMinutes,
      source: "owner-manual",
      channel: "owner",
      createdBy: user?.id ?? null,

      // אליאסים לשדות שה-DAL שלך אולי מצפה להם
      reservation_date: date,
      res_date: date,
      time_display: time,
      timeDisplay: time,
      reservationTime: time,
    };

    // ברירת מחדל לשם ריק
    if (!payload.firstName && !payload.lastName) {
      payload.firstName = "Walk-in";
      payload.lastName = "";
    }
    if (!payload.people || Number.isNaN(payload.people as number)) {
      ctx.throw(Status.BadRequest, "Invalid people");
    }

    debugLog("owner_calendar", "create payload (final)", { payload });

    const createFn = pickCreateFn(db as any);
    if (!createFn) ctx.throw(Status.NotImplemented, "No createReservation function found in database.ts");

    try {
      result = await tryCreateWithVariants(createFn, rid, r, date, time, payload);
    } catch (e) {
      debugLog("owner_calendar", "create failed (all variants)", { error: String(e) });
      ctx.throw(Status.InternalServerError, "Create reservation failed");
    }
    debugLog("owner_calendar", "create result", { result });

  } else if (normalized === "update") {
    const id = String(reservation?.id ?? "");
    debugLog("owner_calendar", "update id & patch", { id, reservation });
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    const patch: Partial<Reservation> = {
      firstName: reservation?.firstName,
      lastName : reservation?.lastName,
      phone    : reservation?.phone,
      people   : reservation?.people ? Number(reservation?.people) : undefined,
      note     : reservation?.notes ?? reservation?.note,
      status   : reservation?.status,
    } as any;
    if (!(db as any).updateReservationFields) ctx.throw(Status.NotImplemented, "updateReservationFields not implemented yet");
    result = await (db as any).updateReservationFields(id, patch);

  } else if (normalized === "cancel") {
    const id = String(reservation?.id ?? "");
    debugLog("owner_calendar", "cancel id", { id });
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).cancelReservation) ctx.throw(Status.NotImplemented, "cancelReservation not implemented yet");
    result = await (db as any).cancelReservation(id, String(reservation?.reason ?? ""));

  } else if (normalized === "arrived") {
    const id = String(reservation?.id ?? "");
    debugLog("owner_calendar", "arrived id", { id });
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).markArrived) ctx.throw(Status.NotImplemented, "markArrived not implemented yet");
    result = await (db as any).markArrived(id);
  }

  debugLog("owner_calendar", "Slot action result", { result });
  json(ctx, { ok: true, result });
}

/* ---------------- Routes ---------------- */

// HTML
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  await render(ctx, "owner_calendar.eta", {
    title: "ניהול תפוסה יומי",
    rid,
    date: selected,
    restaurant: { id: r.id, name: (r as any).name ?? "Restaurant" },
  });
});

// JSON — יום (מסנן סטטוסים לא פעילים כדי שהצבעים יתעדכנו אחרי cancel)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const active = new Set(["approved","booked","arrived","invited"]);
  const effective = reservations.filter((rv: any) =>
    active.has(String(rv?.status ?? "approved").toLowerCase())
  );

  const occupancy = computeOccupancyForDay({
    reservations: effective,
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
    openWindows: openWinsRaw,
    slotMinutes,
    capacityPeople,
    capacityTables,
    slots: occupancy,
  });
});

// JSON — סלוט (עם range + העשרת פרטי לקוח מה־note)
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
    (await (db as any).listReservationsCoveringSlot?.(rid, date!, time!, {
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

// JSON — פעולות סלוט
ownerCalendarRouter.patch("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  await handleSlotAction(ctx);
});
ownerCalendarRouter.post("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  await handleSlotAction(ctx);
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
  const reservations: Reservation[] = (await (db as any).listReservationsByRestaurantAndDate?.(rid, date!)) ?? [];

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

// JSON — סיכום יומי (אותו סינון סטטוסים)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/summary", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const active = new Set(["approved","booked","arrived","invited"]);
  const effective = reservations.filter((rv: any) =>
    active.has(String(rv?.status ?? "approved").toLowerCase())
  );

  const occupancy = computeOccupancyForDay({
    reservations: effective,
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
