// src/routes/host.ts
// מסך מארחת: מפת מסעדה + הושבת הזמנה לשולחן/ות + עדכון סטטוס הזמנה

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireStaff } from "../lib/auth.ts";

import {
  getRestaurant,
  listReservationsFor,
  setReservationStatus,
} from "../database.ts";

import {
  listOpenOrdersByRestaurant,
  getOrCreateOpenOrder,
} from "../pos/pos_db.ts";

import {
  listFloorSections,
  getTableIdByNumber,
} from "../services/floor_service.ts";

import { seatReservation } from "../services/seating_service.ts";

// אותו helper שאתה כבר משתמש בו ברואטרים אחרים
import { readBody } from "./restaurants/_utils/body.ts";

export const hostRouter = new Router();

/** לוג עזר למסך המארחת */
function hlog(...args: unknown[]) {
  try {
    console.log("[HOST]", ...args);
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

/** חישוב סטטוס לכל שולחן (תפוס/פנוי) על סמך הזמנות פתוחות */
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
  const d = new Date();
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

  return active.map((res: any) => {
    const name = (res.firstName && res.lastName)
      ? `${res.firstName} ${res.lastName}`
      : (res.name ?? "");
    return {
      id: res.id,
      time: res.time,
      people: res.people,
      name: name || "—",
    };
  });
}

/** GET /host/:rid – עמוד המארחת עם מפת המסעדה והזמנות להיום */
hostRouter.get("/host/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return; // דורש לוגין

  const user = ctx.state.user;
  hlog("GET /host/:rid", {
    rid: ctx.params.rid,
    userId: user?.id,
    role: user?.role,
  });

  // רק owner/manager למסך המארחת
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) {
    hlog("restaurant not found", { rid });
    ctx.throw(Status.NotFound, "restaurant not found");
  }

  const reservations = await loadHostReservations(rid);
  const sections = await listFloorSections(rid);

  const tablesFlat: Array<{ id: string; tableNumber: number }> = [];
  for (const s of sections ?? []) {
    for (const t of (s.tables ?? [])) {
      tablesFlat.push({ id: t.id, tableNumber: Number(t.tableNumber) });
    }
  }

  const statuses = await computeAllTableStatuses(rid, tablesFlat);

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

  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  const reservations = await loadHostReservations(rid);

  hlog("reservations payload", {
    rid,
    reservationsCount: reservations.length,
  });

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { reservations };
});

/** עזר: קריאת נתונים גם מה-body וגם מה-query */
async function extractSeatPayload(ctx: any) {
  let data: any = {};
  try {
    const { payload } = await readBody(ctx);
    data = payload || {};
  } catch (err) {
    hlog("readBody ERROR", String(err));
    data = {};
  }

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

  return { rid, reservationId, tableNumber, raw: data, query: Object.fromEntries(sp.entries()) };
}

/** עזר: קריאת נתונים ל-seat-multi */
async function extractSeatMultiPayload(ctx: any) {
  let data: any = {};
  try {
    const { payload } = await readBody(ctx);
    data = payload || {};
  } catch (err) {
    hlog("seat-multi readBody ERROR", String(err));
    data = {};
  }

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

  if (user.role !== "owner" && user.role !== "manager") {
    hlog("seat forbidden: role not allowed", { role: user?.role });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const { rid, reservationId, tableNumber, raw, query } = await extractSeatPayload(ctx);

  hlog("seat extracted fields", {
    rid,
    reservationId,
    tableNumber,
    isTableNumberFinite: Number.isFinite(tableNumber),
    raw,
    query,
  });

  if (!rid || !reservationId || !tableNumber) {
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

  // ולידציה שהשולחן קיים
  const tableId = await getTableIdByNumber(rid, tableNumber);
  hlog("seat table lookup", { rid, tableNumber, tableId });

  if (!tableId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "table_not_found" };
    return;
  }

  try {
    await seatReservation({ restaurantId: rid, reservationId, table: tableNumber });
  } catch (err) {
    const msg = (err as Error).message || "";
    const errorCode = [
      "reservation_not_found",
      "reservation_cancelled",
      "table_already_seated",
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

  if (user.role !== "owner" && user.role !== "manager") {
    hlog("seat-multi forbidden: role not allowed", { role: user?.role });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const { rid, reservationId, tables, raw, query } = await extractSeatMultiPayload(ctx);

  hlog("seat-multi extracted fields", {
    rid,
    reservationId,
    tables,
    raw,
    query,
  });

  if (!rid || !reservationId || !tables.length) {
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

  // ולידציה שכל השולחנות קיימים
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

  try {
    const primary = tables[0];
    await seatReservation({ restaurantId: rid, reservationId, table: primary });
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
      "table_already_seated",
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

  if (user.role !== "owner" && user.role !== "manager") {
    hlog("reservation/status forbidden: role not allowed", { role: user?.role });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  let data: any = {};
  try {
    const { payload } = await readBody(ctx);
    data = payload || {};
    hlog("reservation/status payload (after readBody)", data);
  } catch (err) {
    hlog("reservation/status readBody ERROR", String(err));
    data = {};
  }

  const url = ctx.request.url;
  const sp = url.searchParams;

  const qRid = sp.get("restaurantId") ?? sp.get("rid") ?? "";
  const qReservationId = sp.get("reservationId") ?? "";
  const qStatus = sp.get("status") ?? "";

  const rid = (data.restaurantId ?? data.rid ?? qRid ?? "").toString();
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
