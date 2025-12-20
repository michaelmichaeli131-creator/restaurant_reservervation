// src/services/time_db.ts
// --------------------------------------------------------
// Time clock DB (KV)
// - Staff clock-in/out
// - Enforce: only 1 open entry per staffId
// - Index by id and by restaurant/day for future calendar/report
// --------------------------------------------------------

import { kv } from "../database.ts";

export type TimeEntrySource = "staff" | "owner" | "manager";

export type TimeEntry = {
  id: string;
  restaurantId: string;
  staffId: string;
  userId: string;

  clockInAt: number;
  clockOutAt?: number | null;

  source: TimeEntrySource;

  createdAt: number;
  updatedAt?: number;

  // audit-like fields (optional)
  createdByUserId?: string;
  updatedByUserId?: string;
  closedByUserId?: string;
  closedByRole?: string;
};

const now = () => Date.now();

// -------- KV keys --------
function entryKey(restaurantId: string, entryId: string) {
  return ["time_entry", restaurantId, entryId] as const;
}

function entryByIdKey(entryId: string) {
  return ["time_entry_by_id", entryId] as const;
}

function openByStaffKey(staffId: string) {
  return ["time_open_by_staff", staffId] as const;
}

function byRestaurantDayKey(restaurantId: string, dayKey: string, entryId: string) {
  return ["time_by_restaurant_day", restaurantId, dayKey, entryId] as const;
}

function byStaffDayKey(staffId: string, dayKey: string, entryId: string) {
  return ["time_by_staff_day", staffId, dayKey, entryId] as const;
}

type EntryIdIndex = { restaurantId: string };
type OpenIndex = { entryId: string; restaurantId: string };

function ymdKeyUTC(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// -------- reads --------

export async function getOpenEntryIdByStaff(staffId: string): Promise<string | null> {
  const res = await kv.get<OpenIndex>(openByStaffKey(staffId));
  return res.value?.entryId ?? null;
}

export async function getTimeEntry(entryId: string): Promise<TimeEntry | null> {
  const idx = await kv.get<EntryIdIndex>(entryByIdKey(entryId));
  if (!idx.value?.restaurantId) return null;

  const res = await kv.get<TimeEntry>(entryKey(idx.value.restaurantId, entryId));
  return res.value ?? null;
}

// -------- writes --------

export async function createClockIn(args: {
  restaurantId: string;
  staffId: string;
  userId: string;
  source: TimeEntrySource;
  at?: number; // optional (tests/manual)
}): Promise<
  | { ok: true; entry: TimeEntry }
  | { ok: false; error: "already_open"; openEntryId: string }
> {
  const ts = typeof args.at === "number" ? args.at : now();
  const day = ymdKeyUTC(ts);

  // Check existing open
  const open = await kv.get<OpenIndex>(openByStaffKey(args.staffId));
  if (open.value?.entryId) {
    return { ok: false, error: "already_open", openEntryId: open.value.entryId };
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
    createdByUserId: args.userId,
    updatedByUserId: args.userId,
  };

  // Atomic: create entry + create open pointer
  const tx = kv.atomic()
    // ensure no open pointer exists
    .check({ key: openByStaffKey(args.staffId), versionstamp: null })
    // ensure entry id index doesn't exist
    .check({ key: entryByIdKey(id), versionstamp: null })
    .set(entryKey(args.restaurantId, id), entry)
    .set(entryByIdKey(id), { restaurantId: args.restaurantId })
    .set(openByStaffKey(args.staffId), { entryId: id, restaurantId: args.restaurantId })
    // future calendar/report indexes
    .set(byRestaurantDayKey(args.restaurantId, day, id), true)
    .set(byStaffDayKey(args.staffId, day, id), true);

  const res = await tx.commit();
  if (!res.ok) {
    // someone raced and created open pointer
    const open2 = await kv.get<OpenIndex>(openByStaffKey(args.staffId));
    if (open2.value?.entryId) {
      return { ok: false, error: "already_open", openEntryId: open2.value.entryId };
    }
    throw new Error("createClockIn atomic commit failed");
  }

  return { ok: true, entry };
}

export async function clockOut(args: {
  staffId: string;
  userId: string;
  roleForAudit: string; // "staff" / "owner" ...
  at?: number;
}): Promise<
  | { ok: true; entry: TimeEntry }
  | { ok: false; error: "no_open" | "not_found" | "already_closed" | "conflict"; entry?: TimeEntry }
> {
  const ts = typeof args.at === "number" ? args.at : now();

  const open = await kv.get<OpenIndex>(openByStaffKey(args.staffId));
  if (!open.value?.entryId) return { ok: false, error: "no_open" };

  const entryId = open.value.entryId;
  const entry = await getTimeEntry(entryId);
  if (!entry) {
    // stale pointer
    // try cleanup (best-effort)
    await kv.delete(openByStaffKey(args.staffId));
    return { ok: false, error: "not_found" };
  }

  if (entry.clockOutAt) {
    // already closed; clear open pointer if exists
    await kv.delete(openByStaffKey(args.staffId));
    return { ok: false, error: "already_closed", entry };
  }

  const next: TimeEntry = {
    ...entry,
    clockOutAt: ts,
    updatedAt: ts,
    updatedByUserId: args.userId,
    closedByUserId: args.userId,
    closedByRole: args.roleForAudit,
  };

  // Atomic: ensure open pointer unchanged, update entry, delete open pointer
  const tx = kv.atomic()
    .check({ key: openByStaffKey(args.staffId), versionstamp: open.versionstamp })
    .set(entryKey(entry.restaurantId, entryId), next)
    .set(entryByIdKey(entryId), { restaurantId: entry.restaurantId })
    .delete(openByStaffKey(args.staffId));

  const res = await tx.commit();
  if (!res.ok) return { ok: false, error: "conflict" };

  return { ok: true, entry: next };
}
