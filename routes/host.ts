// src/routes/host.ts
// מסך מארחת: מפת מסעדה + הושבת הזמנה לשולחן

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireStaff } from "../lib/auth.ts";
import { getRestaurant, listReservationsFor } from "../database.ts";
import {
  listOpenOrdersByRestaurant,
  getOrCreateOpenOrder,
} from "../pos/pos_db.ts";
import {
  listFloorSections,
  getTableIdByNumber,
} from "../services/floor_service.ts";
import { seatReservation } from "../services/seating_service.ts";

export const hostRouter = new Router();

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

  // נשאיר רק הזמנות שעדיין רלוונטיות להושבה
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
  if (!requireStaff(ctx)) return; // רק משתמש מחובר

  const user = ctx.state.user;
  // רק owner/manager – מלצר לא נכנס למסך מארחת
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  // הזמנות להיום (רק פעילות)
  const reservations = await loadHostReservations(rid);

  // מפת רצפה
  const sections = await listFloorSections(rid);
  const tablesFlat: Array<{ id: string; tableNumber: number }> = [];
  for (const s of sections ?? []) {
    for (const t of (s.tables ?? [])) {
      tablesFlat.push({ id: t.id, tableNumber: Number(t.tableNumber) });
    }
  }
  const statuses = await computeAllTableStatuses(rid, tablesFlat);

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
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  const reservations = await loadHostReservations(rid);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { reservations };
});

/** POST /api/host/seat – הושבת הזמנה: reservationId + table → הזמנה פתוחה לשולחן */
hostRouter.post("/api/host/seat", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  // רק owner/manager, כדי שמלצר לא יוכל להושיב
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  // קריאת JSON (כמו בשאר הפרויקט)
  let data: any = {};
  try {
    data = await ctx.request.body.json();
  } catch {
    data = {};
  }

  const rid = (data.restaurantId ?? data.rid ?? "").toString();
  const reservationId = (data.reservationId ?? "").toString();
  const tableNumber = Number(data.table ?? data.tableNumber ?? 0);

  // בדיקת שדות חובה
  if (!rid || !reservationId || !tableNumber) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  // ולידציה: שהשולחן מוגדר במפת המסעדה
  const tableId = await getTableIdByNumber(rid, tableNumber);
  if (!tableId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "table_not_found" };
    return;
  }

  try {
    // הושבת ההזמנה בפועל (יוצר הזמנה פתוחה ומסמן את ההזמנה כ"arrived")
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

    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: errorCode };
    return;
  }

  // שליפה של ההזמנה הפתוחה שזה עתה נוצרה (כדי להחזיר מזהה להזמנה ולוודא הצלחה)
  const order = await getOrCreateOpenOrder(rid, tableNumber);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, orderId: order?.id || null, tableNumber };
});
