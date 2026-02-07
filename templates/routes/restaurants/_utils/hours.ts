// src/routes/restaurants/_utils/hours.ts
import { listAvailableSlotsAround, type WeeklySchedule, type DayOfWeek } from "../../../database.ts";
import { debugLog } from "../../../lib/debug.ts";
import { normalizeTime } from "./datetime.ts";

export function toMinutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function hasScheduleForDate(weekly: WeeklySchedule | undefined | null, date: string): boolean {
  if (!weekly) return false;
  const d = new Date(date + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const dowNum = d.getDay();
  const long = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"] as const;
  const short = ["sun","mon","tue","wed","thu","fri","sat"] as const;

  const keys: Array<string | number> = [
    dowNum, String(dowNum),
    long[dowNum], short[dowNum],
    (long as readonly string[])[dowNum].toUpperCase(),
    (short as readonly string[])[dowNum].toUpperCase(),
  ];
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(weekly as any, k)) return true;
  return false;
}

export function getWindowsForDate(
  weekly: WeeklySchedule | undefined | null,
  date: string,
): Array<{ open: string; close: string }> {
  if (!weekly) return [];
  const d = new Date(date + "T00:00:00");
  if (isNaN(d.getTime())) return [];
  const dowNum = d.getDay();
  const long = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"] as const;
  const short = ["sun","mon","tue","wed","thu","fri","sat"] as const;

  const candidates: Array<string | number> = [
    dowNum, String(dowNum),
    long[dowNum], short[dowNum],
    (long as readonly string[])[dowNum].toUpperCase(),
    (short as readonly string[])[dowNum].toUpperCase(),
  ];

  let found = false;
  let raw: any = undefined;

  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(weekly as any, k)) {
      found = true;
      raw = (weekly as any)[k];
      break;
    }
  }

  debugLog("[hours] getWindowsForDate", {
    date, dowNum, hadWeekly: !!weekly,
    candidateHit: found,
    candidateType: found ? (Array.isArray(raw) ? "array" : typeof raw) : "none",
  });

  if (!found || raw == null) return [];
  return Array.isArray(raw) ? raw.filter(Boolean) : [raw];
}

export function withinAnyWindow(timeMin: number, windows: Array<{ open: string; close: string }>) {
  for (const w of windows) {
    let a = toMinutes(w.open);
    let b = toMinutes(w.close);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b <= a) b = 24 * 60 - 1;
    if (timeMin >= a && timeMin <= b) return true;
  }
  return false;
}

export function isWithinSchedule(weekly: WeeklySchedule | undefined | null, date: string, time: string) {
  const t = toMinutes(time);
  if (!Number.isFinite(t)) return false;
  const hasDay = hasScheduleForDate(weekly, date);
  const windows = getWindowsForDate(weekly, date);
  if (!hasDay) return true;
  if (windows.length === 0) return false;
  return withinAnyWindow(t, windows);
}

export async function suggestionsWithinSchedule(
  restaurantId: string,
  date: string,
  time: string,
  people: number,
  weekly: WeeklySchedule | undefined | null,
): Promise<string[]> {
  const around = await listAvailableSlotsAround(restaurantId, date, time, people, 120, 16);
  if (!around.length) return [];
  if (!hasScheduleForDate(weekly, date)) return around.slice(0, 8);
  const windows = getWindowsForDate(weekly, date);
  const ok = around.filter((t) => withinAnyWindow(toMinutes(t), windows));
  return ok.slice(0, 8);
}

/* ---------------- Owner hours parsing ---------------- */

export const DAY_NAME_TO_INDEX: Record<string, number> = {
  sunday: 0, sun: 0, "0": 0,
  monday: 1, mon: 1, "1": 1,
  tuesday: 2, tue: 2, "2": 2,
  wednesday: 3, wed: 3, "3": 3,
  thursday: 4, thu: 4, "4": 4,
  friday: 5, fri: 5, "5": 5,
  saturday: 6, sat: 6, "6": 6,
  "א": 0, "א׳": 0, "ב": 1, "ב׳": 1, "ג": 2, "ג׳": 2, "ד": 3, "ד׳": 3, "ה": 4, "ה׳": 4, "ו": 5, "ו׳": 5, "ש": 6, "ש׳": 6,
};

type WeeklyHoursMap = { [day: string]: { open: string; close: string } | null };

export function extractHoursFromFlatPayload(payload: Record<string, unknown>): WeeklyHoursMap | null {
  const out: WeeklyHoursMap = { "0": null, "1": null, "2": null, "3": null, "4": null, "5": null, "6": null };
  const entries = Object.entries(payload);
  let hit = false;

  for (const [rawKey, value] of entries) {
    const key = String(rawKey);
    let m = key.match(/^hours\[(.+?)\]\[(open|close)\]$/i);
    if (!m) m = key.match(/^hours[.\-](.+?)[.\-](open|close)$/i);
    if (!m) m = key.match(/^hours[_\-](.+?)[_\-](open|close)$/i);
    if (!m) continue;

    hit = true;
    const dayToken = m[1].toString().toLowerCase();
    const field = m[2].toLowerCase();

    let idx: number | undefined;
    if (dayToken in DAY_NAME_TO_INDEX) idx = DAY_NAME_TO_INDEX[dayToken];
    else if (/^[0-6]$/.test(dayToken)) idx = parseInt(dayToken, 10);
    if (idx === undefined) continue;

    const prev = (out as any)[idx] ?? { open: "", close: "" };
    const val = normalizeTime(value);
    (out as any)[idx] = {
      open: field === "open" ? val : (prev as any).open,
      close: field === "close" ? val : (prev as any).close,
    };
  }

  return hit ? out : null;
}

export function ensureWeeklyHours(input: unknown, payloadForFlat?: Record<string, unknown>): WeeklyHoursMap {
  if (payloadForFlat) {
    const flat = extractHoursFromFlatPayload(payloadForFlat);
    if (flat) return flat;
  }

  let obj: any = input ?? {};
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { obj = {}; }
  }
  const out: WeeklyHoursMap = {};
  for (let i = 0; i < 7; i++) (out as any)[i] = null;

  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    let idx: number | undefined;
    if (key in DAY_NAME_TO_INDEX) idx = DAY_NAME_TO_INDEX[key];
    else if (/^[0-6]$/.test(key)) idx = parseInt(key, 10);
    if (idx === undefined) continue;

    if (v == null || v === "" || v === false) { (out as any)[idx] = null; continue; }

    if (typeof v === "object") {
      const open = normalizeTime((v as any).open);
      const close = normalizeTime((v as any).close);
      (out as any)[idx] = (open && close) ? { open, close } : null;
      continue;
    }

    if (typeof v === "string") {
      const m = /^(\S+)\s*-\s*(\S+)$/.exec(v);
      if (m) {
        const open = normalizeTime(m[1]);
        const close = normalizeTime(m[2]);
        (out as any)[idx] = (open && close) ? { open, close } : null;
      } else {
        (out as any)[idx] = null;
      }
    }
  }
  return out;
}
