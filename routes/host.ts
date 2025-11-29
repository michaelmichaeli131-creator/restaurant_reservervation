// routes/host.ts
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

export const hostRouter = new Router();

/** עוזר: קריאת JSON בצורה שתעבוד גם ב-Deno Deploy וגם מקומית */
async function readJsonBody(ctx: any): Promise<any> {
  const reqAny: any = ctx?.request ?? ctx;

  const candidates = [
    reqAny?.originalRequest,
    reqAny?.request,
    reqAny?.raw,
    reqAny,
  ];

  for (const c of candidates) {
    if (!c) continue;

    // קודם כל – API של Web Request (Deno Deploy)
    if (typeof c.json === "function") {
      try {
        const val = await c.json();
        if (val && typeof val === "object") {
          return val;
        }
      } catch {
        // נמשיך לקנדידט הבא
      }
    }

    // fallback: Oak style body()
    if (typeof c.body === "function") {
      try {
        const body = c.body({ type: "json" });
        const val = await body.value;
        if (val && typeof val === "object") {
          return val;
        }
      } catch {
        // נתעלם
      }
    }
  }

  return {};
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
  // חשוב: ב-orders השדה נקרא table (לא tableNumber)
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

/** POST /api/host/seat – הושבת הזמנה לשולחן יחיד */
hostRouter.post("/api/host/seat", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  // רק owner/manager, כדי שמלצר לא יוכל להושיב
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  // קריאת JSON – עם helper מותאם ל-Deno Deploy
  const payload = await readJsonBody(ctx) ?? {};

  const rid = String(payload.restaurantId ?? payload.rid ?? "").trim();
  const reservationId = String(payload.reservationId ?? "").trim();
  const tableNumber = toIntLoose(payload.table ?? payload.tableNumber) ?? 0;
  const guestName = (payload.guestName ?? "").toString().trim() || null;

  const ridOk = !!rid;
  const reservationIdOk = !!reservationId;
  const tableNumberOk = Number.isFinite(tableNumber) && tableNumber > 0;

  if (!ridOk || !reservationIdOk || !tableNumberOk) {
    console.warn("[HOST] seat -> missing_fields", {
      ridOk,
      reservationIdOk,
      tableNumberOk,
      payload,
    });
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

  const order = await getOrCreateOpenOrder(rid, tableNumber);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = {
    ok: true,
    orderId: order?.id || null,
    tableNumber,
    guestName, // נחזיר גם ל־UI למקרה שתרצה
  };
});

/** POST /api/host/seat-multi – הושבת הזמנה למספר שולחנות (איחוד שולחנות) */
hostRouter.post("/api/host/seat-multi", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const payload = await readJsonBody(ctx) ?? {};

  const rid = String(payload.restaurantId ?? payload.rid ?? "").trim();
  const reservationId = String(payload.reservationId ?? "").trim();
  const guestName = (payload.guestName ?? "").toString().trim() || null;

  const tablesRaw = Array.isArray(payload.tables) ? payload.tables : [];
  const tables = tablesRaw
    .map((t: any) => toIntLoose(t))
    .filter((n: number | null): n is number => Number.isFinite(n as number) && (n as number) > 0);

  if (!rid || !reservationId || !tables.length) {
    console.warn("[HOST] seat-multi -> missing_fields", {
      rid,
      reservationId,
      tablesRaw,
      tables,
      payload,
    });
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
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

  const results: Array<{ tableNumber: number; orderId: string | null }> = [];

  try {
    // שולחן ראשון – הושבה "רגילה" שמשנה סטטוס הזמנה ל-arrived
    const primary = tables[0];
    await seatReservation({ restaurantId: rid, reservationId, table: primary });
    const primaryOrder = await getOrCreateOpenOrder(rid, primary);
    results.push({ tableNumber: primary, orderId: primaryOrder?.id ?? null });

    // שאר השולחנות – פותח להם צ'קים נפרדים
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

    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: errorCode };
    return;
  }

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true, seated: results, guestName };
});

/** POST /api/host/reservation/status – עדכון סטטוס הזמנה (ביטול / לא הגיע) */
hostRouter.post("/api/host/reservation/status", async (ctx) => {
  if (!requireStaff(ctx)) return;

  const user = ctx.state.user;
  if (user.role !== "owner" && user.role !== "manager") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  const payload = await readJsonBody(ctx) ?? {};

  const rid = String(payload.restaurantId ?? payload.rid ?? "").trim();
  const reservationId = String(payload.reservationId ?? "").trim();
  const status = String(payload.status ?? "").toLowerCase();

  if (!rid || !reservationId || !status) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "missing_fields" };
    return;
  }

  // נאפשר "cancelled" ו-"no_show" (אפשר להרחיב בעתיד)
  const allowed = ["cancelled", "canceled", "no_show"];
  if (!allowed.includes(status)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "invalid_status" };
    return;
  }

  await setReservationStatus(reservationId, status);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = { ok: true };
});
