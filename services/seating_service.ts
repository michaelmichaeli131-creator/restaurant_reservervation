// src/services/seating_service.ts
// -------------------------------------------
// Seating logic:
// - isTableSeated: בדיקה אם שולחן תפוס (משמש POS / מלצרים)
// - seatReservation: המארחת מושיבה הזמנה לשולחן → נועלים את השולחן ופותחים Order
// - unseatTable: שחרור שולחן (best-effort)
// - getSeatingByTable: החזרת מידע ישיבה לשולחן (למסך המארחת)
// -------------------------------------------

import {
  kv,
  getReservationById,
  setReservationStatus,
} from "../database.ts";
import { getOrCreateOpenOrder } from "../pos/pos_db.ts";

/** מפתח KV: ישיבה לפי שולחן */
function kSeat(restaurantId: string, table: number): Deno.KvKey {
  return ["seat", "by_table", restaurantId, table];
}

/** מפתח KV: ישיבה לפי הזמנה */
function kSeatByRes(reservationId: string): Deno.KvKey {
  return ["seat", "by_res", reservationId];
}

/** מידע ישיבה שנשמר ב-KV */
export interface SeatingInfo {
  restaurantId: string;
  table: number;
  reservationId: string;
  seatedAt: number;
  guestName?: string;
  people?: number;
  time?: string; // שעת ההזמנה (כמו שנשמרת ב-reservation)
}

/**
 * בדיקה אם שולחן כבר "תפוס" לפי KV.
 * משמש ע"י POS (מלצרים) כדי לא לפתוח שולחן כשהוא כבר תפוס ב-host.
 */
export async function isTableSeated(
  restaurantId: string,
  table: number,
): Promise<boolean> {
  const row = await kv.get<SeatingInfo>(kSeat(restaurantId, table));
  return !!row.value;
}

/**
 * הושבת הזמנה לשולחן:
 * - מוודאים שההזמנה קיימת ולא בוטלה / no_show
 * - שומרים רשומת ישיבה (DRIVE-OVER על מצב קודם אם יש)
 * - פותחים צ'ק פתוח (Order) לשולחן
 * - מעדכנים את סטטוס ההזמנה ל-arrived
 *
 * שים לב:
 * ❌ אין כאן table_already_seated – המארחת יכולה לדרוס מצב ישן.
 */
export async function seatReservation(params: {
  restaurantId: string;
  reservationId: string;
  table: number;
  guestName?: string;
}): Promise<SeatingInfo> {
  const { restaurantId, reservationId, table, guestName } = params;

  // 1. לוודא שההזמנה קיימת
  const reservation = await getReservationById(reservationId);
  if (!reservation) {
    throw new Error("reservation_not_found");
  }

  // 2. לוודא שההזמנה עדיין פעילה
  const status = String(reservation.status ?? "new").toLowerCase();
  if (["cancelled", "canceled", "no_show", "noshow"].includes(status)) {
    throw new Error("reservation_cancelled");
  }

  const now = Date.now();

  const people = reservation.people != null
    ? Number(reservation.people)
    : undefined;
  const time = reservation.time ? String(reservation.time) : undefined;

  const resolvedGuestName = (() => {
    const direct = guestName?.trim();
    // Ignore placeholder names coming from the UI
    if (direct && direct !== "—" && direct !== "-") return direct;

    // Common reservation schema: firstName/lastName
    const firstLast = (() => {
      const fn = (reservation as any).firstName == null ? "" : String((reservation as any).firstName).trim();
      const ln = (reservation as any).lastName == null ? "" : String((reservation as any).lastName).trim();
      const full = `${fn} ${ln}`.trim();
      return full.length ? full : "";
    })();
    if (firstLast && firstLast !== "—" && firstLast !== "-") return firstLast;

    const cand = [
      (reservation as any).name,
      (reservation as any).guestName,
      (reservation as any).fullName,
      (reservation as any).customerName,
      (reservation as any).contactName,
    ]
      .map((v) => (v == null ? "" : String(v).trim()))
      .find((v) => v.length > 0 && v !== "—" && v !== "-");

    if (cand) return cand;

    // Many flows store the customer's name inside `reservation.note` (e.g. "Name: John Doe").
    const note = (reservation as any).note == null ? "" : String((reservation as any).note);
    const m = note.match(/(?:^|[;\n])\s*(?:name|customer\s*name|שם)\s*:\s*([^;\n]+)/i);
    const parsed = m?.[1]?.trim();
    if (parsed && parsed !== "—" && parsed !== "-") return parsed;

    return undefined;
  })();

  const data: SeatingInfo = {
    restaurantId,
    table,
    reservationId,
    seatedAt: now,
    guestName: resolvedGuestName,
    people,
    time,
  };

  const seatKey = kSeat(restaurantId, table);
  const resKey = kSeatByRes(reservationId);

  // 3. שומרים את הישיבה – דורכים על כל מה שהיה קודם
  try {
    await kv.set(seatKey, data);
    await kv.set(resKey, data);
  } catch (err) {
    console.error("[SEATING] seatReservation KV ERROR", {
      restaurantId,
      table,
      reservationId,
      msg: (err as Error).message,
    });
    throw new Error("seat_failed");
  }

  // 4. פתיחת צ'ק פתוח לשולחן (אם כבר קיים open – נקבל אותו)
  await getOrCreateOpenOrder(restaurantId, table);

  // 5. עדכון סטטוס ההזמנה ל-arrived (לא מפילים על זה את הקריאה אם נכשל)
  try {
    await setReservationStatus(reservationId, "arrived");
  } catch {
    // ignore
  }

  return data;
}

/**
 * שחרור שולחן ממצב "seated".
 * זה best-effort – גם אם לא הצליח לגמרי, seatReservation יודע לדרוס.
 */
export async function unseatTable(params: {
  restaurantId: string;
  table: number;
}): Promise<boolean> {
  const { restaurantId, table } = params;
  const seatKey = kSeat(restaurantId, table);

  try {
    const seatRow = await kv.get<SeatingInfo>(seatKey);
    const cur = seatRow.value;

    // אין רשומת ישיבה בכלל => מבחינתנו השולחן משוחרר
    if (!cur) return true;

    await kv.delete(seatKey);

    if (cur.reservationId) {
      try {
        await kv.delete(kSeatByRes(String(cur.reservationId)));
      } catch (innerErr) {
        console.error("[SEATING] unseatTable delete by_res ERROR", {
          restaurantId,
          table,
          reservationId: cur.reservationId,
          msg: (innerErr as Error).message,
        });
      }
    }

    return true;
  } catch (err) {
    console.error("[SEATING] unseatTable ERROR", {
      restaurantId,
      table,
      msg: (err as Error).message,
    });
    return false;
  }
}

/**
 * החזרת מידע ישיבה לשולחן ספציפי (למסך המארחת / API).
 */
export async function getSeatingByTable(
  restaurantId: string,
  table: number,
): Promise<SeatingInfo | null> {
  const row = await kv.get<SeatingInfo>(kSeat(restaurantId, table));
  return row.value ?? null;
}
