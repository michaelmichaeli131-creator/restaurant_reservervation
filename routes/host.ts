// routes/host.ts
// מסך מארחת: מפת מסעדה + הושבת הזמנה לשולחן/ות + עדכון סטטוס הזמנה

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import {
  kv,
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

export const hostRouter = new Router();

// מפתח ב-KV לשמירת שם המזמין לכל שולחן
function guestKey(
  restaurantId: string,
  tableNumber: number | string,
): Deno.KvKey {
  return ["table_guest_name", restaurantId, String(tableNumber)] as Deno.KvKey;
}

interface SimpleTableRef {
  id: string;
  tableNumber: number;
}

/** חישוב סטטוס תפוס/פנוי לכל שולחן על בסיס הזמנות פתוחות + שם מזמין (אם קיים ב-KV) */
async function computeAllTableStatuses(
  rid: string,
  tablesFlat: SimpleTableRef[],
) {
  const openOrders = await listOpenOrdersByRestaurant(rid);
  const occupiedByTable = new Set<number>(
    (openOrders ?? []).map((o: any) => Number(o.table)),
  );

  // בסיס – empty / occupied
  const base = tablesFlat.map((t) => ({
    tableId: t.id,
    tableNumber: t.tableNumber,
    status: occupiedByTable.has(Number(t.tableNumber)) ? "occupied" : "empty",
  }));

  // הזרקת guestName מתוך ה-KV (אם יש)
  const withNames: Array<
    { tableId: string; tableNumber: number; status: string; guestName: string | null }
  > = [];

  for (const ts of base) {
    const entry = await kv.get(guestKey(rid, ts.tableNumber));
    const guestName =
      entry.value && (entry.value as any).guestName
        ? String((entry.value as any).guestName)
        : null;

    withNames.push({ ...ts, guestName });
  }

  return withNames;
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
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.throw(Status.NotFound, "Restaurant not found");
  }

  const sections = await listFloorSections(rid);
  const tablesFlat: SimpleTableRef[] = [];
  for (const s of sections ?? []) {
    for (const t of (s.tables ?? [])) {
      tablesFlat.push({ id: t.id, tableNumber: Number(t.tableNumber) });
    }
  }
  const statuses = await computeAllTableStatuses(rid, tablesFlat);
  const reservations = await loadHostReservations(rid);

  await render(ctx, "host_seating", {
    page: "host",
    title: `מארחת · ${restaurant.name}`,
    restaurant,
    rid,
    sections,
    statuses,
    reservations,
  });
});

/** GET /api/host/:rid/reservations – רשימת הזמנות להיום */
hostRouter.get("/api/host/:rid/reservations", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.throw(Status.NotFound, "Restaurant not found");
  }

  const reservations = await loadHostReservations(rid);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { reservations };
});

/** עזר: קריאת JSON מה-body בצורה בטוחה */
async function readJsonBody(ctx: any): Promise<any> {
  try {
    const body = ctx.request.body({ type: "json" });
    const data = await body.value;
    return data ?? {};
  } catch {
    return {};
  }
}

/** POST /api/host/seat – הושבת הזמנה לשולחן יחיד */
hostRouter.post("/api/host/seat", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const data = await readJsonBody(ctx);

  const rid = String(data.restaurantId ?? data.rid ?? "");
  const reservationId = String(data.reservationId ?? "");
  const tableNumber = Number(data.table ?? data.tableNumber ?? 0);
  const guestName: string = data.guestName ? String(data.guestName) : "";

  if (!rid || !reservationId || !tableNumber) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.throw(Status.NotFound, "Restaurant not found");
  }

  // ולידציה: שהשולחן מוגדר במפת המסעדה
  const tableId = await getTableIdByNumber(rid, tableNumber);
  if (!tableId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "table_not_found" };
    return;
  }

  // בדיקה שההזמנה קיימת ופעילה
  const d = new Date();
  const date = `${d.getFullYear()}-${
    String(d.getMonth() + 1).padStart(2, "0")
  }-${String(d.getDate()).padStart(2, "0")}`;
  const todays = await listReservationsFor(rid, date);
  const res = (todays ?? []).find((r: any) => r.id === reservationId);
  if (!res) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "reservation_not_found" };
    return;
  }

  const st = String(res.status ?? "new").toLowerCase();
  if (["cancelled", "canceled", "no_show", "arrived", "seated"].includes(st)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "reservation_not_active" };
    return;
  }

  // יצירת/מציאת צ'ק פתוח לשולחן
  const order = await getOrCreateOpenOrder(rid, tableNumber);

  // סימון ההזמנה כ-seated
  await setReservationStatus(reservationId, "seated");

  // שמירת שם האורח לשולחן ב-KV כדי שיופיע גם אחרי רענון
  if (guestName) {
    await kv.set(guestKey(rid, tableNumber), {
      restaurantId: rid,
      tableNumber,
      guestName,
      setAt: Date.now(),
    });
  }

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = {
    ok: true,
    orderId: order?.id ?? null,
    tableNumber,
  };
});

/** POST /api/host/seat-multi – הושבת הזמנה למספר שולחנות (איחוד שולחנות) */
hostRouter.post("/api/host/seat-multi", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const data = await readJsonBody(ctx);

  const rid = String(data.restaurantId ?? data.rid ?? "");
  const reservationId = String(data.reservationId ?? "");
  const tablesRaw = Array.isArray(data.tables) ? data.tables : [];
  const guestName: string = data.guestName ? String(data.guestName) : "";

  const tables = tablesRaw
    .map((t: any) => Number(t))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!rid || !reservationId || !tables.length) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.throw(Status.NotFound, "Restaurant not found");
  }

  // ולידציה שהשולחנות קיימים
  for (const tn of tables) {
    const tableId = await getTableIdByNumber(rid, tn);
    if (!tableId) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = { ok: false, error: "table_not_found", table: tn };
      return;
    }
  }

  // בדיקת סטטוס ההזמנה
  const d = new Date();
  const date = `${d.getFullYear()}-${
    String(d.getMonth() + 1).padStart(2, "0")
  }-${String(d.getDate()).padStart(2, "0")}`;
  const todays = await listReservationsFor(rid, date);
  const res = (todays ?? []).find((r: any) => r.id === reservationId);
  if (!res) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "reservation_not_found" };
    return;
  }

  const st = String(res.status ?? "new").toLowerCase();
  if (["cancelled", "canceled", "no_show", "arrived", "seated"].includes(st)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "reservation_not_active" };
    return;
  }

  const seated: Array<{ tableNumber: number; orderId: string | null }> = [];

  // שולחן ראשון – "ראשי"
  const primary = tables[0];
  const primaryOrder = await getOrCreateOpenOrder(rid, primary);
  await setReservationStatus(reservationId, "seated");

  if (guestName) {
    await kv.set(guestKey(rid, primary), {
      restaurantId: rid,
      tableNumber: primary,
      guestName,
      setAt: Date.now(),
    });
  }

  seated.push({ tableNumber: primary, orderId: primaryOrder?.id ?? null });

  // שאר השולחנות – צ'קים נפרדים + שם אורח לכל שולחן
  for (let i = 1; i < tables.length; i++) {
    const tn = tables[i];
    const order = await getOrCreateOpenOrder(rid, tn);
    if (guestName) {
      await kv.set(guestKey(rid, tn), {
        restaurantId: rid,
        tableNumber: tn,
        guestName,
        setAt: Date.now(),
      });
    }
    seated.push({ tableNumber: tn, orderId: order?.id ?? null });
  }

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, seated };
});

/** POST /api/host/reservation/status – עדכון סטטוס הזמנה (ביטול / לא הגיע) */
hostRouter.post("/api/host/reservation/status", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const data = await readJsonBody(ctx);
  const rid = String(data.restaurantId ?? data.rid ?? "");
  const reservationId = String(data.reservationId ?? "");
  const status = String(data.status ?? "").toLowerCase();

  if (!rid || !reservationId || !status) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  // נאפשר "cancelled" ו-"no_show"
  const allowed = ["cancelled", "canceled", "no_show"];
  if (!allowed.includes(status)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "invalid_status" };
    return;
  }

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.throw(Status.NotFound, "Restaurant not found");
  }

  await setReservationStatus(reservationId, status);

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true };
});

export default hostRouter;
