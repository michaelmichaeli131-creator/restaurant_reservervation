// /src/routes/owner_calendar.ts
// ניהול תפוסה יומי — Calendar לבעלים: יום/סלוט/חיפוש/סיכום + פעולות סלוט + SSE events

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getStaffMembership } from "../services/authz.ts";
import { saveCalendarReservation, updateCalendarStatus, calendarAlternatives, inactive } from "../services/calendar_operations.ts";
import { kv } from "../database.ts";
import { debugLog } from "../lib/debug.ts";

import {
  getRestaurant,
  openingWindowsForDate,
  type Restaurant,
  type Reservation,
  getReservationPreferredLayoutId,
  getRoomLabelMapForRestaurant,
  normalizePhone,
} from "../database.ts";

import { readBody } from "./restaurants/_utils/body.ts";
import { buildDayTimeline, slotRange } from "../services/timeline.ts";
import { computeOccupancyForDay, summarizeDay } from "../services/occupancy.ts";
import { listFloorLayouts } from "../services/floor_service.ts";
import {
  createCalendarWaitlist, listCalendarWaitlist, updateCalendarWaitlistStatus,
  validateWaitlistDate,
} from "../services/calendar_waitlist.ts";
import { getRestaurantSystemNow, splitIsoParts } from "../services/system_time.ts";

import { calendarGuestRouter } from "./calendar_guest.ts";
const ownerCalendarRouter = new Router();
ownerCalendarRouter.use(calendarGuestRouter.routes(), calendarGuestRouter.allowedMethods());

/* ---------------- SSE infra (in-memory) ---------------- */
type SSEClient = {
  id: string;
  rid: string;
  date: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};
const channels = new Map<string, Set<SSEClient>>(); // key = `${rid}|${date}`

function chanKey(rid: string, date: string) {
  return `${rid}|${date}`;
}
function sseFormat(event: string, data?: unknown) {
  const lines = [`event: ${event}`];
  if (data !== undefined) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    lines.push(`data: ${payload}`);
  }
  lines.push("", ""); // שתי שורות ריקות כדי לסיים אירוע
  return lines.join("\n");
}
function broadcast(rid: string, date: string, event: string, data?: unknown) {
  const set = channels.get(chanKey(rid, date));
  if (!set || set.size === 0) return;
  const msg = sseFormat(event, data);
  for (const c of set) {
    try { c.send(event, data); } catch { /* ignore */ }
  }
}

/* ---------------- Helpers ---------------- */
function pad2(n: number) { return n.toString().padStart(2, "0"); }
function todayISO(ref?: Date): string {
  const d = ref ?? new Date();
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
  const user = ctx.state.user;
  if (!user) ctx.throw(Status.Unauthorized, "Sign in required");
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "Restaurant not found");
  const owner = r.ownerId === user.id || (r as any).userId === user.id;
  const member = owner ? null : await getStaffMembership(rid, user.id);
  const permission = ["GET", "HEAD"].includes(ctx.request.method) ? "reservations.view" : "reservations.manage";
  if (!owner && !(member?.approvalStatus === "approved" && member.status === "active" && member.permissions?.includes(permission))) {
    ctx.throw(Status.Forbidden, "Calendar permission required");
  }
  ctx.state.calendarIsOwner = owner;
  ctx.state.calendarCanManage = owner || !!member?.permissions?.includes("reservations.manage");
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

/* ---- Room-label lookup ---- */
async function buildRoomLabelMap(rid: string): Promise<Map<string, string>> {
  return await getRoomLabelMapForRestaurant(rid);
}

function extractLayoutIdFromReservation(r: any): string {
  return getReservationPreferredLayoutId(r as Reservation);
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

/**
 * Returning-guest counts for a batch of phones in ONE pass over the
 * restaurant's reservation index (instead of N countGuestVisits scans).
 * Returns a Map of normalizedPhone → visit count up to and including
 * `uptoDate`, excluding canceled/blocked reservations.
 */
async function computeVisitCounts(
  rid: string,
  phones: Array<string | undefined>,
  uptoDate: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const wanted = new Set<string>();
  for (const p of phones) {
    const n = normalizePhone(p);
    if (n) wanted.add(n);
  }
  if (!wanted.size) return counts;

  const db = await import("../database.ts");
  const all: Reservation[] =
    (await (db as any).listReservationsByRestaurant?.(rid).catch(() => [])) ?? [];

  const skip = new Set(["canceled", "cancelled", "blocked"]);
  for (const rv of all) {
    if (skip.has(String((rv as any)?.status ?? "").toLowerCase())) continue;
    if (uptoDate && String((rv as any)?.date ?? "") > uptoDate) continue;
    let phone = String((rv as any)?.phone ?? "");
    if (!phone) phone = extractFromNote(String((rv as any)?.note ?? "")).phone ?? "";
    const n = normalizePhone(phone);
    if (!n || !wanted.has(n)) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
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
    db?.createManualReservation ||
    db?.createReservationAtTime ||
    db?.addReservation ||
    db?.insertReservation ||
    db?.createReservation ||
    null
  );
}

async function tryCreateWithVariants(fn: Function, rid: string, r: Restaurant, date: string, time: string, payload: Record<string, unknown>) {
  // התאמת חתימות לפונקציות יצירה שונות
  const fnName = String((fn as any)?.name || "");
  const notes = (payload as any).notes ?? (payload as any).note ?? "";
  const preferredLayoutId = String((payload as any).preferredLayoutId ?? "").trim() || undefined;
  const manualData = {
    firstName: String((payload as any).firstName ?? ""),
    lastName : String((payload as any).lastName  ?? ""),
    phone    : String((payload as any).phone     ?? ""),
    people   : Number((payload as any).people ?? 1),
    notes    : String(notes ?? ""),
    date,
    time,
    status   : String((payload as any).status ?? "booked"),
    preferredLayoutId,
  };

  debugLog("owner_calendar", "tryCreateWithVariants input", { fnName, rid, date, time, manualData, payload });

  const variants: Array<() => Promise<any>> = [];

  // 1) createManualReservation(rid, data)
  if (fnName === "createManualReservation") {
    variants.push(() => (fn as any)(rid, manualData));
  }

  // 2) createReservationAtTime(rid, date, time, payload)
  if (fnName === "createReservationAtTime") {
    variants.push(() => (fn as any)(rid, date, time, payload));
  }

  // 3) add/insert-like: (rid, payload) או (rid, {...payload, date, time})
  if (fnName === "addReservation" || fnName === "insertReservation") {
    variants.push(() => (fn as any)(rid, payload));
    variants.push(() => (fn as any)(rid, { ...payload, date, time }));
  }

  // 4) generic object createReservation({...})
  if (fnName === "createReservation") {
    const fullReservation = {
      id: crypto.randomUUID(),
      restaurantId: rid,
      userId: `manual:${rid}`,
      date,
      time,
      people: Number((payload as any).people ?? 1),
      note: String(notes ?? ""),
      firstName: String((payload as any).firstName ?? ""),
      lastName: String((payload as any).lastName ?? ""),
      phone: String((payload as any).phone ?? ""),
      status: String((payload as any).status ?? "confirmed"),
      durationMinutes: Number((payload as any).durationMinutes ?? 120),
      ...(preferredLayoutId ? { preferredLayoutId } : {}),
      createdAt: Date.now(),
    };
    variants.push(() => (fn as any)(fullReservation));
  }

  // Fallbacks for unknown signatures
  variants.push(() => (fn as any)(rid, manualData));
  variants.push(() => (fn as any)(rid, date, time, payload));
  variants.push(() => (fn as any)(rid, payload));
  variants.push(() => (fn as any)(rid, { ...payload, date, time }));
  variants.push(() => (fn as any)({ restaurantId: rid, date, time, ...payload }));

  let lastErr: unknown = null;
  for (let i = 0; i < variants.length; i++) {
    const call = variants[i];
    try {
      const created = await call();
      debugLog("owner_calendar", "create variant succeeded", { fnName, variantIndex: i, created });
      return created;
    } catch (e) {
      lastErr = e;
      debugLog("owner_calendar", "create variant failed", { fnName, variantIndex: i, error: String(e) });
    }
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

  if (!["create", "update", "cancel", "arrived", "confirm_deposit", "refund_deposit"].includes(normalized)) {
    ctx.throw(Status.BadRequest, `Unknown action: ${action}`);
  }
  if (!isISODate(date) || !isHHMM(time)) {
    ctx.throw(Status.BadRequest, "Bad date/time");
  }

  const db = await import("../database.ts");
  let result: any;
  const id = String(reservation?.id ?? "");
  if (normalized !== "create") {
    const existing = id ? await db.getReservationById(id) : null;
    if (!existing || existing.restaurantId !== rid) ctx.throw(Status.NotFound, "Reservation not found");
  }
  try {
    if (normalized === "confirm_deposit" || normalized === "refund_deposit") {
      result = await db.updateReservationFields(id, { depositStatus: normalized === "confirm_deposit" ? "received" : "refunded" });
    } else {
      const patch: any = { ...reservation, id: normalized === "create" ? undefined : id };
      if (normalized === "create") Object.assign(patch, { date, time, status: "confirmed" });
      if (normalized === "cancel") patch.status = "canceled";
      if (normalized === "arrived") patch.status = "arrived";
      result = await saveCalendarReservation(rid, patch, ctx.state.user.id);
    }
  } catch (error) {
    json(ctx, { ok: false, error: error instanceof Error ? error.message : "Unable to save" }, error instanceof RangeError ? 400 : 409);
    return;
  }
  broadcast(rid, date, "reservation_update", { time, date, rid, id: result?.id });
  debugLog("owner_calendar", "Slot action result", { result });
  json(ctx, { ok: true, result });
}

/* ---------------- Routes ---------------- */

// HTML
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const systemNow = await getRestaurantSystemNow(rid);
  const systemNowParts = splitIsoParts(systemNow);
  const selected = isISODate(date) ? date! : todayISO(systemNow);

  await render(ctx, "owner_calendar", {
    page: "owner_calendar",                // ✅ חשוב לטעינת src/i18n/pages/owner_calendar.<lang>.json
    title: "ניהול תפוסה יומי",
    rid,
    date: selected,
    userId: String(ctx.state?.user?.id ?? "owner"),
    canManage: ctx.state.calendarCanManage,
    restaurant: { id: r.id, name: (r as any).name ?? "Restaurant" },
    r: { id: r.id, name: (r as any).name ?? "Restaurant" },
    systemNowIso: systemNowParts.iso,
    systemNowDate: systemNowParts.date,
    systemNowTime: systemNowParts.time,
  });
});

// JSON — יום (מסנן סטטוסים לא פעילים כדי שהצבעים יתעדכנו אחרי cancel)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const systemNow = await getRestaurantSystemNow(rid);
  const systemNowParts = splitIsoParts(systemNow);
  const selected = isISODate(date) ? date! : todayISO(systemNow);

  const { capacityPeople, capacityTables, slotMinutes: bookingSlotMinutes, durationMinutes } = deriveCapacities(r);
  const slotMinutes = ctx.request.url.searchParams.get("displayMinutes") === "15" ? 15 : 30;

  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const inactive = new Set(["cancelled","canceled","rejected","declined","no-show","noshow","no_show","rescheduled","completed"]);
  const effective = reservations.filter((rv: any) => !inactive.has(String(rv?.status ?? "").toLowerCase()));

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

  // Per-room occupancy breakdown at the restaurant-wide current clock time
  const roomLabelMap = await buildRoomLabelMap(rid);
  const layouts = await listFloorLayouts(rid).catch(() => []);
  const currentTime = systemNowParts.time;
  const coveringSlot = (rv: any) => {
    const start = String((rv as any)?.time ?? "");
    if (!/^\d{2}:\d{2}$/.test(start)) return false;
    const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
    const startMin = toMin(start);
    const endMin = startMin + Number(rv.durationMinutes || durationMinutes);
    const target = toMin(currentTime);
    return target >= startMin && target < endMin;
  };

  const roomOccupancy: Array<{ id: string; label: string; capacity: number; usedPeople: number; remainingPeople: number; percent: number }> = [];
  for (const [layoutId, label] of roomLabelMap) {
    const layoutReservations = effective.filter((rv: any) => extractLayoutIdFromReservation(rv) === layoutId && coveringSlot(rv));
    const usedPeople = layoutReservations.reduce((sum: number, rv: any) => sum + Number((rv as any).people ?? 0), 0);
    const layout = layouts.find((l: any) => l.id === layoutId);
    const cap = Number((layout as any)?.capacity ?? 0) || (layout as any)?.tables?.reduce((s: number, t: any) => s + (Number(t?.seats) || 0), 0) || 0;
    const remainingPeople = Math.max(0, cap - usedPeople);
    const percent = cap > 0 ? Math.max(0, Math.min(100, Math.round((usedPeople / cap) * 100))) : 0;
    roomOccupancy.push({ id: layoutId, label, capacity: cap, usedPeople, remainingPeople, percent });
  }

  json(ctx, {
    ok: true,
    date: selected,
    openWindows: openWinsRaw,
    bookingSlotMinutes,
    slotMinutes,
    capacityPeople,
    capacityTables,
    slots: occupancy,
    roomOccupancy,
    currentTime: {
      iso: systemNowParts.iso,
      date: selected,
      time: currentTime,
      sourceDate: systemNowParts.date,
    },
  });
});

// Calendar v2 waitlist: owner-scoped management, independent of reservations.
// Public signup and reservation conversion have separate auth/capacity requirements.
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/waitlist", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date") ?? "";
  try {
    validateWaitlistDate(date);
  } catch {
    ctx.throw(Status.BadRequest, "Invalid waitlist date");
  }
  const items = await listCalendarWaitlist(rid, date);
  json(ctx, {
    ok: true, date, items,
    waiting: items.filter((item) => item.status === "waiting").length,
    offered: items.filter((item) => item.status === "offered").length,
  });
});

ownerCalendarRouter.post("/owner/restaurants/:rid/calendar/waitlist", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const { payload } = await readBody(ctx);
  if (!payload || typeof payload !== "object") ctx.throw(Status.BadRequest, "Invalid request");
  try {
    // This operation creates a request on the waitlist, NOT a reservation.
    // In particular, it never consumes a table or changes occupancy.
    const item = await createCalendarWaitlist(rid, payload, "staff");
    json(ctx, { ok: true, item }, Status.Created);
  } catch (error) {
    if (error instanceof RangeError) ctx.throw(Status.BadRequest, error.message);
    throw error;
  }
});

ownerCalendarRouter.patch("/owner/restaurants/:rid/calendar/waitlist/:wid", async (ctx) => {
  const { rid, wid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const { payload } = await readBody(ctx);
  const date = String(payload?.date ?? "");
  const status = String(payload?.status ?? "");
  try {
    const item = await updateCalendarWaitlistStatus(
      rid, date, wid,
      status as "waiting" | "offered" | "cancelled",
    );
    if (!item) ctx.throw(Status.NotFound, "Waitlist entry not found");
    json(ctx, { ok: true, item });
  } catch (error) {
    if (error instanceof RangeError) ctx.throw(Status.BadRequest, error.message);
    if (error instanceof Error && error.message.startsWith("Waitlist entry changed")) {
      ctx.throw(Status.Conflict, error.message);
    }
    throw error;
  }
});


function calendarMatches(item: any, params: URLSearchParams) {
  const status = String(item.status || "new").replace("canceled", "cancelled");
  const wanted = params.get("status");
  if (wanted && wanted !== "all" && status !== wanted) return false;
  const room = params.get("room");
  if (room && getReservationPreferredLayoutId(item) !== room) return false;
  const kind = params.get("kind");
  if (kind && kind !== "all" && (item.calendarKind || "reservation") !== kind) return false;
  const q = (params.get("q") || "").trim().toLowerCase();
  return !q || [item.firstName, item.lastName, item.phone, item.eventTitle, item.note, item.roomLabel].some(v => String(v || "").toLowerCase().includes(q));
}

ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/resources", async (ctx) => {
  const { rid } = ctx.params;
  const restaurant = await ensureOwnerAccess(ctx, rid);
  json(ctx, { ok: true, layouts: await listFloorLayouts(rid), duration: (restaurant as any).serviceDurationMinutes || 120, canManage: ctx.state.calendarCanManage, isOwner: ctx.state.calendarIsOwner });
});
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/alternatives", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  try { json(ctx, {ok: true, items: await calendarAlternatives(rid, Object.fromEntries(ctx.request.url.searchParams))}); }
  catch (error) { json(ctx, {ok: false, error: error instanceof Error ? error.message : "Unable to check availability"}, 400); }
});
ownerCalendarRouter.post("/owner/restaurants/:rid/calendar/status", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const { payload } = await readBody(ctx);
  try {
    const item = await updateCalendarStatus(rid, payload, ctx.state.user.id);
    broadcast(rid, item.date, "reservation_update", {date: item.date, time: item.time});
    json(ctx, {ok: true, item});
  } catch (error) { json(ctx, {ok: false, error: error instanceof Error ? error.message : "Unable to update status"}, 409); }
});
ownerCalendarRouter.post("/owner/restaurants/:rid/calendar/save", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const { payload } = await readBody(ctx);
  try {
    const item = await saveCalendarReservation(rid, payload, ctx.state.user.id, payload.waitlistId);
    broadcast(rid, item.date, "reservation_update", { date: item.date, time: item.time });
    json(ctx, { ok: true, item });
  } catch (error) { json(ctx, { ok: false, error: error instanceof Error ? error.message : "Unable to save" }, error instanceof RangeError ? 400 : 409); }
});
ownerCalendarRouter.delete("/owner/restaurants/:rid/calendar/waitlist/:wid", async (ctx) => {
  const { rid, wid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date") || "";
  try { validateWaitlistDate(date); } catch { ctx.throw(400, "Invalid date"); }
  await kv.delete(["calendar_waitlist_v2", rid, date, wid]);
  json(ctx, { ok: true });
});

// Calendar 2.0: read-only day agenda, based on the existing reservation index.
// Never treat occupancy estimates as actual guest reservations.
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/agenda", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  if (!isISODate(date)) ctx.throw(Status.BadRequest, "Bad date");
  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(rid, date!)) ?? [];
  const rooms = await buildRoomLabelMap(rid);
  const items = reservations.map((item: any) => {
    const layoutId = extractLayoutIdFromReservation(item);
    return {
      id: String(item.id ?? ""),
      time: String(item.time ?? ""),
      firstName: String(item.firstName ?? ""),
      lastName: String(item.lastName ?? ""),
      phone: String(item.phone ?? ""),
      people: Number(item.people ?? 0),
      status: String(item.status ?? "new"),
      roomLabel: layoutId ? (rooms.get(layoutId) ?? "") : "",
      occasion: String(item.occasion ?? ""),
      dietary: Array.isArray(item.dietary) ? item.dietary.map((d: unknown) => String(d)) : [],
      durationMinutes: Number(item.durationMinutes ?? 0),
      updatedAt: item.updatedAt,
      date, preferredLayoutId: layoutId, tableId: String(item.tableId || ""),
      calendarKind: item.calendarKind || "reservation", eventTitle: item.eventTitle || "", note: item.note || "",
      depositStatus: String(item.depositStatus ?? ""),
    };
  }).filter((item) => calendarMatches(item, ctx.request.url.searchParams)).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  json(ctx, { ok: true, date, items });
});

// Calendar 2.0 monthly counts; one authorized request, bounded database concurrency.
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/month", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const month = ctx.request.url.searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) ctx.throw(Status.BadRequest, "Bad month");
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const db = await import("../database.ts");
  const days: Array<{ date: string; reservations: number; guests: number }> = [];
  for (let start = 1; start <= daysInMonth; start += 5) {
    const batch = Array.from({ length: Math.min(5, daysInMonth - start + 1) }, (_, i) => {
      const date = `${month}-${String(start + i).padStart(2, "0")}`;
      return { date };
    });
    const results = await Promise.all(batch.map(async ({ date }) => {
      const reservations: Reservation[] =
        (await (db as any).listReservationsByRestaurantAndDate(rid, date)) ?? [];
      // Keep monthly booking counts consistent with the active day view.
      // No-shows, declined requests and blocked operational slots are not
      // confirmed guest bookings; they will have separate event metrics.
      const inactive = new Set([
        "canceled", "cancelled", "rescheduled", "rejected", "declined",
        "no-show", "noshow", "no_show", "blocked",
      ]);
      const filtered = reservations.filter((r) => calendarMatches(r, ctx.request.url.searchParams));
      const active = filtered.filter((r) => !inactive.has(String(r.status ?? "new").toLowerCase()) && !(r as any).calendarKind?.match(/event|block/));
      return {
        date,
        reservations: active.length,
        events: filtered.filter((r: any) => ["event", "block"].includes(r.calendarKind) && !["canceled", "cancelled"].includes(r.status)).length,
        guests: active.reduce((total, r) => total + Math.max(0, Number(r.people) || 0), 0),
      };
    }));
    days.push(...results);
  }
  json(ctx, { ok: true, month, days });
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

  const roomLabelMap = await buildRoomLabelMap(rid);

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

    const inactive = new Set(["cancelled","canceled","rejected","declined","no-show","noshow","no_show","rescheduled","completed"]);
    const people = inactive.has(String(it.status ?? "").toLowerCase()) ? 0 : Number(it.people ?? 0);

    const layoutId = extractLayoutIdFromReservation(it);
    const roomLabel = layoutId ? (roomLabelMap.get(layoutId) ?? "") : "";

    return {
      id: it.id,
      firstName: first,
      lastName: last,
      phone,
      people,
      status: it.status ?? "approved",
      notes,
      at: it.time ?? time,
      roomLabel,
      occasion: typeof it.occasion === "string" ? it.occasion : "",
      dietary: Array.isArray(it.dietary) ? it.dietary.map((d: unknown) => String(d)) : [],
      depositStatus: it.depositStatus,
      depositAmount: it.depositAmount,
      depositCurrency: it.depositCurrency,
    };
  });

  // Returning-guest recognition: one index pass for all drawer items.
  const visitCounts = await computeVisitCounts(rid, enriched.map((e) => e.phone), date!);
  const items2 = enriched.map((e) => {
    const n = normalizePhone(e.phone);
    const c = n ? (visitCounts.get(n) ?? 0) : 0;
    return c >= 2 ? { ...e, visitCount: c } : e;
  });

  json(ctx, {
    ok: true,
    date,
    time,
    range,
    items: items2,
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
    const phone = String(r.phone ?? "").toLowerCase();
    const note = String(r.note ?? r.notes ?? "").toLowerCase();
    return f.includes(q) || l.includes(q) || phone.includes(q) || note.includes(q);
  });

  const roomLabelMap = await buildRoomLabelMap(rid);

  // Returning-guest recognition: one index pass for all matched items.
  const visitCounts = await computeVisitCounts(
    rid,
    matches.map((it: any) => String(it.phone ?? "")),
    date!,
  );

  json(ctx, {
    ok: true,
    date,
    q: qraw,
    count: matches.length,
    items: matches.map((it: any) => {
      const layoutId = extractLayoutIdFromReservation(it);
      const roomLabel = layoutId ? (roomLabelMap.get(layoutId) ?? "") : "";
      const np = normalizePhone(String(it.phone ?? ""));
      const visits = np ? (visitCounts.get(np) ?? 0) : 0;
      return {
        ...(visits >= 2 ? { visitCount: visits } : {}),
        id: it.id,
        time: it.time,
        firstName: it.firstName ?? "",
        lastName: it.lastName ?? "",
        people: Number(it.people ?? 0),
        status: it.status ?? "",
        phone: it.phone ?? "",
        note: it.note ?? it.notes ?? "",
        roomLabel,
        occasion: typeof it.occasion === "string" ? it.occasion : "",
        dietary: Array.isArray(it.dietary) ? it.dietary.map((d: unknown) => String(d)) : [],
      };
    }),
  });
});

// JSON — סיכום יומי (אותו סינון סטטוסים)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/summary", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);

  const date = ctx.request.url.searchParams.get("date");
  const systemNow = await getRestaurantSystemNow(rid);
  const selected = isISODate(date) ? date! : todayISO(systemNow);

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(rid, selected)) ?? [];

  const inactive = new Set(["cancelled","canceled","rejected","declined","no-show","noshow","no_show","rescheduled","completed"]);
  const effective = reservations.filter((rv: any) =>
    !inactive.has(String(rv?.status ?? "").toLowerCase())
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
  const bookings = reservations.filter((rv: any) => !inactive.has(String(rv.status || "new")) && rv.status !== "blocked" && !["event","block"].includes(rv.calendarKind));
  summary.totalReservations = bookings.length;
  summary.totalGuests = bookings.reduce((n,rv) => n + Number(rv.people || 0),0);
  summary.cancelled = reservations.filter(rv => ["canceled","cancelled"].includes(String(rv.status))).length;
  summary.noShow = reservations.filter(rv => ["no_show","no-show","noshow"].includes(String(rv.status))).length;
  json(ctx, { ok: true, date: selected, ...summary });
});

/* ---------- SSE endpoint ---------- */
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/events", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const systemNow = await getRestaurantSystemNow(rid);
  const selected = isISODate(date) ? date! : todayISO(systemNow);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "text/event-stream; charset=utf-8");
  ctx.response.headers.set("Cache-Control", "no-cache, no-transform");
  ctx.response.headers.set("Connection", "keep-alive");

  // יוצרים Stream סשן
  const stream = new ReadableStream({
    start(controller) {
      const id = crypto.randomUUID();
      const key = chanKey(rid, selected);

      const send = (event: string, data: unknown) => {
        controller.enqueue(new TextEncoder().encode(sseFormat(event, data)));
      };
      const close = () => {
        try { controller.close(); } catch { /* ignore */ }
      };

      const client: SSEClient = { id, rid, date: selected, send, close };
      if (!channels.has(key)) channels.set(key, new Set());
      channels.get(key)!.add(client);

      // hello + pingים
      send("hello", { rid, date: selected, id });
      const pingTimer = setInterval(() => send("ping", { t: Date.now() }), 25000);

      // ניקוי כשנסגר
      (ctx.request as any).raw?.signal?.addEventListener?.("abort", () => {
        clearInterval(pingTimer);
        channels.get(key)?.delete(client);
      });
      (ctx.response as any).raw?.signal?.addEventListener?.("abort", () => {
        clearInterval(pingTimer);
        channels.get(key)?.delete(client);
      });
    },
    cancel() {
      // הדפדפן סגר — אין צורך לעשות עוד משהו, ה־abort מאזין כבר מחק את הלקוח
    },
  });

  ctx.response.body = stream;
});

export { ownerCalendarRouter };
export default ownerCalendarRouter;
