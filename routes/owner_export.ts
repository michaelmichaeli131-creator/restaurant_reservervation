// src/routes/owner_export.ts
// ייצוא הזמנות ל-CSV — בעלים בלבד
// GET /owner/restaurants/:rid/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// - אימות בעלות זהה ל-owner_hours.ts (requireOwner + השוואת ownerId).
// - סריקת טווח יעילה על אינדקס ["reservation_by_day", rid, date, reservationId]
//   באמצעות kv.list עם start/end (ללא סריקה מלאה).
// - CSV עם BOM (UTF-8) כדי ש-Excel יציג עברית/גאורגית נכון.

import { Router, Status } from "jsr:@oak/oak";
import {
  kv,
  getRestaurant,
  getRoomLabelMapForRestaurant,
  getReservationRoomLabelFromMap,
  type Reservation,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";

const ownerExportRouter = new Router();

/* ───────────────────────── Date helpers (UTC-safe) ───────────────────────── */

const pad2 = (n: number) => String(n).padStart(2, "0");

function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "YYYY-MM-DD" תקין (כולל תאריך אמיתי) או null */
function normalizeISODate(s: string | null | undefined): string | null {
  const v = String(s ?? "").trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return toISODate(d) === v ? v : null;
}

function addDaysISO(iso: string, days: number): string {
  const [y, mo, da] = iso.split("-").map(Number);
  return toISODate(new Date(Date.UTC(y, mo - 1, da + days)));
}

function diffDaysISO(fromISO: string, toISO: string): number {
  const p = (s: string) => {
    const [y, mo, da] = s.split("-").map(Number);
    return Date.UTC(y, mo - 1, da);
  };
  return Math.round((p(toISO) - p(fromISO)) / 86_400_000);
}

/* ───────────────────────── Range scan on the day index ───────────────────────── */

/**
 * קריאת טווח יעילה: kv.list עם start/end על האינדקס
 * ["reservation_by_day", restaurantId, date, reservationId].
 * end הוא בלעדי (exclusive) ולכן משתמשים ביום שאחרי toDate.
 */
async function listReservationsByRestaurantRange(
  restaurantId: string,
  fromDate: string,
  toDate: string,
): Promise<Reservation[]> {
  const start: Deno.KvKey = ["reservation_by_day", restaurantId, fromDate];
  const end: Deno.KvKey = ["reservation_by_day", restaurantId, addDaysISO(toDate, 1)];

  const ids: string[] = [];
  for await (const row of kv.list({ start, end })) {
    const id = String(row.key[row.key.length - 1] ?? "");
    if (id) ids.push(id);
  }

  // שליפת הרשומות עצמן ב-batches של 10 (מגבלת kv.getMany)
  const out: Reservation[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const keys = ids.slice(i, i + 10).map((id) => ["reservation", id] as Deno.KvKey);
    const rows = await kv.getMany<Reservation[]>(keys as never);
    for (const entry of rows) {
      const r = entry.value as Reservation | null;
      if (r) out.push(r);
    }
  }

  out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return out;
}

/* ───────────────────────── CSV helpers ───────────────────────── */

function csvField(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

const HEADER_FALLBACK_EN: Record<string, string> = {
  date: "Date",
  time: "Time",
  name: "Guest name",
  phone: "Phone",
  people: "Guests",
  status: "Status",
  room: "Room",
  occasion: "Occasion",
  dietary: "Dietary",
  note: "Notes",
  created: "Created at",
};

const HEADER_COLUMNS = [
  "date", "time", "name", "phone", "people", "status",
  "room", "occasion", "dietary", "note", "created",
] as const;

/** תרגום כותרת דרך ctx.state.t עם fallback לאנגלית */
function headerLabel(ctx: unknown, col: string): string {
  const key = `export.csv.${col}`;
  try {
    const t = ((ctx as { state?: { t?: (k: string) => string } })?.state)?.t;
    const s = typeof t === "function" ? t(key) : "";
    if (s && s !== key && s !== `(${key})`) return s;
  } catch { /* fall through */ }
  return HEADER_FALLBACK_EN[col] ?? col;
}

/* ───────────────────────── Route ───────────────────────── */

ownerExportRouter.get("/owner/restaurants/:rid/export.csv", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Not found";
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "Forbidden";
    return;
  }

  // טווח: ברירת מחדל — 90 יום אחורה עד 60 יום קדימה; תקרה — 366 ימים
  const sp = ctx.request.url.searchParams;
  const todayISO = toISODate(new Date());
  let from = normalizeISODate(sp.get("from")) ?? addDaysISO(todayISO, -90);
  let to = normalizeISODate(sp.get("to")) ?? addDaysISO(todayISO, 60);
  if (from > to) [from, to] = [to, from];
  if (diffDaysISO(from, to) > 366) to = addDaysISO(from, 366);

  const reservations = await listReservationsByRestaurantRange(rid, from, to);
  const roomLabelMap = await getRoomLabelMapForRestaurant(rid).catch(
    () => new Map<string, string>(),
  );

  const lines: string[] = [];
  lines.push(HEADER_COLUMNS.map((c) => csvField(headerLabel(ctx, c))).join(","));

  for (const x of reservations) {
    const name = [x.firstName, x.lastName].filter(Boolean).join(" ");
    const room = getReservationRoomLabelFromMap(x, roomLabelMap);
    const dietary = Array.isArray(x.dietary) ? x.dietary.join("|") : "";
    const created = x.createdAt ? new Date(x.createdAt).toISOString() : "";
    lines.push([
      x.date ?? "",
      x.time ?? "",
      name,
      x.phone ?? "",
      x.people ?? "",
      x.status ?? "",
      room,
      x.occasion ?? "",
      dietary,
      x.note ?? "",
      created,
    ].map(csvField).join(","));
  }

  const safeRid = rid.replace(/[^A-Za-z0-9_-]/g, "");
  const filename = `reservations-${safeRid}-${from}-${to}.csv`;

  ctx.response.status = Status.OK;
  ctx.response.headers.set("Content-Type", "text/csv; charset=utf-8");
  ctx.response.headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  ctx.response.headers.set("Cache-Control", "no-store");
  // BOM קריטי כדי ש-Excel יזהה UTF-8 (עברית/גאורגית)
  ctx.response.body = "\uFEFF" + lines.join("\r\n") + "\r\n";
});

export default ownerExportRouter;
export { ownerExportRouter };
