// src/services/timeclock_db.ts
// --------------------------------------------------------
// TimeClock DB (KV) – נוכחות + שכר (פתרון B)
// - Staff check-in/out (כניסה/יציאה) לפי staffId
// - רשומה יומית פר עובד: (restaurantId, staffId, ymd)
// - אינדקס חודשי למסעדה בשביל לוח שנה/דוחות
// - עריכה ידנית ע"י בעל המסעדה (upsertManual)
// - חישוב שכר חודשי – hourlyRate מגיע מ-StaffMember (staff_db), לא מכאן
// --------------------------------------------------------

import { kv } from "../database.ts";

const now = () => Date.now();

/** YYYY-MM-DD לפי זמן מקומי (כמו ב־UI) */
export function ymdKeyLocal(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** YYYY-MM מתוך YYYY-MM-DD */
function monthFromYmd(ymd: string): string {
  return String(ymd || "").slice(0, 7); // "YYYY-MM"
}

/* ─────────────── Types ─────────────── */

export type TimeClockSource = "staff" | "owner" | "manager";

export type TimeClockRow = {
  restaurantId: string;
  staffId: string;
  userId?: string | null;

  ymd: string; // YYYY-MM-DD

  checkInAt?: number | null;
  checkOutAt?: number | null;

  note?: string | null;

  source?: TimeClockSource;

  createdAt: number;
  updatedAt?: number;

  createdByUserId?: string;
  updatedByUserId?: string;
};

export type PayrollRow = {
  staffId: string;
  staffName: string;
  hourlyRate: number; // NIS/hour
  totalMinutes: number;
  totalHours: number; // עגול ל-2 ספרות
  gross: number; // עגול ל-2 ספרות
};

/* ─────────────── KV keys ─────────────── */

// הרשומה היומית
function rowKey(restaurantId: string, staffId: string, ymd: string) {
  const rid = String(restaurantId ?? "").trim();
  const sid = String(staffId ?? "").trim();
  const day = String(ymd ?? "").trim();
  return ["timeclock_row", rid, sid, day] as const;
}

// אינדקס חודשי למסעדה (לרשומות של חודש מסוים)
function idxRestaurantMonthKey(restaurantId: string, month: string, ymd: string, staffId: string) {
  const rid = String(restaurantId ?? "").trim();
  const m = String(month ?? "").trim();
  const day = String(ymd ?? "").trim();
  const sid = String(staffId ?? "").trim();
  return ["timeclock_by_restaurant_month", rid, m, day, sid] as const;
}

// "פתוח" פר עובד – מוודא שלא יהיו 2 כניסות פתוחות במקביל
// value: { restaurantId, ymd }
function openKey(staffId: string | number) {
  const sid = String(staffId ?? "").trim();
  return ["timeclock_open", sid] as const;
}

type OpenPtr = { restaurantId: string; ymd: string };

/* ─────────────── Helpers ─────────────── */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function minutesWorked(r: TimeClockRow): number {
  if (!r.checkInAt || !r.checkOutAt) return 0;
  return Math.max(0, Math.floor((r.checkOutAt - r.checkInAt) / 60000));
}

/* ─────────────── Low-level reads ─────────────── */

export async function getRow(
  restaurantId: string,
  staffId: string,
  ymd: string,
): Promise<TimeClockRow | null> {
  const res = await kv.get<TimeClockRow>(rowKey(restaurantId, staffId, ymd));
  return res.value ?? null;
}

export async function getOpenForStaff(staffId: string): Promise<OpenPtr | null> {
  const res = await kv.get<OpenPtr>(openKey(staffId));
  return res.value ?? null;
}

/* ─────────────── Staff actions: check-in/out ─────────────── */

/**
 * כניסה עכשיו (Staff)
 * נחתך ל־API: checkInNow(restaurantId, staffId)
 * - יוצר/מעדכן רשומה ליום הנוכחי (ymd) לפי הזמן המקומי
 * - מוודא שיש רק רשומה פתוחה אחת (open pointer) לעובד
 */
export async function checkInNow(
  rawRestaurantId: string,
  rawStaffId: string,
): Promise<
  | { ok: true; row: TimeClockRow }
  | { ok: false; error: "already_open"; open: OpenPtr; row?: TimeClockRow | null }
> {
  const restaurantId = String(rawRestaurantId ?? "").trim();
  const staffId = String(rawStaffId ?? "").trim();

  if (!restaurantId || !staffId) {
    throw new Error("checkInNow: missing restaurantId or staffId");
  }

  const ts = now();
  const ymd = ymdKeyLocal(ts);
  const month = monthFromYmd(ymd);

  // בדוק open pointer קודם
  const openRes = await kv.get<OpenPtr>(openKey(staffId));
  const open = openRes.value;
  if (open?.ymd) {
    const row = await getRow(open.restaurantId, staffId, open.ymd);
    return { ok: false, error: "already_open", open, row };
  }

  const existing = await getRow(restaurantId, staffId, ymd);

  // אם כבר יש רשומה של היום עם checkInAt אבל בלי checkOutAt -> זה בעצם פתוח
  if (existing?.checkInAt && !existing?.checkOutAt) {
    // ננסה לייצב open pointer (best-effort)
    const ptr: OpenPtr = { restaurantId, ymd };
    await kv.set(openKey(staffId), ptr);
    return { ok: false, error: "already_open", open: ptr, row: existing };
  }

  const row: TimeClockRow = {
    restaurantId,
    staffId,
    userId: existing?.userId ?? null,
    ymd,
    checkInAt: ts,
    checkOutAt: null,
    note: existing?.note ?? null,
    source: "staff",
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
    createdByUserId: existing?.createdByUserId ?? staffId,
    updatedByUserId: staffId,
  };

  // Atomic: אין pointer פתוח + כתיבת הרשומה + open pointer + אינדקס חודשי
  const tx = kv.atomic()
    .check({ key: openKey(staffId), versionstamp: null })
    .set(rowKey(restaurantId, staffId, ymd), row)
    .set(openKey(staffId), { restaurantId, ymd })
    .set(idxRestaurantMonthKey(restaurantId, month, ymd, staffId), true);

  const res = await tx.commit();
  if (!res.ok) {
    // רייס: מישהו פתח pointer בינתיים
    const open2 = await kv.get<OpenPtr>(openKey(staffId));
    if (open2.value?.ymd) {
      const row2 = await getRow(open2.value.restaurantId, staffId, open2.value.ymd);
      return { ok: false, error: "already_open", open: open2.value, row: row2 };
    }
    throw new Error("checkInNow atomic commit failed");
  }

  return { ok: true, row };
}

/**
 * יציאה עכשיו (Staff)
 * נחתך ל־API: checkOutNow(restaurantId, staffId)
 * - מתבסס על open pointer כדי לדעת מאיזו מסעדה/יום לסגור
 */
export async function checkOutNow(
  _rawRestaurantId: string, // לא באמת משתמשים בו – הולכים לפי ה-open pointer
  rawStaffId: string,
): Promise<
  | { ok: true; row: TimeClockRow }
  | { ok: false; error: "no_open" | "not_found" | "already_closed" | "conflict"; row?: TimeClockRow | null }
> {
  const staffId = String(rawStaffId ?? "").trim();
  if (!staffId) {
    throw new Error("checkOutNow: missing staffId");
  }

  const ts = now();

  const openRes = await kv.get<OpenPtr>(openKey(staffId));
  const open = openRes.value;
  if (!open?.ymd || !open?.restaurantId) return { ok: false, error: "no_open" };

  const restaurantId = open.restaurantId;
  const ymd = open.ymd;

  const currentRes = await kv.get<TimeClockRow>(rowKey(restaurantId, staffId, ymd));
  const current = currentRes.value;
  if (!current) {
    // pointer stale
    await kv.delete(openKey(staffId));
    return { ok: false, error: "not_found" };
  }

  if (current.checkOutAt) {
    // כבר סגור - ננקה pointer
    await kv.delete(openKey(staffId));
    return { ok: false, error: "already_closed", row: current };
  }

  const next: TimeClockRow = {
    ...current,
    checkOutAt: ts,
    updatedAt: ts,
    updatedByUserId: staffId,
  };

  const tx = kv.atomic()
    .check({ key: openKey(staffId), versionstamp: openRes.versionstamp })
    .set(rowKey(restaurantId, staffId, ymd), next)
    .delete(openKey(staffId));

  const res = await tx.commit();
  if (!res.ok) return { ok: false, error: "conflict" };

  return { ok: true, row: next };
}

/* ─────────────── Owner/Manager manual edit ─────────────── */

/**
 * upsertManual – משמש את /owner/timeclock/edit
 *
 * Args:
 *  - restaurantId, staffId, ymd: מזהי הרשומה
 *  - patch: { checkInAt?: number|null|undefined, checkOutAt?: number|null|undefined, note?: string|null|undefined }
 *      undefined -> השאר כמו שהיה
 *      null      -> אפס את השדה
 *  - actorUserId: מי ערך (owner/manager)
 *
 * לוגיקה:
 *  - יוצר רשומה אם אין
 *  - מעדכן אינדקס חודשי
 *  - מנהל open pointer בהתאם:
 *      * אם אחרי העריכה יש checkInAt ואין checkOutAt → pointer פתוח
 *      * אחרת → אם pointer מצביע על אותה רשומה → נמחק אותו
 */
export async function upsertManual(
  rawRestaurantId: string,
  rawStaffId: string,
  rawYmd: string,
  patch: { checkInAt?: number | null; checkOutAt?: number | null; note?: string | null },
  actorUserId: string,
): Promise<TimeClockRow> {
  const restaurantId = String(rawRestaurantId ?? "").trim();
  const staffId = String(rawStaffId ?? "").trim();
  const ymd = String(rawYmd ?? "").trim();

  if (!restaurantId || !staffId || !ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error("upsertManual: invalid restaurantId/staffId/ymd");
  }

  const ts = now();
  const month = monthFromYmd(ymd);

  const current = await getRow(restaurantId, staffId, ymd);

  const next: TimeClockRow = {
    restaurantId,
    staffId,
    userId: current?.userId ?? null,
    ymd,
    checkInAt: patch.checkInAt === undefined ? (current?.checkInAt ?? null) : patch.checkInAt,
    checkOutAt: patch.checkOutAt === undefined ? (current?.checkOutAt ?? null) : patch.checkOutAt,
    note: patch.note === undefined ? (current?.note ?? null) : patch.note,
    source: current?.source ?? "owner",
    createdAt: current?.createdAt ?? ts,
    updatedAt: ts,
    createdByUserId: current?.createdByUserId ?? actorUserId,
    updatedByUserId: actorUserId,
  };

  const wantsOpen = Boolean(next.checkInAt) && !next.checkOutAt;

  const openRes = await kv.get<OpenPtr>(openKey(staffId));
  const open = openRes.value ?? null;

  const tx = kv.atomic()
    .set(rowKey(restaurantId, staffId, ymd), next)
    .set(idxRestaurantMonthKey(restaurantId, month, ymd, staffId), true);

  if (wantsOpen) {
    // פשוט נעדכן/ניצור pointer ליום הזה
    tx.set(openKey(staffId), { restaurantId, ymd });
  } else {
    // אם pointer מצביע על אותה רשומה → נמחק אותו
    if (open && open.restaurantId === restaurantId && open.ymd === ymd) {
      tx.delete(openKey(staffId));
    }
  }

  const res = await tx.commit();
  if (!res.ok) throw new Error("upsertManual atomic commit failed");

  return next;
}

/* ─────────────── Month listing ─────────────── */

/**
 * מחזיר את כל הרשומות של חודש למסעדה.
 * משמש את /owner/timeclock (HTML + API)
 */
export async function listMonthForRestaurant(
  rawRestaurantId: string,
  rawMonth: string, // YYYY-MM
): Promise<TimeClockRow[]> {
  const restaurantId = String(rawRestaurantId ?? "").trim();
  const month = String(rawMonth ?? "").trim();

  const out: TimeClockRow[] = [];

  for await (
    const row of kv.list<boolean>({
      prefix: ["timeclock_by_restaurant_month", restaurantId, month],
    })
  ) {
    // key shape: ["timeclock_by_restaurant_month", rid, month, ymd, staffId]
    const ymd = String(row.key[3] ?? "");
    const staffId = String(row.key[4] ?? "");
    if (!staffId || !ymd) continue;

    const full = await getRow(restaurantId, staffId, ymd);
    if (full) out.push(full);
  }

  // סדר: לפי תאריך ואז לפי staffId
  out.sort((a, b) => {
    if (a.ymd === b.ymd) return String(a.staffId).localeCompare(String(b.staffId));
    return String(a.ymd).localeCompare(String(b.ymd));
  });

  return out;
}

/* ─────────────── Payroll ─────────────── */

/**
 * חישוב שכר חודשי על בסיס rows + map של staff:
 *  - hourlyRate מגיע מ־StaffMember (שנשלח מה־route)
 *  - staffName מגיע firstName/lastName מה־StaffMember
 *
 * signature תואם ל־owner/timeclock.ts:
 *   const staffById = new Map(staffList.map((s) => [s.id, s]));
 *   const payroll = computeMonthlyPayroll(rows, staffById);
 */
export function computeMonthlyPayroll(
  rows: TimeClockRow[],
  staffById: Map<
    string,
    { id: string; firstName?: string | null; lastName?: string | null; hourlyRate?: number | null }
  >,
): PayrollRow[] {
  const minsByStaff = new Map<string, number>();

  for (const r of rows || []) {
    const m = minutesWorked(r);
    if (!m) continue;
    minsByStaff.set(r.staffId, (minsByStaff.get(r.staffId) ?? 0) + m);
  }

  const out: PayrollRow[] = [];

  for (const [staffId, totalMinutes] of minsByStaff.entries()) {
    const staff = staffById.get(staffId);
    const hr = typeof staff?.hourlyRate === "number" ? staff.hourlyRate : 0;
    const name = `${staff?.firstName ?? ""} ${staff?.lastName ?? ""}`.trim() || staffId;

    const totalHours = round2(totalMinutes / 60);
    const gross = round2(totalHours * hr);

    out.push({
      staffId,
      staffName: name,
      hourlyRate: hr,
      totalMinutes,
      totalHours,
      gross,
    });
  }

  // מיון: ברוטו מהגבוה לנמוך, ואז לפי שם
  out.sort((a, b) => (b.gross - a.gross) || a.staffName.localeCompare(b.staffName));

  return out;
}
