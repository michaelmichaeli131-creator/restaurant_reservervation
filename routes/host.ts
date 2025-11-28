// src/routes/host.ts
// מסך מארחת: מפת מסעדה + הושבת הזמנה לשולחן

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant, listReservationsFor, setReservationStatus } from "../database.ts";
import { listOpenOrdersByRestaurant, getOrCreateOpenOrder } from "../pos/pos_db.ts";

// שתי עזרות פשוטות לקריאת מבנה הרצפה מתוך ה-DB שבו משתמש owner_floor
// מצופה שמבנה כזה כבר נשמר ע"י מסכי הבעלים (sections -> tables -> tableNumber/id)
import { listFloorSections, getTableIdByNumber } from "../services/floor_service.ts";

export const hostRouter = new Router();

/** חישוב סטטוס לכל שולחן על בסיס הזמנות פתוחות */
async function computeAllTableStatuses(
  rid: string,
  tablesFlat: Array<{ id: string; tableNumber: number }>,
) {
  const openOrders = await listOpenOrdersByRestaurant(rid);
  const occupiedByTable = new Set<number>(openOrders.map((o: any) => Number(o.tableNumber)));

  return tablesFlat.map((t) => {
    const occupied = occupiedByTable.has(Number(t.tableNumber));
    return {
      tableId: t.id,
      tableNumber: t.tableNumber,
      status: occupied ? "occupied" : "empty",
    };
  });
}

/** GET /host/:rid – UI של המארחת */
hostRouter.get("/host/:rid", async (ctx) => {
  if (!requireOwner(ctx)) return; // כרגע: רק בעלים/מנהל יכולים. אם יש "host" ברולים – אפשר להרחיב כאן.
  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound, "restaurant not found");

  // הזמנות להיום במצבים שניתנים להושבה
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const all = await listReservationsFor(rid, date);
  const reservations = (all ?? []).filter((x: any) =>
    ["new", "approved", "confirmed"].includes(String(x.status ?? "new")),
  );

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

/** POST /api/host/seat – הושבה: מקבלת reservationId + tableNumber ומייצרת הזמנה פתוחה לשולחן */
hostRouter.post("/api/host/seat", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const body = ctx.request.body();
  const form = body.type === "form" ? await body.value : null;

  const rid = form?.get("rid")?.toString() || "";
  const reservationId = form?.get("reservationId")?.toString() || "";
  const tableNumber = Number(form?.get("tableNumber")?.toString() || "0");

  if (!rid || !reservationId || !tableNumber) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  // ולידציה שהשולחן קיים במפה
  const tableId = await getTableIdByNumber(rid, tableNumber);
  if (!tableId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "table_not_found" };
    return;
  }

  // יצירת הזמנה פתוחה + סימון ההזמנה "arrived"
  const order = await getOrCreateOpenOrder(rid, tableNumber);
  await setReservationStatus(reservationId, "arrived");

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, orderId: order?.id, tableNumber };
});
