// /src/routes/owner_calendar.ts
// Owner Day Calendar (timeline + slot actions + search + summary)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

import {
  getRestaurant,
  openingWindowsForDate,
  listRestaurants,            // ← נוסיף לחיפוש fallback
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

/** בדיקת הרשאות + מציאת מסעדה עם fallback חכם */
async function ensureOwnerAccess(ctx: any, rawRid: string): Promise<Restaurant> {
  const user = await requireOwner(ctx);
  const rid = decodeURIComponent(String(rawRid ?? "")).trim();
  if (!rid) ctx.throw(Status.BadRequest, "Missing restaurant id (rid)");

  // ניסיון 1: לפי getRestaurant (לרוב UUID)
  let r = await getRestaurant(rid) as Restaurant | null;

  // ניסיון 2: fallback – חיפוש לפי slug/שם/מזהה חלקי
  if (!r) {
    try {
      const all = await listRestaurants();
      const ridLower = rid.toLowerCase();

      // עדיפות: slug מדויק
      r = all.find((x: any) => String(x.slug ?? "").toLowerCase() === ridLower) as Restaurant | undefined as any;

      // אח״כ: id שמתחיל ב־rid (קיצורי מזהה)
      if (!r) r = all.find((x: any) => String(x.id ?? "").toLowerCase().startsWith(ridLower)) as Restaurant | undefined as any;

      // לבסוף: שם מדויק/כולל
      if (!r) r = all.find((x: any) => String(x.name ?? "").toLowerCase() === ridLower) as Restaurant | undefined as any;
      if (!r) r = all.find((x: any) => String(x.name ?? "").toLowerCase().includes(ridLower)) as Restaurant | undefined as any;
    } catch (e) {
      debugLog("owner_calendar", "fallback listRestaurants failed", { error: String(e) });
    }
  }

  if (!r) {
    debugLog("owner_calendar", "Restaurant not found", { rid, userId: user?.id });
    ctx.throw(Status.NotFound, "Restaurant not found");
  }

  const ownerId = (r as any).ownerId ?? null;
  const userId  = (r as any).userId  ?? null;
  const isAdmin = !!(user as any)?.isAdmin;

  if (isAdmin || ownerId === user.id || userId === user.id) {
    return r as Restaurant;
  }

  debugLog("owner_calendar", "Forbidden: restaurant not owned by user", { rid, userId: user?.id, ownerId, rUserId: userId, isAdmin });
  ctx.throw(Status.Forbidden, "Not your restaurant");
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

/* ---------- Body parser wrapper ---------- */
async function readActionBody(ctx: any): Promise<any> {
  try {
    const { payload, dbg } = await readBody(ctx);
    debugLog("owner_calendar", "readBody payload & dbg", { payload, dbg });
    return payload || {};
  } catch (_e) {
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

async function tryCreateWithVariants(
  createFn: Function,
  rid: string,
  r: Restaurant,
  date: string,
  time: string,
  payload: Record<string, unknown>,
) {
  try { return await createFn(rid, { ...payload, date, time }); } catch (_e) {}
  try {
    return await createFn({
      id: crypto.randomUUID(),
      restaurantId: rid,
      ...payload,
      date,
      time,
    });
  } catch (_e) {}
  try { return await createFn(rid, date, time, payload); } catch (_e) {}
  throw new Error("No compatible createReservation signature");
}

function activeStatuses(): Set<string> {
  return new Set(["approved","confirmed","booked","arrived","invited"]);
}

/* ---------- Unified Slot Action Handler ---------- */
async function handleSlotAction(ctx: any) {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const method = ctx.request.method;
  const ct = ctx.request.headers.get("content-type") || "";
  debugLog("owner_calendar", "handleSlotAction ENTER", { rid, method, contentType: ct });

  const body = await readActionBody(ctx);
  let action = String(body?.action ?? "").trim();
  if (!action && typeof body === "object") {
    const alias = (body as any).type ?? (body as any).op ?? (body as any).mode;
    if (alias && typeof alias === "string") action = alias.trim();
  }
  const normalized =
    action === "add" || action === "new" ? "create" :
    action === "edit" ? "update" :
    action === "cancel" ? "cancel" :
    action === "arrived" ? "arrived" :
    action;

  const date = String(body?.date ?? "");
  const time = String(body?.time ?? "");

  if (!isISODate(date)) ctx.throw(Status.BadRequest, "Invalid or missing date");
  if (!isHHMM(time)) ctx.throw(Status.BadRequest, "Invalid or missing time");

  const reservation = (body?.reservation ?? body?.data ?? body) as any;
  const fallbackName = String(reservation?.name ?? reservation?.fullName ?? "").trim();

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

  const payload: Record<string, unknown> = {
    firstName,
    lastName,
    phone    : (reservation?.phone ?? "").toString().trim(),
    people   : Math.max(1, Number(reservation?.people ?? 1)),
    note     : noteRaw,
    date,
    time,
    durationMinutes,
    restaurantId: (r as any).id ?? rid,
    userId   : reservation?.userId ?? user?.id ?? `manual:${rid}`,
    status   : (reservation?.status ?? (reservation?.approved ? "approved" : "invited")).toString().toLowerCase(),
  };

  if (!payload.firstName && !payload.lastName) {
    payload.firstName = "Guest";
    payload.lastName = "";
  }
  if (!payload.people || Number.isNaN(payload.people as number)) {
    ctx.throw(Status.BadRequest, "Invalid people");
  }

  const db = await import("../database.ts");
  let result: unknown;

  if (normalized === "create") {
    const createFn = pickCreateFn(db as any);
    if (!createFn) ctx.throw(Status.NotImplemented, "No createReservation function found in database.ts");

    try {
      result = await tryCreateWithVariants(createFn, (r as any).id ?? rid, r, date, time, payload);
    } catch (_e) {
      debugLog("owner_calendar", "create failed", { rid, date, time, payload });
      ctx.throw(Status.InternalServerError, "Create reservation failed");
    }

  } else if (normalized === "update") {
    const id = String(reservation?.id ?? "");
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
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).cancelReservation) ctx.throw(Status.NotImplemented, "cancelReservation not implemented yet");
    result = await (db as any).cancelReservation(id, String(reservation?.reason ?? ""));

  } else if (normalized === "arrived") {
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).markArrived) ctx.throw(Status.NotImplemented, "markArrived not implemented yet");
    result = await (db as any).markArrived(id, new Date());

  } else {
    ctx.throw(Status.BadRequest, `Unknown action: ${action}`);
  }

  json(ctx, { ok: true, action: normalized, result });
}

/* ---------- View: page ---------- */
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar", async (ctx) => {
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
    (await (db as any).listReservationsByRestaurantAndDate?.((r as any).id, selected)) ?? [];

  const effective = reservations.filter((rv: any) =>
    activeStatuses().has(String(rv?.status ?? "approved").toLowerCase())
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

  await render(ctx, "owner_calendar", {
    title: `יומן — ${r.name}`,
    restaurant: r,
    date: selected,
    timeline,
    slotMinutes,
    capacity: { people: capacityPeople, tables: capacityTables, avg: (r as any).avgPeoplePerTable ?? 3 },
    summary,
  });
});

/* ---------- JSON: day (for UI refresh) ---------- */
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
    (await (db as any).listReservationsByRestaurantAndDate?.((r as any).id, selected)) ?? [];

  const effective = reservations.filter((rv: any) =>
    activeStatuses().has(String(rv?.status ?? "approved").toLowerCase())
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

/* ---------- JSON: time range items ---------- */
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/time", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date") || todayISO();
  const time = ctx.request.url.searchParams.get("time") || "00:00";
  const rangeStr = ctx.request.url.searchParams.get("range") || "60";
  const range = Math.max(15, Math.min(240, Number(rangeStr) || 60));

  const db = await import("../database.ts");
  const items: Reservation[] = (await (db as any).listReservationsCoveringSlot?.((r as any).id, date, time, {
    slotMinutes: Math.max(15, Number((r as any).slotIntervalMinutes ?? 15)),
    durationMinutes: Math.max(15, Number((r as any).serviceDurationMinutes ?? 120)),
  })) ?? [];

  const enriched = items.map((it) => {
    const name = [it.firstName, it.lastName].filter(Boolean).join(" ").trim();
    const phone = (it as any).phone || "";
    const notes = (it as any).note || (it as any).notes || "";
    return {
      id: it.id,
      status: it.status,
      name: name || undefined,
      phone: phone || undefined,
      people: it.people,
      notes,
      at: it.time ?? time,
    };
  });

  json(ctx, { ok: true, date, time, range, items: enriched });
});

/* ---------- JSON: slot actions ---------- */
ownerCalendarRouter.patch("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  await handleSlotAction(ctx);
});
ownerCalendarRouter.post("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  await handleSlotAction(ctx);
});

/* ---------- JSON: search by name/phone/note ---------- */
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/search", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date");
  const qraw = ctx.request.url.searchParams.get("q") ?? "";
  const q = qraw.trim().toLowerCase();
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);
  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.((r as any).id, selected)) ?? [];

  const effective = reservations.filter((rv: any) =>
    activeStatuses().has(String(rv?.status ?? "approved").toLowerCase())
  );

  const filtered = effective.filter((rv: any) => {
    const name = [rv.firstName, rv.lastName].filter(Boolean).join(" ").toLowerCase();
    const phone = String((rv as any).phone ?? "").toLowerCase();
    const note = String((rv as any).note ?? (rv as any).notes ?? "").toLowerCase();
    return !q || name.includes(q) || phone.includes(q) || note.includes(q);
  });

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
  json(ctx, { ok: true, date: selected, items: filtered, ...summary });
});

export { ownerCalendarRouter };
export default ownerCalendarRouter;
