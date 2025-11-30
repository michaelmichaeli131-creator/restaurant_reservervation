// src/services/seating_service.ts
// -------------------------------------------
// Seating logic:
// - isTableSeated: בדיקה אם שולחן תפוס (משמש POS / מלצר)
// - seatReservation: המארחת מושיבה הזמנה לשולחן → נועלים את השולחן ופותחים Order
// - unseatTable: שחרור שולחן (כולל טיפול ברשומות ישנות / שבורות)
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
 * - נועלים את השולחן ב-KV
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

  // 4. שמירת ישיבה בשני אינדקסים (לפי שולחן ולפי הזמנה)
  // כאן לא חייבים atomic מורכב – מספיק שנשמור עקבי "או הכל או כלום", אבל במקרה הגרוע
  // המפתח השני לא ייכתב וזה לא מפיל את ההושבה.
  try {
    await kv.set(seatKey, data);
    await kv.set(kSeatByRes(reservationId), data);
  } catch (err) {
    console.error("[SEATING] seatReservation KV ERROR", {
      restaurantId,
      table,
      reservationId,
      msg: (err as Error).message,
    });
    throw new Error("seat_failed");
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
 * חשוב: ויתרנו על atomic().check(...) כדי להימנע משגיאות טיפוס על רשומות ישנות.
 * במקרה הגרוע – ננסה למחוק, אם נכשל נלוגג ונחזיר false.
 */
export async function unseatTable(
  restaurantId: string,
  table: number,
): Promise<boolean> {
  const seatKey = kSeat(restaurantId, table);

  try {
    const seatRow = await kv.get<SeatingInfo>(seatKey);
    const cur = seatRow.value;

    // אין רשומת ישיבה בכלל => מבחינתנו השולחן משוחרר
    if (!cur) return true;

    // מוחקים את המפתח הראשי לפי שולחן
    await kv.delete(seatKey);

    // אם יש reservationId סביר – ננסה למחוק גם את האינדקס לפי הזמנה
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
        // לא מפיל את כל הפעולה – העיקר שהמפתח לפי שולחן נמחק
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
