// src/services/timeclock_db.ts
// --------------------------------------------------------
// TimeClock DB (KV) – נוכחות + שכר
// - Staff check-in/out (כניסה/יציאה)
// - רשומה יומית פר עובד: (restaurantId, staffId, ymd)
// - אינדקס חודשי למסעדה בשביל לוח שנה/דוחות
// - עריכה ידנית ע"י בעל המסעדה (edit)
// - שכר לשעה לכל עובד (hourlyRate) + חישוב שכר חודשי
// --------------------------------------------------------

import { kv } from "../database.ts";

const now = () => Date.now();

/** YYYY-MM-DD לפי זמן מקומי (כמו ה-UI שלך) */
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

/** Epoch של תחילת יום מקומי ל-ymd (לשימוש עתידי אם תרצה) */
function startOfDayLocalMs(ymd: string): number {
  // Important: זה תואם ל-template שלך שעושה new Date(ymd+'T00:00:00')
  const d = new Date(`${ymd}T00:00:00`);
  return d.getTime();
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

/** חישוב שכר חודשי */
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
  return ["timeclock", restaurantId, staffId, ymd] as const;
}

// אינדקס חודשי למסעדה (לרשומות של חודש מסוים)
function idxRestaurantMonthKey(
  restaurantId: string,
  month: string,
  staffId: string,
  ymd: string,
) {
  return ["timeclock_by_restaurant_month", restaurantId, month, staffId, ymd] as const;
}

// "פתוח" פר עובד – מוודא שלא יהיו 2 כניסות פתוחות במקביל
// value: { restaurantId, ymd }
function openKey(staffId: string) {
  return ["timeclock_open", staffId] as const;
}

type OpenPtr = { restaurantId: string; ymd: string };

// שכר לשעה פר עובד (staffId) – לשימוש עתידי אם תרצה
function hourlyRateKey(staffId: string) {
  return ["staff_hourly_rate", staffId] as const;
}

/* ─────────────── Helpers ─────────────── */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function minsWorkedInternal(r: TimeClockRow): number {
  if (!r.checkInAt || !r.checkOutAt) return 0;
  return Math.max(0, Math.floor((r.checkOutAt - r.checkInAt) / 60000));
}

/** export לחישוב דקות – ה-router וה-template משתמשים בזה */
export function minutesWorked(r: TimeClockRow): number {
  return minsWorkedInternal(r);
}

/* ─────────────── Reads ─────────────── */

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

/**
 * מחזיר את כל הרשומות של חודש למסעדה.
 * חוזר כ-Array של TimeClockRow (כמו rows בטמפלייט).
 */
export async function listMonthRows(
  restaurantId: string,
  month: string, // YYYY-MM
): Promise<TimeClockRow[]> {
  const out: TimeClockRow[] = [];

  for await (
    const row of kv.list<boolean>({
      prefix: ["timeclock_by_restaurant_month", restaurantId, month],
    })
  ) {
    // key shape: ["timeclock_by_restaurant_month", restaurantId, month, staffId, ymd]
    const staffId = String(row.key[3] ?? "");
    const ymd = String(row.key[4] ?? "");
    if (!staffId || !ymd) continue;

    const full = await getRow(restaurantId, staffId, ymd);
    if (full) out.push(full);
  }

  // סדר: לפי תאריך ואז לפי staffId (יציב)
  out.sort((a, b) => {
    if (a.ymd === b.ymd) return String(a.staffId).localeCompare(String(b.staffId));
    return String(a.ymd).localeCompare(String(b.ymd));
  });

  return out;
}

/** עטיפה שמתאימה ל־routes/timeclock.ts */
export async function listMonthForRestaurant(
  restaurantId: string,
  month: string,
): Promise<TimeClockRow[]> {
  return await listMonthRows(restaurantId, month);
}

/* ─────────────── Hourly rate (אופציונלי) ─────────────── */

export async function getHourlyRate(staffId: string): Promise<number | null> {
  const res = await kv.get<number>(hourlyRateKey(staffId));
  return typeof res.value === "number" ? res.value : null;
}

export async function setHourlyRate(staffId: string, hourlyRate: number): Promise<void> {
  const n = Number(hourlyRate);
  if (!Number.isFinite(n) || n < 0) {
    const e: any = new Error("Invalid hourlyRate");
    e.code = "invalid_hourly_rate";
    throw e;
  }
  await kv.set(hourlyRateKey(staffId), n);
}

/* ─────────────── Staff actions: check-in/out ─────────────── */

/**
 * כניסה עכשיו
 * enforce: רק כניסה פתוחה אחת פר staffId (באמצעות open pointer)
 *
 * חתימה מותאמת ל-router:
 *   checkInNow(restaurantId, staffId)
 */
export async function checkInNow(argsRestaurantId: string, argsStaffId: string): Promise<
  | { ok: true; row: TimeClockRow }
  | { ok: false; error: "already_open"; open: OpenPtr; row?: TimeClockRow | null }
> {
  const restaurantId = argsRestaurantId;
  const staffId = argsStaffId;

  const ts = now();
  const ymd = ymdKeyLocal(ts);
  const month = monthFromYmd(ymd);

  // בדוק open pointer קודם
  const open = await kv.get<OpenPtr>(openKey(staffId));
  if (open.value?.ymd) {
    // כבר פתוח
    const row = await getRow(open.value.restaurantId, staffId, open.value.ymd);
    return { ok: false, error: "already_open", open: open.value, row };
  }

  const existing = await getRow(restaurantId, staffId, ymd);

  // אם כבר יש רשומה של היום עם checkInAt אבל בלי checkOutAt -> זה בעצם פתוח
  if (existing?.checkInAt && !existing?.checkOutAt) {
    // ננסה לייצב open pointer (best-effort) כדי שהמערכת תהיה עקבית
    const ptr: OpenPtr = { restaurantId, ymd };
    await kv.set(openKey(staffId), ptr);
    return {
      ok: false,
      error: "already_open",
      open: ptr,
      row: existing,
    };
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
    createdByUserId: existing?.createdByUserId ?? null,
    updatedByUserId: null,
  };

  // Atomic:
  // 1) ensure open pointer not exists
  // 2) upsert row
  // 3) set open pointer
  // 4) set monthly index
  const tx = kv.atomic()
    .check({ key: openKey(staffId), versionstamp: null })
    .set(rowKey(restaurantId, staffId, ymd), row)
    .set(openKey(staffId), { restaurantId, ymd })
    .set(idxRestaurantMonthKey(restaurantId, month, staffId, ymd), true);

  const res = await tx.commit();
  if (!res.ok) {
    // רייס: מישהו פתח open pointer
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
 * יציאה עכשיו
 * מחייב open pointer, מעדכן checkOutAt ומוחק open pointer
 *
 * חתימה מותאמת ל-router:
 *   checkOutNow(restaurantId, staffId)  // restaurantId לא באמת נחוץ, אבל מתקבל
 */
export async function checkOutNow(
  _restaurantId: string,
  staffId: string,
): Promise<
  | { ok: true; row: TimeClockRow }
  | { ok: false; error: "no_open" | "not_found" | "already_closed" | "conflict"; row?: TimeClockRow | null }
> {
  const ts = now();

  const open = await kv.get<OpenPtr>(openKey(staffId));
  if (!open.value?.ymd || !open.value?.restaurantId) return { ok: false, error: "no_open" };

  const restaurantId = open.value.restaurantId;
  const ymd = open.value.ymd;

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
    // אין לנו כרגע userId של העורך (router לא מעביר) – נשאיר כמות שהוא
    updatedByUserId: current.updatedByUserId ?? null,
  };

  const tx = kv.atomic()
    .check({ key: openKey(staffId), versionstamp: open.versionstamp })
    .set(rowKey(restaurantId, staffId, ymd), next)
    .delete(openKey(staffId));

  const res = await tx.commit();
  if (!res.ok) return { ok: false, error: "conflict" };

  return { ok: true, row: next };
}

/* ─────────────── Owner/Manager manual edit ─────────────── */

/**
 * עריכה ידנית לרשומה יומית.
 * מאפשר:
 * - לקבוע checkInAt/checkOutAt (number או null כדי לאפס)
 * - note
 * - יוצר רשומה גם אם לא קיימת עדיין
 * - אם אחרי העריכה הרשומה פתוחה (יש checkInAt ואין checkOutAt) – נעדכן open pointer
 *   אבל אם כבר יש open pointer ליום אחר – נחזיר open_conflict
 */
export async function upsertManualEntry(args: {
  restaurantId: string;
  staffId: string;
  ymd: string;
  checkInAt?: number | null;
  checkOutAt?: number | null;
  note?: string | null;
  actorUserId: string;
  actorRole: TimeClockSource | string;
}): Promise<
  | { ok: true; row: TimeClockRow }
  | { ok: false; error: "open_conflict"; open: OpenPtr }
> {
  const ymd = String(args.ymd || "").trim();
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const e: any = new Error("Invalid ymd");
    e.code = "invalid_ymd";
    throw e;
  }

  const month = monthFromYmd(ymd);
  const ts = now();

  const current = await getRow(args.restaurantId, args.staffId, ymd);

  const next: TimeClockRow = {
    restaurantId: args.restaurantId,
    staffId: args.staffId,
    userId: current?.userId ?? null,
    ymd,
    checkInAt: args.checkInAt === undefined ? (current?.checkInAt ?? null) : args.checkInAt,
    checkOutAt: args.checkOutAt === undefined ? (current?.checkOutAt ?? null) : args.checkOutAt,
    note: args.note === undefined ? (current?.note ?? null) : args.note,
    source: current?.source ?? "owner",
    createdAt: current?.createdAt ?? ts,
    updatedAt: ts,
    createdByUserId: current?.createdByUserId ?? args.actorUserId,
    updatedByUserId: args.actorUserId,
  };

  // לוגיקה של open pointer לפי מצב הרשומה אחרי העריכה:
  const wantsOpen = Boolean(next.checkInAt) && !next.checkOutAt;

  const open = await kv.get<OpenPtr>(openKey(args.staffId));
  const openVal = open.value ?? null;

  if (wantsOpen) {
    // אם כבר פתוח ליום אחר – קונפליקט
    if (openVal && (openVal.ymd !== ymd || openVal.restaurantId !== args.restaurantId)) {
      return { ok: false, error: "open_conflict", open: openVal };
    }
  }

  // Atomic commit:
  // - כתיבת הרשומה
  // - כתיבת אינדקס חודשי
  // - ניהול open pointer בהתאם
  const tx = kv.atomic()
    .set(rowKey(args.restaurantId, args.staffId, ymd), next)
    .set(idxRestaurantMonthKey(args.restaurantId, month, args.staffId, ymd), true);

  if (wantsOpen) {
    // אם אין pointer – ניצור. אם יש ונכון – נעדכן אותו (לא חובה אבל טוב לעקביות)
    if (openVal) {
      tx.set(openKey(args.staffId), { restaurantId: args.restaurantId, ymd });
    } else {
      tx.check({ key: openKey(args.staffId), versionstamp: null })
        .set(openKey(args.staffId), { restaurantId: args.restaurantId, ymd });
    }
  } else {
    // אם לא פתוח – נמחק pointer רק אם הוא מצביע על אותו יום/מסעדה
    if (openVal && openVal.ymd === ymd && openVal.restaurantId === args.restaurantId) {
      tx.delete(openKey(args.staffId));
    }
  }

  const res = await tx.commit();
  if (!res.ok) throw new Error("upsertManualEntry atomic commit failed");

  return { ok: true, row: next };
}

/**
 * עטיפה ל-router:
 *   upsertManual(restaurantId, staffId, ymd, patch, actorUserId)
 */
export async function upsertManual(
  restaurantId: string,
  staffId: string,
  ymd: string,
  patch: { checkInAt?: number | null; checkOutAt?: number | null; note?: string | null },
  actorUserId: string,
): Promise<TimeClockRow> {
  const res = await upsertManualEntry({
    restaurantId,
    staffId,
    ymd,
    checkInAt: patch.checkInAt,
    checkOutAt: patch.checkOutAt,
    note: patch.note,
    actorUserId,
    actorRole: "owner",
  });

  if (res.ok) return res.row;

  // במקרה של open_conflict – נחזיר את הרשומה הקיימת (אם יש)
  if (res.error === "open_conflict") {
    const existing = await getRow(restaurantId, staffId, ymd);
    if (existing) return existing;
    throw new Error("open_conflict and no existing row");
  }

  throw new Error("Unknown upsertManualEntry error");
}

/* ─────────────── Payroll ─────────────── */

/**
 * חישוב שכר חודשי על בסיס rows של חודש:
 * - hourlyRate מגיע מ־StaffMember (staffById) – כמו שה־router שלך כבר עושה
 * - אם אין hourlyRate -> 0
 * - staffName מגיע מ־StaffMember
 */
export function computeMonthlyPayroll(
  rows: TimeClockRow[],
  staffById: Map<
    string,
    { id: string; firstName?: string; lastName?: string; email?: string; username?: string; hourlyRate?: number }
  >,
): PayrollRow[] {
  const minsByStaff = new Map<string, number>();

  for (const r of rows) {
    const m = minsWorkedInternal(r);
    if (!m) continue;
    minsByStaff.set(r.staffId, (minsByStaff.get(r.staffId) ?? 0) + m);
  }

  const out: PayrollRow[] = [];

  for (const [staffId, totalMinutes] of minsByStaff.entries()) {
    const staff = staffById.get(staffId);
    const hourlyRate = staff && typeof staff.hourlyRate === "number"
      ? Number(staff.hourlyRate)
      : 0;
    const totalHours = round2(totalMinutes / 60);
    const gross = round2(totalHours * hourlyRate);

    const staffName =
      staff
        ? `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() ||
          staff.username ||
          staff.email ||
          staffId
        : staffId;

    out.push({
      staffId,
      staffName,
      hourlyRate,
      totalMinutes,
      totalHours,
      gross,
    });
  }

  // מיון: הכי גבוה למעלה
  out.sort((a, b) => (b.gross - a.gross) || a.staffName.localeCompare(b.staffName, "he"));

  return out;
}

/**
 * אופציונלי: גרסה אסינכרונית שמבוססת על getHourlyRate מ-KV בלבד,
 * אם תרצה לשלב בעתיד:
 */
export async function computePayrollForMonth(args: {
  restaurantId: string;
  month: string; // YYYY-MM
  staffList: Array<{ id: string; firstName?: string; lastName?: string; email?: string; username?: string }>;
  rows?: TimeClockRow[]; // אפשר להעביר כדי לחסוך קריאה כפולה
}): Promise<PayrollRow[]> {
  const rows = args.rows ?? (await listMonthRows(args.restaurantId, args.month));

  const staffById = new Map<string, { id: string; name: string }>();
  for (const s of args.staffList || []) {
    const name = `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.id;
    staffById.set(s.id, { id: s.id, name });
  }

  const minsByStaff = new Map<string, number>();
  for (const r of rows) {
    const m = minsWorkedInternal(r);
    if (!m) continue;
    minsByStaff.set(r.staffId, (minsByStaff.get(r.staffId) ?? 0) + m);
  }

  const out: PayrollRow[] = [];

  for (const [staffId, totalMinutes] of minsByStaff.entries()) {
    const hr = (await getHourlyRate(staffId)) ?? 0;
    const totalHours = round2(totalMinutes / 60);
    const gross = round2(totalHours * hr);

    const staffName = staffById.get(staffId)?.name ?? staffId;

    out.push({
      staffId,
      staffName,
      hourlyRate: hr,
      totalMinutes,
      totalHours,
      gross,
    });
  }

  out.sort((a, b) => (b.gross - a.gross) || a.staffName.localeCompare(b.staffName, "he"));

  return out;
}
