// src/services/timeclock_db.ts
// --------------------------------------------------------
// TimeClock / Attendance (Clock-in / Clock-out)
// --------------------------------------------------------
// מטרות:
// - עובד (StaffMember) יכול לבצע "כניסה" ו"יציאה".
// - בכל רגע נתון לעובד יש לכל היותר רשומת עבודה פתוחה אחת.
// - שומרים KV עם אינדקסים לפי מסעדה/עובד/יום כדי לאפשר דוחות/לוח שנה בהמשך.
// --------------------------------------------------------

import { kv } from "../database.ts";

const now = () => Date.now();

export type TimeEntrySource = "staff" | "owner" | "manager";

export type TimeEntry = {
  id: string;

  restaurantId: string;

  // קשר לעובד/משתמש
  staffId: string;
  userId: string;

  // זמני משמרת
  clockInAt: number; // ms epoch
  clockOutAt?: number | null; // ms epoch

  // מטא
  source: TimeEntrySource;
  createdAt: number;
  updatedAt?: number;
  createdByUserId?: string; // מי יצר (אם owner/manager עשה ידני)
  updatedByUserId?: string; // מי עדכן
};

// ---------------- Key helpers ----------------

// entry value
function entryKey(restaurantId: string, entryId: string) {
  return ["time_entry", restaurantId, entryId] as const;
}

// entryId -> restaurantId
function entryByIdKey(entryId: string) {
  return ["time_entry_by_id", entryId] as const;
}

// open entry per staff (only one open)
function openByStaffKey(staffId: string) {
  return ["time_open_by_staff", staffId] as const;
}

// index: by restaurant + day
function byRestaurantDayKey(restaurantId: string, dayKey: string, entryId: string) {
  return ["time_by_restaurant_day", restaurantId, dayKey, entryId] as const;
}

// index: by staff + day
function byStaffDayKey(staffId: string, dayKey: string, entryId: string) {
  return ["time_by_staff_day", staffId, dayKey, entryId] as const;
}

type EntryIdIndex = { restaurantId: string };
type OpenIndex = { entryId: string; restaurantId: string };

function ymdKey(ts: number): string {
  // UTC date key to keep deterministic across servers
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------- Reads ----------------

export async function getTimeEntryById(entryId: string): Promise<TimeEntry | null> {
  const idx = await kv.get<EntryIdIndex>(entryByIdKey(entryId));
  if (!idx.value) return null;

  const res = await kv.get<TimeEntry>(entryKey(idx.value.restaurantId, entryId));
  return res.value ?? null;
}

export async function getOpenEntryForStaff(staffId: string): Promise<TimeEntry | null> {
  const open = await kv.get<OpenIndex>(openByStaffKey(staffId));
  if (!open.value?.entryId) return null;

  const entry = await getTimeEntryById(open.value.entryId);
  if (!entry) return null;

  // sanity: only open
  if (entry.clockOutAt) return null;
  return entry;
}

export async function listEntriesForRestaurantDay(
  restaurantId: string,
  dayKey: string,
): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for await (const row of kv.list({ prefix: ["time_by_restaurant_day", restaurantId, dayKey] })) {
    const entryId = row.key[row.key.length - 1] as string;
    const e = await getTimeEntryById(entryId);
    if (e) out.push(e);
  }
  out.sort((a, b) => (a.clockInAt ?? 0) - (b.clockInAt ?? 0));
  return out;
}

export async function listEntriesForStaffDay(staffId: string, dayKey: string): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for await (const row of kv.list({ prefix: ["time_by_staff_day", staffId, dayKey] })) {
    const entryId = row.key[row.key.length - 1] as string;
    const e = await getTimeEntryById(entryId);
    if (e) out.push(e);
  }
  out.sort((a, b) => (a.clockInAt ?? 0) - (b.clockInAt ?? 0));
  return out;
}

// ---------------- Writes ----------------

export async function clockIn(args: {
  restaurantId: string;
  staffId: string;
  userId: string;
  source: TimeEntrySource;
  createdByUserId?: string;
  at?: number; // for tests/manual
}): Promise<TimeEntry> {
  const ts = typeof args.at === "number" ? args.at : now();
  const day = ymdKey(ts);

  // prevent double open
  const existingOpen = await kv.get<OpenIndex>(openByStaffKey(args.staffId));
  if (existingOpen.value?.entryId) {
    const err: any = new Error("clock_in_conflict");
    err.code = "clock_in_conflict";
    throw err;
  }

  const id = crypto.randomUUID();

  const entry: TimeEntry = {
    id,
    restaurantId: args.restaurantId,
    staffId: args.staffId,
    userId: args.userId,
    clockInAt: ts,
    clockOutAt: null,
    source: args.source,
    createdAt: ts,
    updatedAt: ts,
    createdByUserId: args.createdByUserId,
    updatedByUserId: args.createdByUserId,
  };

  const tx = kv.atomic()
    // must not already have open entry
    .check({ key: openByStaffKey(args.staffId), versionstamp: null })
    // must not already have the same entryId index
    .check({ key: entryByIdKey(id), versionstamp: null })
    .set(entryKey(args.restaurantId, id), entry)
    .set(entryByIdKey(id), { restaurantId: args.restaurantId })
    .set(openByStaffKey(args.staffId), { entryId: id, restaurantId: args.restaurantId })
    .set(byRestaurantDayKey(args.restaurantId, day, id), true)
    .set(byStaffDayKey(args.staffId, day, id), true);

  const res = await tx.commit();
  if (!res.ok) {
    const err: any = new Error("clock_in_conflict");
    err.code = "clock_in_conflict";
    throw err;
  }

  return entry;
}

export async function clockOut(args: {
  staffId: string;
  source: TimeEntrySource;
  updatedByUserId?: string;
  at?: number;
}): Promise<TimeEntry> {
  const ts = typeof args.at === "number" ? args.at : now();

  const open = await kv.get<OpenIndex>(openByStaffKey(args.staffId));
  if (!open.value?.entryId) {
    const err: any = new Error("no_open_entry");
    err.code = "no_open_entry";
    throw err;
  }

  const entryId = open.value.entryId;
  const entry = await getTimeEntryById(entryId);
  if (!entry) {
    // stale open pointer
    const err: any = new Error("open_entry_missing");
    err.code = "open_entry_missing";
    throw err;
  }

  if (entry.clockOutAt) {
    // already closed
    const err: any = new Error("already_closed");
    err.code = "already_closed";
    throw err;
  }

  const next: TimeEntry = {
    ...entry,
    clockOutAt: ts,
    updatedAt: ts,
    updatedByUserId: args.updatedByUserId ?? entry.updatedByUserId,
  };

  const tx = kv.atomic()
    // only if still open pointer points to this entry
    .check({ key: openByStaffKey(args.staffId), versionstamp: open.versionstamp })
    .set(entryKey(entry.restaurantId, entryId), next)
    .set(entryByIdKey(entryId), { restaurantId: entry.restaurantId })
    .delete(openByStaffKey(args.staffId));

  const res = await tx.commit();
  if (!res.ok) {
    const err: any = new Error("clock_out_conflict");
    err.code = "clock_out_conflict";
    throw err;
  }

  return next;
}
