// services/seating_service.ts
// Seating logic: host seats a reservation to a table -> creates open order and locks table.

import {
  kv,
  type Reservation,
  getReservationById,
  setReservationStatus,
} from "../database.ts";
import { getOrCreateOpenOrder } from "../pos/pos_db.ts";

function kSeat(restaurantId: string, table: number): Deno.KvKey {
  return ["seat", "by_table", restaurantId, table];
}

function kSeatByRes(reservationId: string): Deno.KvKey {
  return ["seat", "by_res", reservationId];
}

export interface SeatingInfo {
  restaurantId: string;
  table: number;
  reservationId: string;
  seatedAt: number;
  guestName?: string;
}

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

  // 2. לוודא שההזמנה עדיין פעילה (לא בוטלה / לא הוגדרה כ-no_show)
  const status = String(reservation.status ?? "new").toLowerCase();
  if (["cancelled", "canceled", "no_show", "noshow"].includes(status)) {
    throw new Error("reservation_cancelled");
  }

  const seatKey = kSeat(restaurantId, table);
  const seatRow = await kv.get<SeatingInfo>(seatKey);

  // אם כבר יש ישיבה מוגדרת לשולחן הזה – לא נדרוך עליה
  if (seatRow.value) {
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

  const tx = kv
    .atomic()
    // נוודא שהשולחן עדיין ריק (אין רשומה ב-KV)
    .check({ key: seatKey, versionstamp: null })
    .set(seatKey, data)
    .set(kSeatByRes(reservationId), data);

  const result = await tx.commit();
  if (!result.ok) {
    throw new Error("table_already_seated");
  }

  // לפתוח / לוודא שיש צ'ק פתוח לשולחן זה
  await getOrCreateOpenOrder(restaurantId, table);

  // לסמן את ההזמנה כ-arrived
  try {
    await setReservationStatus(reservationId, "arrived");
  } catch {
    // לא קריטי לפוצץ את הקריאה על זה
  }

  return data;
}

/**
 * שחרור שולחן ממצב "seated".
 * חשוב: תומך גם ברשומות ישנות/שבורות שאין להן reservationId תקין,
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
