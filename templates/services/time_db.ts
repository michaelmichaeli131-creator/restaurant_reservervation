// src/services/time_db.ts
// --------------------------------------------------------
// Time tracking (Clock-in / Clock-out) via Deno KV
// - One open shift per staff (enforced via KV atomic check)
// - Index by restaurant+day and staff+day for fast calendar queries
// --------------------------------------------------------

import { kv } from "../database.ts";

// Keep in sync with your staff_db definitions (string unions).
export type TimeEntrySource = "staff" | "manager" | "owner";

export type TimeEntry = {
  id: string;
  restaurantId: string;
  staffId: string;
  userId: string;

  clockInAt: number;
  clockOutAt?: number;

  source: TimeEntrySource;
  editedBy?: { userId: string; role: string; at: number };
  note?: string;

  createdAt: number;
  updatedAt: number;
};

type KVKey = Deno.KvKey;

function uid(prefix = "te") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function dayKeyFromMs(ms: number, tz = "Asia/Jerusalem"): string {
  // YYYY-MM-DD in tz
  const d = new Date(ms);
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA => "YYYY-MM-DD"
  return dtf.format(d);
}

function kEntry(id: string): KVKey {
  return ["time_entry", id];
}
function kIdxRestaurantDay(restaurantId: string, day: string, entryId: string): KVKey {
  return ["time_by_restaurant_day", restaurantId, day, entryId];
}
function kIdxStaffDay(staffId: string, day: string, entryId: string): KVKey {
  return ["time_by_staff_day", staffId, day, entryId];
}
function kOpenByStaff(staffId: string): KVKey {
  return ["time_open_by_staff", staffId];
}

export async function getOpenEntryIdByStaff(staffId: string): Promise<string | null> {
  const r = await kv.get<string>(kOpenByStaff(staffId));
  return r.value ?? null;
}

export async function getTimeEntry(entryId: string): Promise<TimeEntry | null> {
  const r = await kv.get<TimeEntry>(kEntry(entryId));
  return r.value ?? null;
}

export async function createClockIn(params: {
  restaurantId: string;
  staffId: string;
  userId: string;
  nowMs?: number;
  tz?: string;
  source: TimeEntrySource;
}): Promise<{ ok: true; entry: TimeEntry } | { ok: false; error: "already_open"; openEntryId: string }> {
  const now = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const tz = params.tz || "Asia/Jerusalem";
  const day = dayKeyFromMs(now, tz);

  // Enforce one open entry per staff
  const openKey = kOpenByStaff(params.staffId);
  const open = await kv.get<string>(openKey);
  if (open.value) {
    return { ok: false, error: "already_open", openEntryId: open.value };
  }

  const id = uid("time");
  const entry: TimeEntry = {
    id,
    restaurantId: params.restaurantId,
    staffId: params.staffId,
    userId: params.userId,
    clockInAt: now,
    source: params.source,
    createdAt: now,
    updatedAt: now,
  };

  // Atomic: ensure still no open pointer, then set entry + indexes + open pointer.
  const atomic = kv.atomic()
    .check({ key: openKey, versionstamp: null })
    .set(kEntry(id), entry)
    .set(kIdxRestaurantDay(params.restaurantId, day, id), true)
    .set(kIdxStaffDay(params.staffId, day, id), true)
    .set(openKey, id);

  const res = await atomic.commit();
  if (!res.ok) {
    const again = await kv.get<string>(openKey);
    if (again.value) return { ok: false, error: "already_open", openEntryId: again.value };
    return { ok: false, error: "already_open", openEntryId: "unknown" };
  }

  return { ok: true, entry };
}

export async function clockOut(params: {
  staffId: string;
  userId: string;
  nowMs?: number;
  roleForAudit?: string;
}): Promise<
  | { ok: true; entry: TimeEntry }
  | { ok: false; error: "no_open" }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "already_closed"; entry: TimeEntry }
> {
  const now = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();

  const openKey = kOpenByStaff(params.staffId);
  const open = await kv.get<string>(openKey);
  const entryId = open.value;

  if (!entryId) return { ok: false, error: "no_open" };

  const entryKey = kEntry(entryId);
  const entryRes = await kv.get<TimeEntry>(entryKey);
  const entry = entryRes.value;
  if (!entry) {
    // stale pointer
    await kv.delete(openKey);
    return { ok: false, error: "not_found" };
  }

  if (typeof entry.clockOutAt === "number") {
    // already closed, cleanup pointer
    await kv.delete(openKey);
    return { ok: false, error: "already_closed", entry };
  }

  const updated: TimeEntry = {
    ...entry,
    clockOutAt: now,
    updatedAt: now,
    editedBy: { userId: params.userId, role: params.roleForAudit || "staff", at: now },
  };

  const atomic = kv.atomic()
    // ensure pointer still points to this entry
    .check(open)
    .set(entryKey, updated)
    .delete(openKey);

  const ok = await atomic.commit();
  if (!ok.ok) {
    // race: someone else closed. Read fresh.
    const fresh = await getTimeEntry(entryId);
    if (fresh && typeof fresh.clockOutAt === "number") {
      return { ok: true, entry: fresh };
    }
    return { ok: false, error: "no_open" };
  }

  return { ok: true, entry: updated };
}

export async function listEntriesByRestaurantDay(restaurantId: string, day: string): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for await (const row of kv.list<boolean>({ prefix: ["time_by_restaurant_day", restaurantId, day] })) {
    const entryId = row.key[row.key.length - 1] as string;
    const e = await getTimeEntry(entryId);
    if (e) out.push(e);
  }
  out.sort((a, b) => a.clockInAt - b.clockInAt);
  return out;
}

export async function listEntriesByStaffDay(staffId: string, day: string): Promise<TimeEntry[]> {
  const out: TimeEntry[] = [];
  for await (const row of kv.list<boolean>({ prefix: ["time_by_staff_day", staffId, day] })) {
    const entryId = row.key[row.key.length - 1] as string;
    const e = await getTimeEntry(entryId);
    if (e) out.push(e);
  }
  out.sort((a, b) => a.clockInAt - b.clockInAt);
  return out;
}

export function toDayKey(ms: number, tz = "Asia/Jerusalem") {
  return dayKeyFromMs(ms, tz);
}
