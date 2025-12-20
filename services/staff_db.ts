// src/services/time_db.ts
// --------------------------------------------------------
// Time clock DB (KV)
// - Staff clock-in/out
// - Enforce: only 1 open entry per staffId
// - Index by id and by restaurant/day for calendar/report
// - NEW: list by restaurant/day + range
// - NEW: owner/manual edit with index re-key (if day changes)
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

  // optional notes for manual edits (you can show in UI)
  note?: string;
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

// ---------------- Day helpers ----------------
// Default is UTC to stay consistent with your existing indexes.
// If later you want local restaurant day (Israel), you can switch to ymdKeyLocal().
export function ymdKeyUTC(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Optional helper: compute day key by fixed offset minutes (e.g. Israel winter +120, summer +180)
// (Not used by default – but useful if you want calendar in local time.)
export function ymdKeyWithOffset(ts: number, offsetMinutes: number): string {
  const shifted = ts + offsetMinutes * 60_000;
  const d = new Date(shifted);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Utility: iterate yyyy-mm-dd day keys between two timestamps (UTC-based)
function* dayKeysBetweenUTC(fromTs: number, toTs: number): Generator<string> {
  const start = new Date(Date.UTC(
    new Date(fromTs).getUTCFullYear(),
    new Date(fromTs).getUTCMonth(),
    new Date(fromTs).getUTCDate(),
  ));
  const end = new Date(Date.UTC(
    new Date(toTs).getUTCFullYear(),
    new Date(toTs).getUTCMonth(),
    new Date(toTs).getUTCDate(),
  ));

  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    yield `${yyyy}-${mm}-${dd}`;
  }
}

// ---------------- reads ----------------

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

// List entries for a restaurant on a given dayKey (yyyy-mm-dd)
export async function listTimeEntriesByRestaurantDay(
  restaurantId: string,
  dayKey: string,
): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for await (const row of kv.list({ prefix: ["time_by_restaurant_day", restaurantId, dayKey] })) {
    const entryId = row.key[row.key.length - 1] as string;
    const res = await kv.get<TimeEntry>(entryKey(restaurantId, entryId));
    if (res.value) out.push(res.value);
  }
  // sort by clockInAt asc
  out.sort((a, b) => (a.clockInAt ?? 0) - (b.clockInAt ?? 0));
  return out;
}

// List entries for a staff on a given dayKey (yyyy-mm-dd)
export async function listTimeEntriesByStaffDay(
  staffId: string,
  dayKey: string,
): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for await (const row of kv.list({ prefix: ["time_by_staff_day", staffId, dayKey] })) {
    const entryId = row.key[row.key.length - 1] as string;
    const entry = await getTimeEntry(entryId);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => (a.clockInAt ?? 0) - (b.clockInAt ?? 0));
  return out;
}

// List entries for restaurant in a time range (UTC day slicing using the day index)
export async function listTimeEntriesByRestaurantRange(
  restaurantId: string,
  fromTs: number,
  toTs: number,
): Promise<TimeEntry[]> {
  const map = new Map<string, TimeEntry>();

  const a = Math.min(fromTs, toTs);
  const b = Math.max(fromTs, toTs);

  for (const dayKey of dayKeysBetweenUTC(a, b)) {
    const dayEntries = await listTimeEntriesByRestaurantDay(restaurantId, dayKey);
    for (const e of dayEntries) {
      // filter by overlap with [a,b]
      const inAt = e.clockInAt ?? 0;
      const outAt = e.clockOutAt ?? null;

      // if open - include if started before end
      if (!outAt) {
        if (inAt <= b) map.set(e.id, e);
        continue;
      }

      // closed - include if overlaps
      const overlaps = inAt <= b && outAt >= a;
      if (overlaps) map.set(e.id, e);
    }
  }

  const out = Array.from(map.values());
  out.sort((x, y) => (x.clockInAt ?? 0) - (y.clockInAt ?? 0));
  return out;
}

// ---------------- writes ----------------

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
    .check({ key: openByStaffKey(args.staffId), versionstamp: null })
    .check({ key: entryByIdKey(id), versionstamp: null })
    .set(entryKey(args.restaurantId, id), entry)
    .set(entryByIdKey(id), { restaurantId: args.restaurantId })
    .set(openByStaffKey(args.staffId), { entryId: id, restaurantId: args.restaurantId })
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
    // stale pointer - cleanup best-effort
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

// ---------------- manual edit (owner/manager) ----------------

export type ManualEditResult =
  | { ok: true; entry: TimeEntry }
  | { ok: false; error: "not_found" | "invalid" | "conflict" };

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Manual edit of an existing entry (owner/manager).
 * - Can adjust clockInAt/clockOutAt (including setting clockOutAt null to reopen).
 * - Updates day indexes if the clockIn day changed.
 * - Keeps open pointer consistent:
 *    - if clockOutAt becomes null -> ensures open pointer exists for this staff, and that there isn't another open.
 *    - if clockOutAt becomes set -> removes open pointer if it points to this entry.
 */
export async function updateTimeEntryManual(args: {
  entryId: string;
  // optional edits:
  clockInAt?: number;
  clockOutAt?: number | null;

  // audit fields:
  updatedByUserId: string;
  updatedByRole: string; // "owner" / "manager"
  note?: string;
}): Promise<ManualEditResult> {
  const current = await getTimeEntry(args.entryId);
  if (!current) return { ok: false, error: "not_found" };

  const nextClockInAt = isFiniteNum(args.clockInAt) ? args.clockInAt : current.clockInAt;
  const nextClockOutAt =
    args.clockOutAt === null ? null :
    isFiniteNum(args.clockOutAt) ? args.clockOutAt :
    (current.clockOutAt ?? null);

  // Validate
  if (!isFiniteNum(nextClockInAt)) return { ok: false, error: "invalid" };
  if (nextClockOutAt !== null && !isFiniteNum(nextClockOutAt)) return { ok: false, error: "invalid" };
  if (nextClockOutAt !== null && nextClockOutAt < nextClockInAt) return { ok: false, error: "invalid" };

  const oldDay = ymdKeyUTC(current.clockInAt);
  const newDay = ymdKeyUTC(nextClockInAt);

  const next: TimeEntry = {
    ...current,
    clockInAt: nextClockInAt,
    clockOutAt: nextClockOutAt,
    updatedAt: now(),
    updatedByUserId: args.updatedByUserId,
    closedByUserId: nextClockOutAt ? args.updatedByUserId : current.closedByUserId,
    closedByRole: nextClockOutAt ? args.updatedByRole : current.closedByRole,
    source: current.source ?? "owner",
    note: typeof args.note === "string" ? args.note : current.note,
  };

  // Open pointer handling
  // If entry is now OPEN => need to ensure open pointer points to this entry and there isn't another open.
  // If entry is now CLOSED => remove open pointer if it points to this entry.
  const open = await kv.get<OpenIndex>(openByStaffKey(current.staffId));
  const openEntryId = open.value?.entryId ?? null;

  if (nextClockOutAt === null) {
    // want OPEN
    if (openEntryId && openEntryId !== current.id) {
      // another open exists -> conflict
      return { ok: false, error: "conflict" };
    }
  }

  const tx = kv.atomic();

  // Update main entry + byId index
  tx.set(entryKey(current.restaurantId, current.id), next)
    .set(entryByIdKey(current.id), { restaurantId: current.restaurantId });

  // If day changed, move indexes
  if (oldDay !== newDay) {
    tx.delete(byRestaurantDayKey(current.restaurantId, oldDay, current.id))
      .delete(byStaffDayKey(current.staffId, oldDay, current.id))
      .set(byRestaurantDayKey(current.restaurantId, newDay, current.id), true)
      .set(byStaffDayKey(current.staffId, newDay, current.id), true);
  } else {
    // ensure indexes exist (idempotent)
    tx.set(byRestaurantDayKey(current.restaurantId, oldDay, current.id), true)
      .set(byStaffDayKey(current.staffId, oldDay, current.id), true);
  }

  // Open pointer consistency
  if (nextClockOutAt === null) {
    // ensure open pointer points to this entry
    if (open.value) {
      // it exists already and should be this entry (checked above)
      // keep as-is (or set idempotently)
      tx.set(openByStaffKey(current.staffId), { entryId: current.id, restaurantId: current.restaurantId });
    } else {
      // create open pointer, but must ensure none exists
      tx.check({ key: openByStaffKey(current.staffId), versionstamp: null })
        .set(openByStaffKey(current.staffId), { entryId: current.id, restaurantId: current.restaurantId });
    }
  } else {
    // closing: if open pointer points to this entry -> delete it
    if (openEntryId === current.id) {
      tx.check({ key: openByStaffKey(current.staffId), versionstamp: open.versionstamp })
        .delete(openByStaffKey(current.staffId));
    }
  }

  const res = await tx.commit();
  if (!res.ok) return { ok: false, error: "conflict" };

  return { ok: true, entry: next };
}
