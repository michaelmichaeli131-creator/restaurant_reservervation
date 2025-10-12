// /src/routes/owner_calendar.ts
// ניהול תפוסה יומי — לוח שנה → יום → רבעי שעה (בעלים בלבד)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

// שכבת נתונים
import {
  getRestaurant,
  openingWindowsForDate, // כמו בקוד שעבד: נקרא עם r ולא עם r.id
  type Restaurant,
  type Reservation,
} from "../database.ts";

// Utilities קיימים בפרויקט
import { readBody as readBodyUtil } from "./restaurants/_utils/body.ts";

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
function isHHMM(s?: string | null): s is string { return !!s && /^\d{2}:\d{2}$/.test(s ?? ""); }
function json(ctx: any, data: unknown, status = Status.OK) {
  ctx.response.status = status;
  ctx.response.type = "application/json; charset=utf-8";
  ctx.response.body = data;
}
function lower(s?: string) { return String(s ?? "").trim().toLowerCase(); }

/** פענוח קשיח של גוף הבקשה לכל סוגי ה-Content-Type + נפילה לאחור ל-querystring */
async function readActionPayload(ctx: any): Promise<{
  action: string;
  date: string;
  time: string;
  reservation: Record<string, unknown>;
  raw: any;
}> {
  const url = new URL(ctx.request.url);
  const qs = url.searchParams;

  // נסה קודם את util אם קיים
  let body: any = null;
  try {
    body = await readBodyUtil(ctx);
  } catch { /* נמשיך לפענוח ידני */ }

  // אם לא חזר / ריק — פענוח ידני לפי Content-Type
  if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
    const ct = lower(ctx.request.headers.get("content-type"));
    try {
      if (ct.includes("application/json")) {
        body = await ctx.request.json();
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        const txt = await ctx.request.text();
        const sp = new URLSearchParams(txt);
        body = Object.fromEntries(sp.entries());
      } else if (ct.includes("multipart/form-data")) {
        const fd = await ctx.request.formData();
        const obj: Record<string, unknown> = {};
        for (const [k, v] of fd.entries()) obj[k] = v;
        body = obj;
      } else {
        // ננסה גם קריאת טקסט פשוטה
        const txt = await ctx.request.text().catch(() => "");
        if (txt) {
          try { body = JSON.parse(txt); } catch { body = {}; }
        } else {
          body = {};
        }
      }
    } catch {
      // כלום — נשען על querystring בלבד
      body = {};
    }
  }

  // איסוף שדות מרכזיים עם fallback ל-querystring
  const actionRaw =
    body?.action ??
    qs.get("action") ??
    body?.op ??
    body?.cmd ??
    body?.type ??
    "";

  const actionMap: Record<string, string> = {
    add: "create",
    create: "create",
    new: "create",
    update: "update",
    edit: "update",
    cancel: "cancel",
    delete: "cancel",
    arrived: "arrived",
    checkin: "arrived",
    check_in: "arrived",
    checkin_ok: "arrived",
  };

  const actionNorm = actionMap[lower(String(actionRaw))] || lower(String(actionRaw));

  const date =
    String(body?.date ?? qs.get("date") ?? "").trim();

  const time =
    String(body?.time ?? qs.get("time") ?? "").trim();

  // reservation יכול להגיע או כשדה עליון או תחת body.reservation
  const reservation =
    (typeof body?.reservation === "object" && body?.reservation) ?
      body.reservation as Record<string, unknown> :
      body;

  debugLog("owner_calendar", "PATCH readActionPayload", {
    ct: ctx.request.headers.get("content-type"),
    keys: Object.keys(body || {}),
    actionRaw,
    actionNorm,
    date,
    time,
  });

  return { action: actionNorm, date, time, reservation, raw: body };
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

// JSON — יום (טווחי פתיחה בלבד)
ownerCalendarRouter.get("/owner/restaurants/:rid/calendar/day", async (ctx) => {
  const { rid } = ctx.params;
  const r = await ensureOwnerAccess(ctx, rid);
  const date = ctx.request.url.searchParams.get("date");
  const selected = isISODate(date) ? date! : todayISO();

  const { capacityPeople, capacityTables, slotMinutes, durationMinutes } = deriveCapacities(r);

  const openWinsRaw = openingWindowsForDate(r, selected); // ← כמו שעבד אצלך
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

// JSON — פעולות סלוט: create/update/cancel/arrived (עם פענוח חכם של action)
ownerCalendarRouter.patch("/owner/restaurants/:rid/calendar/slot", async (ctx) => {
  const { rid } = ctx.params;
  await ensureOwnerAccess(ctx, rid);

  const { action, date, time, reservation } = await readActionPayload(ctx);

  if (!["create", "update", "cancel", "arrived"].includes(action)) {
    debugLog("owner_calendar", "PATCH invalid action", { action, date, time, keys: Object.keys(reservation || {}) });
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
      firstName: String((reservation as any)?.firstName ?? "").trim(),
      lastName: String((reservation as any)?.lastName ?? "").trim(),
      phone: String((reservation as any)?.phone ?? "").trim(),
      people: Number((reservation as any)?.people ?? 0),
      note: String((reservation as any)?.notes ?? (reservation as any)?.note ?? "").trim(),
      status: String((reservation as any)?.status ?? "approved"),
      date,
      time,
      source: "owner",
    };

    if (!payload.firstName || !payload.lastName || !payload.people) {
      ctx.throw(Status.BadRequest, "Missing fields");
    }

    const hasManual = typeof (db as any).createManualReservation === "function";
    const hasCreate = typeof (db as any).createReservation === "function";

    if (hasManual) {
      result = await (db as any).createManualReservation(rid, payload);
    } else if (hasCreate) {
      result = await (db as any).createReservation(rid, payload);
    } else {
      ctx.throw(Status.NotImplemented, "createReservation is not available in database.ts");
    }
  }

  if (action === "update") {
    const id = String((reservation as any)?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    const patch: Partial<Reservation> = {
      firstName: (reservation as any)?.firstName,
      lastName: (reservation as any)?.lastName,
      phone: (reservation as any)?.phone,
      people: (reservation as any)?.people ? Number((reservation as any)?.people) : undefined,
      note: (reservation as any)?.notes ?? (reservation as any)?.note,
      status: (reservation as any)?.status,
    } as any;
    if (!(db as any).updateReservationFields) ctx.throw(Status.NotImplemented, "updateReservationFields not implemented yet");
    result = await (db as any).updateReservationFields(id, patch);
  }

  if (action === "cancel") {
    const id = String((reservation as any)?.id ?? "");
    if (!id) ctx.throw(Status.BadRequest, "Missing reservation.id");
    if (!(db as any).cancelReservation) ctx.throw(Status.NotImplemented, "cancelReservation not implemented yet");
    result = await (db as any).cancelReservation(id, String((reservation as any)?.reason ?? ""));
  }

  if (action === "arrived") {
    const id = String((reservation as any)?.id ?? "");
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

  const openWinsRaw = openingWindowsForDate(r, selected); // ← כמו שעבד
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
