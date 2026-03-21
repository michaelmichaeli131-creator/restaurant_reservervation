// src/routes/host.ts
// מסך מארחת: מפת מסעדה + הושבת הזמנה לשולחן/ות + שחרור שולחנות + אינפורמציה על שולחן + עדכון סטטוס הזמנה

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireStaff } from "../lib/auth.ts";
import { requireRestaurantAccess } from "../services/authz.ts";

import {
  getRestaurant,
  listReservationsFor,
  setReservationStatus,
  getReservationById,
  enrichReservationsWithRoomMeta,
} from "../database.ts";

import {
  listOpenOrdersByRestaurant,
  getOrCreateOpenOrder,
  closeOrderForTable,
  listTableAccounts,
} from "../pos/pos_db.ts";

import {
  listFloorSections,
  getTableIdByNumber,
  getTableNumberById,
  ensureTableNumberById,
  markTableDirty,
  computeAllTableStatuses as computeLiveTableStatuses,
} from "../services/floor_service.ts";

import {
  seatReservation,
  unseatTable,
  getSeatingByTable,
} from "../services/seating_service.ts";
import { getRestaurantSystemNow, splitIsoParts } from "../services/system_time.ts";

export const hostRouter = new Router();


function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractMetaFromNote(noteValue: unknown): { name: string; phone: string } {
  const note = normalizeText(noteValue);
  if (!note) return { name: "", phone: "" };
  const nameMatch = note.match(/(?:Name|Guest|Customer)\s*:\s*([^;\n\r]+)/i);
  const phoneMatch = note.match(/(?:Phone|Tel|Mobile)\s*:\s*([^;\n\r]+)/i);
  return {
    name: nameMatch ? nameMatch[1].trim() : "",
    phone: phoneMatch ? phoneMatch[1].trim() : "",
  };
}

function extractNameFromReservationLike(res: any): string {
  const firstName = normalizeText(res?.firstName);
  const lastName = normalizeText(res?.lastName);
  const full = `${firstName} ${lastName}`.trim();
  if (full) return full;

  const directName = normalizeText(res?.name);
  if (directName) return directName;

  const meta = extractMetaFromNote(res?.note ?? res?.notes);
  if (meta.name) return meta.name;

  return "";
}


/** לוג עזר למסך המארחת */
function hlog(...args: unknown[]) {
  try {
    console.log("[HOST]", ...args);
  } catch {
    // ignore
  }
}

function barDebug(stage: string, payload?: unknown) {
  try {
    console.log(`[BAR_DEBUG][host] ${stage}`, payload ?? {});
  } catch {
    // ignore
  }
}

function toIntLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function resolveRestaurantIdForRequest(ctx: any, rid: string): string | null {
  const user = ctx.state.user;

  // עבור staff: אם לא נשלח restaurantId בבקשה, נשתמש במסעדה שננעלה במידלוור.
  if (user?.role === "staff") {
    const locked = (ctx.state as any).staffRestaurantId as string | null;
    const effective = rid || locked || "";
    if (!effective) {
      ctx.response.status = 403;
      ctx.response.body = "No restaurant access";
      return null;
    }
    // אם נשלח rid והוא לא תואם לנעילה — חסימה.
    if (rid && locked && rid !== locked) {
      ctx.response.status = 403;
      ctx.response.body = "No restaurant access";
      return null;
    }
    return effective;
  }

  return rid;
}

/** קריאת body גמישה: JSON / form / text (עם ניסיון ל־JSON) */
async function readJsonLikeBody(ctx: any): Promise<any> {
  const req: any = ctx.request;
  const body = req.body;
  if (!body) return {};

  try {
    if (body.type === "json") {
      const v = await body.value;
      return v ?? {};
    }

    if (body.type === "form") {
      const form = await body.value;
      if (form && typeof form === "object" && "entries" in form) {
        return Object.fromEntries((form as any).entries());
      }
      return form ?? {};
    }

    const v = await body.value;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return {};
      }
    }

    return v ?? {};
  } catch (err) {
    hlog("readJsonLikeBody ERROR", String(err));
    return {};
  }
}

function mergeSeatBarQueryFallback(bodyData: any, ctx: any): any {
  const data = (bodyData && typeof bodyData === "object") ? { ...bodyData } : {};
  const sp = ctx.request?.url?.searchParams;
  if (!sp) return data;

  const setIfMissing = (key: string, ...aliases: string[]) => {
    const hasBodyValue = [key, ...aliases].some((name) => {
      const v = (data as any)?.[name];
      if (Array.isArray(v)) return v.length > 0;
      return v !== undefined && v !== null && String(v).trim() !== "";
    });
    if (hasBodyValue) return;
    for (const name of [key, ...aliases]) {
      const qv = sp.get(name);
      if (qv != null && String(qv).trim() !== "") {
        (data as any)[key] = qv;
        return;
      }
    }
  };

  setIfMissing("restaurantId", "rid");
  setIfMissing("reservationId");
  setIfMissing("table", "tableNumber");
  setIfMissing("tableId");
  setIfMissing("guestName");

  const existingSeatIds = Array.isArray((data as any)?.seatIds)
    ? (data as any).seatIds.map((v: any) => String(v ?? "").trim()).filter(Boolean)
    : [];
  if (!existingSeatIds.length) {
    const repeated = sp.getAll("seatIds").map((v) => String(v ?? "").trim()).filter(Boolean);
    const csv = String(sp.get("seatIdsCsv") ?? sp.get("seatIds") ?? "").trim();
    const parsedCsv = csv
      ? csv.split(",").map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const merged = Array.from(new Set([...repeated, ...parsedCsv]));
    if (merged.length) (data as any).seatIds = merged;
  }

  return data;
}

/** חישוב סטטוס לכל שולחן (תפוס/פנוי) על סמך הזמנות פתוחות (POS Orders) */
async function computeAllTableStatuses(
  rid: string,
  tablesFlat: Array<{ id: string; tableNumber: number }>,
) {
  const openOrders = await listOpenOrdersByRestaurant(rid);
  const occupiedByTable = new Set<number>(
    (openOrders ?? []).map((o: any) => Number(o.table)),
  );

  return tablesFlat.map((t) => ({
    tableId: t.id,
    tableNumber: t.tableNumber,
    status: occupiedByTable.has(Number(t.tableNumber)) ? "occupied" : "empty",
  }));
}

/** טעינת כל ההזמנות "הפעילות" של היום למסך המארחת, בפורמט נוח לתצוגה */
async function loadHostReservations(rid: string) {
  const d = await getRestaurantSystemNow(rid);
  const date = `${d.getFullYear()}-${
    String(d.getMonth() + 1).padStart(2, "0")
  }-${String(d.getDate()).padStart(2, "0")}`;

  const all = await listReservationsFor(rid, date);

  const active = (all ?? []).filter((res: any) => {
    const st = String(res.status ?? "new").toLowerCase();
    const doneStatuses = [
      "arrived",
      "seated",
      "cancelled",
      "canceled",
      "no_show",
      "noshow",
    ];
    return !doneStatuses.includes(st);
  });

  const withRoomMeta = await enrichReservationsWithRoomMeta(rid, active as any[]);

  return withRoomMeta.map((res: any) => {
    const name = extractNameFromReservationLike(res) || "—";
    const status = String(res.status ?? "new").toLowerCase();
    return {
      id: res.id,
      time: res.time,
      people: res.people,
      name,
      roomLabel: res.roomLabel || res.preferredLayoutLabel || "",
      status,
      sortName: name.toLocaleLowerCase(),
      sortTime: String(res.time || ""),
      createdAt: Number(res.createdAt || 0),
    };
  });
}

/** GET /host – נוח לעובדים: מסעדה ננעלת מה־StaffMember */
hostRouter.get("/host", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForRequest(ctx, "");
  if (!rid) return;
  ctx.response.redirect(`/host/${rid}`);
});

/** GET /host/:rid – עמוד המארחת עם מפת המסעדה והזמנות להיום */
hostRouter.get("/host/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return; // דורש לוגין

  const user = ctx.state.user;
  hlog("GET /host/:rid", {
    rid: ctx.params.rid,
    userId: user?.id,
    role: user?.role,
  });

  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForRequest(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const r = await getRestaurant(rid);
  if (!r) {
    hlog("restaurant not found", { rid });
    ctx.throw(Status.NotFound, "restaurant not found");
  }

  const reservations = await loadHostReservations(rid);
  const sections = await listFloorSections(rid);
  const systemNow = await getRestaurantSystemNow(rid);
  const systemNowParts = splitIsoParts(systemNow);

  const tablesFlat: Array<{ id: string; tableNumber: number }> = [];
  for (const s of sections ?? []) {
    for (const t of (s.tables ?? [])) {
      tablesFlat.push({ id: t.id, tableNumber: Number(t.tableNumber) });
    }
  }

  const statuses = await computeLiveTableStatuses(rid, tablesFlat);

  hlog("render host page", {
    rid,
    reservationsCount: reservations.length,
    sectionsCount: (sections ?? []).length,
    tablesCount: tablesFlat.length,
  });

  await render(ctx, "host_seating", {
    page: "host",
    title: `מארחת · ${r.name}`,
    restaurant: r,
    rid,
    sections,
    statuses,
    reservations,
    systemNowIso: systemNowParts.iso,
    systemNowDate: systemNowParts.date,
    systemNowTime: systemNowParts.time,
  });
});

/** GET /api/host/reservations – נוח לעובדים: ללא :rid (מסעדה ננעלת מה־StaffMember) */
hostRouter.get("/api/host/reservations", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = resolveRestaurantIdForRequest(ctx, "");
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const reservations = await loadHostReservations(rid);
  const systemNow = splitIsoParts(await getRestaurantSystemNow(rid));
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({
    rid,
    reservations,
    systemNow,
  });
});

/** GET /api/host/:rid/reservations – רשימת הזמנות להיום */
hostRouter.get("/api/host/:rid/reservations", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  hlog("GET /api/host/:rid/reservations", {
    rid: ctx.params.rid,
    userId: user?.id,
    role: user?.role,
  });

  const rid0 = ctx.params.rid!;
  const rid = resolveRestaurantIdForRequest(ctx, rid0);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  const reservations = await loadHostReservations(rid);
  const systemNow = splitIsoParts(await getRestaurantSystemNow(rid));

  hlog("reservations payload", {
    rid,
    reservationsCount: reservations.length,
  });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { reservations, systemNow };
});

/** עזר: קריאת נתונים גם מה-body וגם מה-query (seat יחיד) */
async function extractSeatPayload(ctx: any) {
  const rawBodyData = await readJsonLikeBody(ctx);
  const data = mergeSeatBarQueryFallback(rawBodyData, ctx);
  const url = ctx.request.url;
  const sp = url.searchParams;

  const qRid = sp.get("restaurantId") ?? sp.get("rid") ?? "";
  const qReservationId = sp.get("reservationId") ?? "";
  const qTable = sp.get("table") ?? sp.get("tableNumber") ?? "";

  const rid = (data.restaurantId ?? data.rid ?? qRid ?? "").toString();
  const reservationId = (data.reservationId ?? qReservationId ?? "").toString();
  const tableNumber = toIntLoose(
    data.table ?? data.tableNumber ?? qTable ?? 0,
  ) ?? 0;

  return {
    rid,
    reservationId,
    tableNumber,
    raw: data,
    query: Object.fromEntries(sp.entries()),
  };
}

/** עזר: קריאת נתונים ל-seat-multi (body + query) */
async function extractSeatMultiPayload(ctx: any) {
  const data = await readJsonLikeBody(ctx);
  const url = ctx.request.url;
  const sp = url.searchParams;

  const qRid = sp.get("restaurantId") ?? sp.get("rid") ?? "";
  const qReservationId = sp.get("reservationId") ?? "";
  const qTablesStr = sp.get("tables") ?? "";

  const rid = (data.restaurantId ?? data.rid ?? qRid ?? "").toString();
  const reservationId = (data.reservationId ?? qReservationId ?? "").toString();

  let qpTables: number[] = [];
  if (qTablesStr) {
    qpTables = qTablesStr
      .split(",")
      .map((s) => toIntLoose(s))
      .filter((n): n is number => Number.isFinite(n as number) && (n as number) > 0);
  }

  const tablesRaw = Array.isArray(data.tables) && data.tables.length
    ? data.tables
    : qpTables;

  const tables = tablesRaw
    .map((t: any) => toIntLoose(t))
    .filter((n): n is number => Number.isFinite(n as number) && (n as number) > 0);

  return {
    rid,
    reservationId,
    tables,
    raw: data,
    query: Object.fromEntries(sp.entries()),
  };
}

function seatNumberFromBarSeatId(seatId: string): number {
  const m = String(seatId || "").match(/:seat:(\d+)/);
  return m ? Math.max(1, Number(m[1]) || 1) : 0;
}

function barSeatAccountId(seatNumber: number): string {
  return `seat-${Math.max(1, Number(seatNumber) || 1)}`;
}

/** עזר: קריאת נתונים ל-unseat שולחן/ות */
async function extractUnseatPayload(ctx: any) {
  const data = await readJsonLikeBody(ctx);
  const url = ctx.request.url;
  const sp = url.searchParams;

  const qRid = sp.get("restaurantId") ?? sp.get("rid") ?? "";
  const qTablesStr = sp.get("tables") ?? sp.get("table") ?? "";

  const rid = (data.restaurantId ?? data.rid ?? qRid ?? "").toString();

  let qpTables: number[] = [];
  if (qTablesStr) {
    qpTables = qTablesStr
      .split(",")
      .map((s) => toIntLoose(s))
      .filter((n): n is number => Number.isFinite(n as number) && (n as number) > 0);
  }

  const tablesRaw = Array.isArray(data.tables) && data.tables.length
    ? data.tables
    : qpTables;

  const tables = tablesRaw
    .map((t: any) => toIntLoose(t))
    .filter((n): n is number => Number.isFinite(n as number) && (n as number) > 0);

  return {
    rid,
    tables,
    payload: data,
    query: Object.fromEntries(sp.entries()),
  };
}

/** POST /api/host/seat – הושבת הזמנה לשולחן יחיד */
hostRouter.post("/api/host/seat", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const ct = ctx.request.headers.get("content-type") || "";

  hlog("POST /api/host/seat – incoming", {
    contentType: ct,
    userId: user?.id,
    role: user?.role,
  });

  const { rid: ridRaw, reservationId, tableNumber, raw, query } =
    await extractSeatPayload(ctx);

  const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  hlog("seat extracted fields", {
    rid,
    reservationId,
    tableNumber,
    isTableNumberFinite: Number.isFinite(tableNumber),
    raw,
    query,
  });

  if (!reservationId || !tableNumber) {
    hlog("seat -> missing_fields", {
      ridOk: !!rid,
      reservationIdOk: !!reservationId,
      tableNumberOk: !!tableNumber,
      payload: raw,
      query,
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const tableId = await getTableIdByNumber(rid, tableNumber);
  hlog("seat table lookup", { rid, tableNumber, tableId });

  if (!tableId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "table_not_found" };
    return;
  }

  const guestName = (raw?.guestName ?? "").toString().trim() || undefined;

  try {
    await seatReservation({
      restaurantId: rid,
      reservationId,
      table: tableNumber,
      guestName,
    });
  } catch (err) {
    const msg = (err as Error).message || "";
    const errorCode = [
      "reservation_not_found",
      "reservation_cancelled",
    ].includes(msg)
      ? msg
      : "seat_failed";

    hlog("seatReservation ERROR", {
      rid,
      reservationId,
      tableNumber,
      message: msg,
      errorCode,
    });

    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: errorCode };
    return;
  }

  const order = await getOrCreateOpenOrder(rid, tableNumber);
  hlog("seat success", {
    rid,
    reservationId,
    tableNumber,
    orderId: order?.id ?? null,
  });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, orderId: order?.id || null, tableNumber };
});

/** POST /api/host/seat-multi – הושבת הזמנה למספר שולחנות (איחוד שולחנות) */
hostRouter.post("/api/host/seat-multi", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const ct = ctx.request.headers.get("content-type") || "";

  hlog("POST /api/host/seat-multi – incoming", {
    contentType: ct,
    userId: user?.id,
    role: user?.role,
  });

  const { rid: ridRaw, reservationId, tables, raw, query } =
    await extractSeatMultiPayload(ctx);

  const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  hlog("seat-multi extracted fields", {
    rid,
    reservationId,
    tables,
    raw,
    query,
  });

  if (!reservationId || !tables.length) {
    hlog("seat-multi -> missing_fields", {
      ridOk: !!rid,
      reservationIdOk: !!reservationId,
      tablesOk: !!tables.length,
      payload: raw,
      query,
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  for (const tn of tables) {
    const tableId = await getTableIdByNumber(rid, tn);
    hlog("seat-multi table lookup", { rid, tableNumber: tn, tableId });
    if (!tableId) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "table_not_found", table: tn };
      return;
    }
  }

  const results: Array<{ tableNumber: number; orderId: string | null }> = [];
  const guestName = (raw?.guestName ?? "").toString().trim() || undefined;

  try {
    const primary = tables[0];
    await seatReservation({
      restaurantId: rid,
      reservationId,
      table: primary,
      guestName,
    });
    const primaryOrder = await getOrCreateOpenOrder(rid, primary);
    results.push({ tableNumber: primary, orderId: primaryOrder?.id ?? null });

    for (let i = 1; i < tables.length; i++) {
      const tn = tables[i];
      const ord = await getOrCreateOpenOrder(rid, tn);
      results.push({ tableNumber: tn, orderId: ord?.id ?? null });
    }
  } catch (err) {
    const msg = (err as Error).message || "";
    const errorCode = [
      "reservation_not_found",
      "reservation_cancelled",
    ].includes(msg)
      ? msg
      : "seat_failed";

    hlog("seat-multi ERROR", {
      rid,
      reservationId,
      tables,
      message: msg,
      errorCode,
    });

    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: errorCode };
    return;
  }

  hlog("seat-multi success", {
    rid,
    reservationId,
    seated: results,
  });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, seated: results };
});

/** POST /api/host/seat-bar – הושבת הזמנה למושבים סמוכים בבר */
async function handleSeatBar(ctx: any) {
  if (!requireStaff(ctx)) return;

  try {
    const rawBodyData = await readJsonLikeBody(ctx);
    const data = mergeSeatBarQueryFallback(rawBodyData, ctx);
    const ridParam = String(ctx.params?.rid ?? "").trim();
    const ridRaw = ridParam || String(data.restaurantId ?? data.rid ?? "");
    const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
    if (!rid) return;
    if (!(await requireRestaurantAccess(ctx, rid))) return;

    const reservationId = String(data.reservationId ?? "").trim();
    const requestedSeatIds = Array.from(new Set((Array.isArray(data.seatIds) ? data.seatIds : [])
      .map((v: any) => String(v ?? "").trim())
      .filter(Boolean)));
    let tableId = String(data.tableId ?? "").trim() || undefined;
    if (!tableId && requestedSeatIds.length) {
      tableId = String(requestedSeatIds[0].split(":seat:")[0] || "").trim() || undefined;
    }
    let tableNumber = toIntLoose(data.table ?? data.tableNumber ?? 0) ?? 0;
    barDebug("seat-bar incoming.raw", {
      rid,
      ridParam,
      bodyKeys: Object.keys(rawBodyData || {}),
      mergedKeys: Object.keys(data || {}),
      query: Object.fromEntries((ctx.request?.url?.searchParams || new URLSearchParams()).entries()),
      reservationId,
      tableId,
      rawTable: data.table ?? null,
      rawTableNumber: data.tableNumber ?? null,
      rawSeatIds: Array.isArray(data.seatIds) ? data.seatIds : data.seatIds ?? null,
      guestName: String(data.guestName ?? "").trim() || null,
    });

    if ((!tableNumber || tableNumber <= 0) && tableId) {
      const lookedUp = (await getTableNumberById(rid, tableId)) ?? 0;
      barDebug("seat-bar tableNumber.lookup", { rid, tableId, lookedUp });
      tableNumber = lookedUp;
    }
    if ((!tableNumber || tableNumber <= 0) && tableId) {
      const ensured = (await ensureTableNumberById(rid, tableId)) ?? 0;
      barDebug("seat-bar tableNumber.ensure", { rid, tableId, ensured });
      tableNumber = ensured;
    }

    const seatIds = requestedSeatIds;
    hlog("seat-bar incoming", { rid, reservationId, tableNumber, tableId, seatIds, ridParam });
    barDebug("seat-bar incoming.normalized", { rid, reservationId, tableNumber, tableId, seatIds, ridParam });

    if (!reservationId || (!tableNumber && !tableId) || !seatIds.length) {
      hlog("seat-bar -> missing_fields", { rid, reservationId, tableNumber, tableId, seatIds });
      barDebug("seat-bar -> missing_fields", {
        rid,
        reservationId,
        tableNumber,
        tableId,
        seatIds,
        selectedTableLookupAttempted: Boolean(tableId),
      });
      ctx.response.status = Status.BadRequest;
      ctx.response.body = {
        ok: false,
        error: "missing_fields",
        details: {
          reservationId: Boolean(reservationId),
          tableNumber: Boolean(tableNumber),
          tableId: Boolean(tableId),
          seatIds: seatIds.length,
        },
      };
      return;
    }

    const mappedTableId = tableId || await getTableIdByNumber(rid, tableNumber);
    barDebug("seat-bar table.mapping", { rid, tableNumber, tableId, mappedTableId });
    if (!mappedTableId) {
      barDebug("seat-bar -> table_not_found", { rid, tableNumber, tableId });
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "table_not_found" };
      return;
    }

    if (!tableNumber || tableNumber <= 0) {
      const ensured = (await ensureTableNumberById(rid, mappedTableId)) ?? 0;
      barDebug("seat-bar tableNumber.recovered", { rid, mappedTableId, ensured });
      tableNumber = ensured;
    }
    if (!tableNumber || tableNumber <= 0) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "table_number_missing" };
      return;
    }

    const reservation = await getReservationById(reservationId);
    if (!reservation) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "reservation_not_found" };
      return;
    }

    barDebug("seat-bar reservation.snapshot", {
      reservationId,
      status: String((reservation as any)?.status ?? ""),
      people: (reservation as any)?.people ?? null,
      time: (reservation as any)?.time ?? null,
      name: extractNameFromReservationLike(reservation) || null,
    });
    const reservationStatus = String((reservation as any).status ?? "new").toLowerCase();
    if (["cancelled", "canceled", "no_show", "noshow"].includes(reservationStatus)) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "reservation_cancelled" };
      return;
    }

    const existingAccounts = await listTableAccounts(rid, tableNumber);
    barDebug("seat-bar existingAccounts", {
      rid,
      tableNumber,
      count: existingAccounts.length,
      accounts: existingAccounts.map((acc: any) => ({
        accountId: acc.accountId ?? null,
        reservationId: acc.reservationId ?? null,
        seatId: acc.seatId ?? null,
        seatIds: Array.isArray(acc.seatIds) ? acc.seatIds : [],
      })),
    });
    const occupiedSeatIds = new Set(
      existingAccounts
        .filter((acc: any) => String((acc as any).reservationId ?? "").trim() !== reservationId)
        .flatMap((acc: any) => Array.isArray(acc.seatIds) && acc.seatIds.length ? acc.seatIds : [acc.seatId])
        .map((seatId: any) => String(seatId || "").trim())
        .filter(Boolean),
    );
    const conflict = seatIds.find((seatId) => occupiedSeatIds.has(String(seatId)));
    if (conflict) {
      barDebug("seat-bar -> seat_already_occupied", {
        rid,
        tableNumber,
        requestedSeatIds: seatIds,
        occupiedSeatIds: Array.from(occupiedSeatIds.values()),
        conflict,
      });
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "seat_already_occupied", seatId: conflict };
      return;
    }

    const guestName = extractNameFromReservationLike(reservation) || String(data.guestName ?? "").trim() || undefined;
    const seated: Array<{ seatId: string; seatNumber: number; accountId: string; orderId: string | null }> = [];

    try {
      const accountId = reservationId;
      const accountLabel = guestName ? `Bar · ${guestName}` : "Bar Reservation";
      barDebug("seat-bar createOrder.request", {
        rid,
        tableNumber,
        accountId,
        accountLabel,
        locationType: "bar",
        locationId: mappedTableId,
        seatId: seatIds[0],
        seatIds,
        reservationId,
        guestName,
      });
      const order = await getOrCreateOpenOrder(rid, tableNumber, {
        accountId,
        accountLabel,
        locationType: "bar",
        locationId: mappedTableId,
        seatId: seatIds[0],
        seatIds,
        reservationId,
        guestName,
      });
      barDebug("seat-bar createOrder.success", {
        rid,
        tableNumber,
        orderId: (order as any)?.id ?? null,
        accountId,
        reservationId,
        seatIds,
      });

      for (const seatId of seatIds) {
        const seatNumber = seatNumberFromBarSeatId(seatId);
        seated.push({ seatId, seatNumber: seatNumber || seated.length + 1, accountId, orderId: order?.id ?? null });
      }

      try {
        await setReservationStatus(reservationId, "arrived");
      } catch (_e) {
        // ignore reservation status update failure here
      }
    } catch (err) {
      const message = (err as Error).message || "seat_failed";
      hlog("seat-bar ERROR", { rid, reservationId, tableNumber, message });
      barDebug("seat-bar ERROR", { rid, reservationId, tableNumber, message });
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "seat_failed", message };
      return;
    }

    barDebug("seat-bar success", {
      rid,
      reservationId,
      tableNumber,
      tableId: mappedTableId,
      seated,
    });
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = { ok: true, seated };
  } catch (err) {
    const message = (err as Error).message || String(err);
    hlog("seat-bar FATAL", { message, stack: (err as Error).stack || null });
    barDebug("seat-bar FATAL", { message, stack: (err as Error).stack || null });
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = { ok: false, error: "seat_bar_internal_error", message };
  }
}

hostRouter.post("/api/host/seat-bar", handleSeatBar);
hostRouter.post("/api/host/seat-bar/", handleSeatBar);
hostRouter.post("/api/host/:rid/seat-bar", handleSeatBar);
hostRouter.post("/api/host/:rid/seat-bar/", handleSeatBar);


/** POST /api/host/table/unseat – שחרור שולחן/ות מהמארחת (סגירת צ'ק + שחרור seat) */
hostRouter.post("/api/host/table/unseat", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const ct = ctx.request.headers.get("content-type") || "";

  hlog("POST /api/host/table/unseat – incoming", {
    contentType: ct,
    userId: user?.id,
    role: user?.role,
  });

  const { rid: ridRaw, tables, payload, query } = await extractUnseatPayload(ctx);
  const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  hlog("table/unseat extracted fields", {
    rid,
    tables,
    payload,
    query,
  });

  if (!rid || !tables.length) {
    hlog("table/unseat -> missing_fields", {
      ridOk: !!rid,
      tablesOk: !!tables.length,
      payload,
      query,
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const freed: number[] = [];
  const errors: Array<{ table: number; message: string }> = [];

  for (const tn of tables) {
    try {
      // 1) Release seating (KV)
      await unseatTable({ restaurantId: rid, table: tn });

      // 2) Close open order (if any)
      await closeOrderForTable(rid, tn);

      // 3) Auto-mark table as "dirty" for cleanup
      const floorTableId = await getTableIdByNumber(rid, tn);
      if (floorTableId) {
        await markTableDirty(rid, floorTableId, user?.id ?? "system");
      }

      freed.push(tn);
    } catch (err) {
      errors.push({
        table: tn,
        message: (err as Error).message || "unknown_error",
      });
    }
  }

  hlog("table/unseat result", { rid, freed, errors });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, freed, errors };
});

/** POST /api/host/table/clean - Mark a dirty table as clean (ready for new guests) */
hostRouter.post("/api/host/table/clean", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const body = await ctx.request.body.json().catch(() => ({}));
  const ridRaw = String(body.restaurantId ?? body.rid ?? "");
  const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;

  const tableNumbers: number[] = Array.isArray(body.tables)
    ? body.tables.map(Number).filter((n: number) => n > 0)
    : body.table ? [Number(body.table)] : [];

  if (!tableNumbers.length) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_tables" };
    return;
  }

  const cleaned: number[] = [];
  const errors: Array<{ table: number; message: string }> = [];

  const { markTableClean: doClean } = await import("../services/floor_service.ts");

  for (const tn of tableNumbers) {
    try {
      const floorTableId = await getTableIdByNumber(rid, tn);
      if (floorTableId) {
        await doClean(rid, floorTableId, user?.id ?? "system");
        cleaned.push(tn);
      } else {
        errors.push({ table: tn, message: "table_not_found_in_floor_plan" });
      }
    } catch (err) {
      errors.push({ table: tn, message: (err as Error).message || "unknown_error" });
    }
  }

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, cleaned, errors };
});

/** GET /api/host/table/info - Table occupant details for host */
hostRouter.get("/api/host/table/info", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const ct = ctx.request.headers.get("content-type") || "";

  hlog("GET /api/host/table/info – incoming", {
    contentType: ct,
    userId: user?.id,
    role: user?.role,
  });

  const url = ctx.request.url;
  const sp = url.searchParams;

  const ridRaw = (sp.get("restaurantId") ?? sp.get("rid") ?? "").toString();
  const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const tStr = (sp.get("table") ?? sp.get("tableNumber") ?? "").toString();
  const tableNumber = toIntLoose(tStr) ?? 0;

  if (!rid || !tableNumber) {
    hlog("table/info -> missing_fields", {
      ridOk: !!rid,
      tableOk: !!tableNumber,
      query: Object.fromEntries(sp.entries()),
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const seat = await getSeatingByTable(rid, tableNumber);
  if (!seat) {
    hlog("table/info -> not_seated", { rid, tableNumber });
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "not_seated" };
    return;
  }

  let name = seat.guestName ?? "";
  let people = seat.people;
  let time = seat.time;

  // אם חסר משהו – ננסה להשלים מה-reservation
  const res = await getReservationById(seat.reservationId);
  if (res) {
    if (!name) {
      name = (res.firstName && res.lastName)
        ? `${res.firstName} ${res.lastName}`
        : (res.name ?? "");
    }
    if (people == null && res.people != null) {
      people = Number(res.people);
    }
    if (!time && res.time) {
      time = String(res.time);
    }
  }

  hlog("table/info success", {
    rid,
    tableNumber,
    reservationId: seat.reservationId,
    name,
    people,
    time,
  });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = {
    ok: true,
    table: tableNumber,
    reservationId: seat.reservationId,
    name: name || null,
    people: people ?? null,
    time: time ?? null,
  };
});

/** POST /api/host/reservation/status – עדכון סטטוס הזמנה (ביטול / לא הגיע) */
hostRouter.post("/api/host/reservation/status", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  const ct = ctx.request.headers.get("content-type") || "";

  hlog("POST /api/host/reservation/status – incoming", {
    contentType: ct,
    userId: user?.id,
    role: user?.role,
  });

  const data = await readJsonLikeBody(ctx);
  hlog("reservation/status payload (after readJsonLikeBody)", data);

  const url = ctx.request.url;
  const sp = url.searchParams;

  const qRid = sp.get("restaurantId") ?? sp.get("rid") ?? "";
  const qReservationId = sp.get("reservationId") ?? "";
  const qStatus = sp.get("status") ?? "";

  const ridRaw = (data.restaurantId ?? data.rid ?? qRid ?? "").toString();
  const rid = resolveRestaurantIdForRequest(ctx, ridRaw);
  if (!rid) return;
  if (!(await requireRestaurantAccess(ctx, rid))) return;
  const reservationId = (data.reservationId ?? qReservationId ?? "").toString();
  const status = (data.status ?? qStatus ?? "").toString().toLowerCase();

  hlog("reservation/status extracted fields", {
    rid,
    reservationId,
    status,
    payload: data,
    query: Object.fromEntries(sp.entries()),
  });

  if (!rid || !reservationId || !status) {
    hlog("reservation/status -> missing_fields", {
      ridOk: !!rid,
      reservationIdOk: !!reservationId,
      statusOk: !!status,
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const allowed = ["cancelled", "canceled", "no_show"];
  if (!allowed.includes(status)) {
    hlog("reservation/status -> invalid_status", { status, allowed });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "invalid_status" };
    return;
  }

  await setReservationStatus(reservationId, status);

  hlog("reservation/status success", { rid, reservationId, status });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true };
});

export default hostRouter;
