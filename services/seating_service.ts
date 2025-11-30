// src/services/seating_service.ts
// -------------------------------------------
// Seating logic:
// - seatReservation: המארחת מושיבה הזמנה לשולחן → נועלים את השולחן ופותחים הזמנה (Order)
// - unseatTable: שחרור שולחן (למקרה שנשארו "רוחות רפאים")
// - isTableSeated: בדיקה אם שולחן תפוס (בשביל POS / מלצר)
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
 * - נועלים את השולחן ב-KV (atomic + check)
 * - פותחים הזמנה פתוחה (Order) לשולחן
 * - מעדכנים את סטטוס ההזמנה ל-arrived
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

  // 3. לבדוק אם השולחן כבר תפוס
  const seatKey = kSeat(restaurantId, table);
  const seatRow = await kv.get<SeatingInfo>(seatKey);
  if (seatRow.value) {
    // יש כבר רשומת ישיבה לשולחן הזה
    throw new Error("table_already_seated");
  }

  const now = Date.now();
  const data: SeatingInfo = {
    restaurantId,
    table,
    reservationId,
    seatedAt: now,
    guestName: guestName?.trim() || undefined,
  };

  // 4. atomic: נוודא שהשולחן עדיין ריק ונרשום ישיבה
  const tx = kv
    .atomic()
    .check({ key: seatKey, versionstamp: null }) // דורש שהשולחן יהיה ריק
    .set(seatKey, data)
    .set(kSeatByRes(reservationId), data);

  const result = await tx.commit();
  if (!result.ok) {
    // אם העסקה נכשלה – כנראה מישהו אחר כבר תפס את השולחן
    throw new Error("table_already_seated");
  }

  // 5. פתיחת צ'ק פתוח לשולחן
  await getOrCreateOpenOrder(restaurantId, table);

  // 6. עדכון סטטוס ההזמנה ל-arrived (לא מפילים על זה את הקריאה אם נכשל)
  try {
    await setReservationStatus(reservationId, "arrived");
  } catch {
    // ignore
  }

  return data;
}

/**
 * שחרור שולחן ממצב "seated".
 * תומך גם ברשומות ישנות/שבורות שאין להן reservationId תקין,
 * כדי לנקות "רוחות רפאים" שגורמות ל-table_already_seated.
 */
export async function unseatTable(
  restaurantId: string,
  table: number,
): Promise<boolean> {
  const seatKey = kSeat(restaurantId, table);
  const seatRow = await kv.get<SeatingInfo>(seatKey);
  const cur = seatRow.value;

  // אם אין רשומה בכלל – מבחינתנו השולחן כבר משוחרר
  if (!cur) return true;

  const tx = kv.atomic().check(seatRow).delete(seatKey);

  // רק אם יש reservationId תקין – נמחק גם את האינדקס לפי הזמנה
  if (
    cur &&
    typeof cur.reservationId === "string" &&
    cur.reservationId.trim().length > 0
  ) {
    tx.delete(kSeatByRes(cur.reservationId));
  }

  const res = await tx.commit();
  return res.ok;
}
