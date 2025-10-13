// /src/routes/owner_calendar.ts
// ניהול תפוסה יומי — Calendar לבעלים: יום/סלוט/חיפוש/סיכום + פעולות סלוט + SSE updates

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

import {
  getRestaurant,
  openingWindowsForDate,
  listRestaurants,
  type Restaurant,
  type Reservation,
} from "../database.ts";

import { readBody } from "./restaurants/_utils/body.ts";
import { buildDayTimeline, slotRange } from "../services/timeline.ts";
import { computeOccupancyForDay, summarizeDay } from "../services/occupancy.ts";

const ownerCalendarRouter = new Router();

/* ---------------- SSE Broker (in-memory) ---------------- */
type SseClient = {
  id: string;
  rid: string;
  date: string;
  send: (evt: string, data: unknown) => void;
  close: () => void;
};
const sseClients = new Set<SseClient>();

function ssePush(rid: string, date: string, evt: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ rid, date, ...data });
  let fanout = 0;
  for (const c of sseClients) {
    if (c.rid === rid && c.date === date) {
      try { c.send(evt, payload); fanout++; } catch { /* ignore */ }
    }
  }
  debugLog("owner_calendar", "SSE push", { evt, rid, date, fanout });
}

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

/** סטטוסים */
const ACTIVE_STATUSES = new Set([
  "approved","confirmed","booked","invited","arrived",
  "pending","request","requested","hold","on-hold","tentative"
]);
const INACTIVE_STATUSES = new Set(["cancelled","canceled","no-show","noshow","rejected","declined"]);
function isInactiveStatus(s: string | undefined | null) {
  const v = String(s ?? "").trim().toLowerCase();
  return INACTIVE_STATUSES.has(v);
}

/** בדיקת הרשאות + מציאת מסעדה עם fallback חכם (UUID/slug/שם/מזהה-חלקי) */
async function ensureOwnerAccess(ctx: any, rawRid: string): Promise<Restaurant> {
  const user = await requireOwner(ctx);
  const rid = decodeURIComponent(String(rawRid ?? "")).trim();
  if (!rid) ctx.throw(Status.BadRequest, "Missing restaurant id (rid)");

  // 1) ניסיון ישיר
  let r = await getRestaurant(rid) as Restaurant | null;

  // 2) fallback: slug/שם/מזהה-חלקי
  if (!r) {
    try {
      const all = await listRestaurants();
      const ridLower = rid.toLowerCase();
      r = all.find((x: any) => String(x.slug ?? "").toLowerCase() === ridLower) as any
        || all.find((x: any) => String(x.id ?? "").toLowerCase().startsWith(ridLower)) as any
        || all.find((x: any) => String(x.name ?? "").toLowerCase() === ridLower) as any
        || all.find((x: any) => String(x.name ?? "").toLowerCase().includes(ridLower)) as any;
    } catch (e) {
      debugLog("owner_calendar", "fallback listRestaurants failed", { error: String(e) });
    }
  }

  if (!r) ctx.throw(Status.NotFound, "Restaurant not found");

  const uid = String(user?.id ?? "");
  const ownerId = (r as any).ownerId != null ? String((r as any).ownerId) : "";
  const rUserId  = (r as any).userId  != null ? String((r as any).userId)  : "";
  const managers: string[] = Array.isArray((r as any).managerIds) ? (r as any).managerIds.map((x: any) => String(x)) : [];
  const isAdmin = !!(user as any)?.isAdmin || String((user as any)?.role ?? "").toLowerCase() === "admin";
  const unclaimed = !ownerId && !rUserId && managers.length === 0;
  const isManager = managers.includes(uid);
  const owned = ownerId === uid || rUserId === uid;

  if (isAdmin || owned || isManager || unclaimed) return r as Restaurant;
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

/* ---- Name/Phone enrichment ---- */
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
function pickCustomerFirstLastPhone(it: any) {
  // מסלולי נתונים נפוצים: customer, contact, fullName/name/customerName, phone/tel/mobile
  let first = String(it?.firstName ?? it?.customer?.firstName ?? it?.contact?.firstName ?? "");
  let last  = String(it?.lastName  ?? it?.customer?.lastName  ?? it?.contact?.lastName  ?? "");
  let phone =
    String(it?.phone ?? it?.customer?.phone ?? it?.contact?.phone ?? it?.tel ?? it?.mobile ?? "");

  const full = String(it?.fullName ?? it?.name ?? it?.customerName ?? "");
  if ((!first || !last) && full) {
    const s = splitName(full);
    if (!first) first = s.first;
    if (!last)  last  = s.last;
  }

  const notes = it?.note ?? it?.notes ?? "";
  if ((!first || !last || !phone) && notes) {
    const ext = extractFromNote(String(notes));
    if ((!first || !last) && ext.name) {
      const s = splitName(ext.name);
      if (!first) first = s.first;
      if (!last)  last  = s.last;
    }
    if (!phone && ext.phone) phone = ext.phone;
  }

  return { firstName: first, lastName: last, phone };
}

/* ---------- Body parser wrapper (BODY + QUERY fallback) ---------- */
async function readActionBody(ctx: any): Promise<any> {
  const sp = ctx.request.url.searchParams;
  const q: Record<string, unknown> = {};
  if (sp.has("action")) q.action = sp.get("action")!;
  if (sp.has("date"))   q.date   = sp.get("date")!;
  if (sp.has("time"))   q.time   = sp.get("time")!;
  if (sp.has("reservation")) {
    const raw = sp.get("reservation")!;
    try { q.reservation = JSON.parse(raw); } catch { q.reservation = raw; }
  }

  let body: any = {};
  try {
    const rb = await readBody(ctx);
    const payload = rb?.payload ?? rb ?? {};
    if (typeof payload === "string") {
      try { body = JSON.parse(payload); } catch { body = { reservation: payload }; }
    } else if (payload && typeof payload === "object") {
      body = payload;
    }
  } catch (e) {
    debugLog("owner_calendar", "readBody threw", { error: String(e) });
  }

  const merged = { ...q, ...body };
  debugLog("owner_calendar", "merged payload (query+body)", merged);
  return merged;
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
async function tryCreateWithVariants(fn: Function, rid: string, _r: Restaurant, date: string, time: string, payload: Record<string, unknown>) {
  const variants = [
    () => fn(rid, { ...payload, date, time }),
    () => fn({ restaurantId: rid, ...payload, date, time }),
    () => fn(rid, date, time, payload),
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
  const internalRid = (r as any).id ?? rid;

  const method = ctx.request.method;
  const ct = ctx.request.headers.get("content-type") || "";
  debugLog("owner_calendar", "handleSlotAction ENTER", { rid, internalRid, method, contentType: ct });

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

  // reservation may arrive as string
  let reservation: any = (body as any)?.reservation ?? {};
  if (typeof reservation === "string") {
    try { reservation = JSON.parse(reservation); } catch { reservation = {}; }
  }

  debugLog("owner_calendar", "Parsed action", { action, normalized, date, time, reservation });

  if (!["create", "update", "cancel", "arrived"].includes(normalized)) {
    ctx.throw(Status.BadRequest, `Unknown action: ${action}`);
  }
  if (!isISODate(date) || !isHHMM(time)) {
    ctx.throw(Status.BadRequest, "Bad date/time");
  }

  const db = await import("../database.ts");
  let result: any = null;

  if (normalized === "create") {
    const picked = pickCustomerFirstLastPhone(reservation);
    let firstName = (reservation?.firstName ?? picked.firstName ?? "").toString().trim();
    let lastName  = (reservation?.lastName  ?? picked.lastName  ?? "").toString().trim();
    let phone     = (reservation?.phone     ?? picked.phone     ?? "").toString().trim();

    const noteRaw = (reservation?.notes ?? reservation?.note ?? "").toString().trim();

    const { durationMinutes } = deriveCapacities(r);
    const user = (ctx.state as any)?.user;

    // ברירת מחדל לסטטוס: הזמנה ידנית = "booked" (ולא approved)
    const rawStatus = (reservation?.status ?? "").toString().trim().toLowerCase();
    const status = rawStatus || "booked";

    const payload: Record<string, unknown> = {
      firstName,
      lastName,
      phone,
      people   : Math.max(1, Number(reservation?.people ?? 1)),
      note     : noteRaw,
      status,

      restaurantId: internalRid,
      date,
      time,
      datetime: `${date}T${time}`,
      startsAt: `${date}T${time}`,
      durationMinutes,

      source: "owner-manual",
      channel: "owner",
      createdBy: user?.id ?? null,

      reservation_date: date,
      res_date: date,
      time_display: time,
      timeDisplay: time,
      reservationTime: time,

      activeOnlyForCapacity: true,
      ignoreCancelledForCapacity: true,
    };

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
      result = await tryCreateWithVariants(createFn, internalRid, r, date, time, payload);
    } catch (e) {
      debugLog("owner_calendar", "create failed (all variants)", { error: String(e) });
    }
    if (!result) ctx.throw(Status.InternalServerError, "Create reservation failed");
    debugLog("owner_calendar", "create result", { result });

    ssePush(internalRid, date, "reservation_create", { time });

  } else if (normalized === "update") {
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");

    const picked = pickCustomerFirstLastPhone(reservation);
    const patch: Partial<Reservation> = {
      firstName: reservation?.firstName ?? picked.firstName,
      lastName : reservation?.lastName  ?? picked.lastName,
      phone    : reservation?.phone     ?? picked.phone,
      people   : reservation?.people ? Number(reservation?.people) : undefined,
      note     : reservation?.notes ?? reservation?.note,
      status   : reservation?.status,
    } as any;

    if (isInactiveStatus(patch.status as any)) {
      (patch as any).people = 0;
      (patch as any).cancelledAt = new Date().toISOString();
    }

    if (!(db as any).updateReservationFields) ctx.throw(Status.NotImplemented, "updateReservationFields not implemented yet");
    result = await (db as any).updateReservationFields(id, patch);

    ssePush(internalRid, date, "reservation_update", { time });

  } else if (normalized === "cancel") {
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");

    if ((db as any).cancelReservation) {
      result = await (db as any).cancelReservation(id, String(reservation?.reason ?? ""));
    } else {
      if (!(db as any).updateReservationFields) ctx.throw(Status.NotImplemented, "cancelReservation/updateReservationFields not implemented yet");
      result = await (db as any).updateReservationFields(id, { status: "cancelled" } as any);
    }

    // אפס אנשים כדי לשחרר קיבולת גם אם DAL לא מסנן סטטוסים
    try {
      if ((db as any).updateReservationFields) {
        await (db as any).updateReservationFields(id, { people: 0, cancelledAt: new Date().toISOString() } as any);
      }
    } catch (e) {
      debugLog("owner_calendar", "post-cancel people=0 failed (non-fatal)", { error: String(e) });
    }

    ssePush(internalRid, date, "reservation_cancel", { time });

  } else if (normalized === "arrived") {
    const id = String(reservation?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).markArrived) ctx.throw(Status.NotImplemented, "markArrived not implemented yet");
    result = await (db as any).markArrived(id);

    ssePush(internalRid, date, "reservation_arrived", { time });
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
    rid: (r as any).id ?? rid,
    date: selected,
    restaurant: { id: (r as any).id, name: (r as any).name ?? "Restaurant" },
  });
});

// JSON — יום
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const internalRid = (r as any).id ?? rid;

  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(internalRid, selected)) ?? [];

  const effective = reservations.filter((rv: any) =>
    ACTIVE_STATUSES.has(String(rv?.status ?? "approved").toLowerCase())
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
  const internalRid = (r as any).id ?? rid;

  const date = ctx.request.url.searchParams.get("date");
  const time = ctx.request.url.searchParams.get("time");
  if (!isISODate(date) || !isHHMM(time)) ctx.throw(Status.BadRequest, "Bad date/time");

  const { slotMinutes, durationMinutes } = deriveCapacities(r);
  const range = slotRange(time!, durationMinutes, slotMinutes);

  const db = await import("../database.ts");
  const items: Reservation[] =
    (await (db as any).listReservationsCoveringSlot?.(internalRid, date!, time!, {
      slotMinutes,
      durationMinutes,
    })) ?? [];

  const enriched = items.map((it: any) => {
    const inactive = isInactiveStatus(it?.status);
    const picked = pickCustomerFirstLastPhone(it);

    return {
      id: it.id,
      firstName: picked.firstName,
      lastName : picked.lastName,
      phone    : picked.phone,
      people   : Number(inactive ? 0 : (it.people ?? 0)),
      status   : it.status ?? "booked",
      notes    : it.note ?? it.notes ?? "",
      at       : it.time ?? time,
    };
  });

  json(ctx, { ok: true, date, time, range, items: enriched });
});

// JSON — פעולות סלוט (תומך PATCH ו-POST)
ownerCalendarRouter.patch("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  await handleSlotAction(ctx);
});
ownerCalendarRouter.post("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  await handleSlotAction(ctx);
});

// JSON — חיפוש ליום
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/search", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const internalRid = (r as any).id ?? rid;

  const date = ctx.request.url.searchParams.get("date");
  const qraw = ctx.request.url.searchParams.get("q") ?? "";
  const q = qraw.trim().toLowerCase();

  if (!isISODate(date) || !q) ctx.throw(Status.BadRequest, "Bad date or empty query");

  const db = await import("../database.ts");
  const reservations: Reservation[] = (await (db as any).listReservationsByRestaurantAndDate?.(internalRid, date!)) ?? [];

  const matches = reservations.filter((rr: any) => {
    const picked = pickCustomerFirstLastPhone(rr);
    const f = String(picked.firstName ?? "").toLowerCase();
    const l = String(picked.lastName ?? "").toLowerCase();
    const phone = String(picked.phone ?? "").toLowerCase();
    const note = String(rr.note ?? rr.notes ?? "").toLowerCase();
    return f.includes(q) || l.includes(q) || phone.includes(q) || note.includes(q);
  });

  json(ctx, {
    ok: true,
    date,
    q: qraw,
    count: matches.length,
    items: matches.map((it: any) => {
      const picked = pickCustomerFirstLastPhone(it);
      return {
        id: it.id,
        time: it.time,
        firstName: picked.firstName ?? "",
        lastName: picked.lastName ?? "",
        people: Number(it.people ?? 0),
        status: it.status ?? "",
        phone: picked.phone ?? "",
        note: it.note ?? it.notes ?? "",
      };
    }),
  });
});

// JSON — סיכום יומי
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day/summary", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const internalRid = (r as any).id ?? rid;

  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = openingWindowsForDate(r, selected);
  const openWindows = mapOpenWindowsForTimeline(openWinsRaw);
  const timeline = buildDayTimeline(openWindows, slotMinutes);

  const db = await import("../database.ts");
  const reservations: Reservation[] =
    (await (db as any).listReservationsByRestaurantAndDate?.(internalRid, selected)) ?? [];

  const effective = reservations.filter((rv: any) =>
    ACTIVE_STATUSES.has(String(rv?.status ?? "approved").toLowerCase())
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

/* -------------- SSE endpoint -------------- */
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/events", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const internalRid = (r as any).id ?? rid;

  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  ctx.response.status = 200;
  ctx.response.headers.set("Content-Type", "text/event-stream; charset=utf-8");
  ctx.response.headers.set("Cache-Control", "no-cache");
  ctx.response.headers.set("Connection", "keep-alive");

  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (evt: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${evt}\n`));
        controller.enqueue(enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
      };
      const client: SseClient = {
        id: crypto.randomUUID(),
        rid: internalRid,
        date: selected,
        send,
        close: () => controller.close(),
      };
      sseClients.add(client);

      // hello + heartbeat
      send("hello", JSON.stringify({ rid: internalRid, date: selected, ts: Date.now() }));
      const t = setInterval(() => send("ping", Date.now()), 25000);

      ctx.request.signal.addEventListener("abort", () => {
        clearInterval(t);
        sseClients.delete(client);
        try { controller.close(); } catch {}
      });
    },
    cancel() { /* client closed */ },
  });
  ctx.response.body = body;
});

export { ownerCalendarRouter };
export default ownerCalendarRouter;
