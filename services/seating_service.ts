
// services/seating_service.ts
// Seating logic: host seats a reservation to a table -> creates open order and locks table.

import { kv, type Reservation, getReservationById, setReservationStatus } from "../database.ts";
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
}

export async function isTableSeated(restaurantId: string, table: number): Promise<boolean> {
  const cur = await kv.get<SeatingInfo>(kSeat(restaurantId, table));
  return !!cur.value;
}

export async function getSeatingForTable(restaurantId: string, table: number): Promise<SeatingInfo | null> {
  const cur = await kv.get<SeatingInfo>(kSeat(restaurantId, table));
  return cur.value ?? null;
}

export async function seatReservation(params: { restaurantId: string; reservationId: string; table: number }): Promise<SeatingInfo> {
  const { restaurantId, reservationId, table } = params;
  if (!restaurantId || !reservationId || !table) {
    throw new Error("missing_fields");
  }

  // Validate reservation
  const resv = await getReservationById(reservationId) as Reservation | null;
  if (!resv || resv.restaurantId !== restaurantId) {
    throw new Error("reservation_not_found");
  }
  if (String(resv.status).toLowerCase() === "cancelled" || String(resv.status).toLowerCase() === "canceled") {
    throw new Error("reservation_cancelled");
  }

  // Lock table if not already seated
  const seatKey = kSeat(restaurantId, table);
  const seatByResKey = kSeatByRes(reservationId);
  const now = Date.now();
  const data: SeatingInfo = { restaurantId, table, reservationId, seatedAt: now };

  const tx = kv.atomic()
    .check({ key: seatKey, versionstamp: null }) // ensure table not seated
    .set(seatKey, data)
    .set(seatByResKey, data);
  const result = await tx.commit();
  if (!result.ok) {
    throw new Error("table_already_seated");
  }

  // Create open order so the table becomes 'occupied' in the floor view
  await getOrCreateOpenOrder(restaurantId, table);

  // Mark reservation as 'arrived'
  try { await setReservationStatus(reservationId, "arrived"); } catch {}

  return data;
}

export async function unseatTable(restaurantId: string, table: number): Promise<boolean> {
  const cur = await kv.get<SeatingInfo>(kSeat(restaurantId, table));
  if (!cur.value) return true;
  await kv.delete(kSeat(restaurantId, table));
  await kv.delete(kSeatByRes(cur.value.reservationId));
  return true;
}
