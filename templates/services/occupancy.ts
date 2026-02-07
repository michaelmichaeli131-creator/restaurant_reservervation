// /src/services/occupancy.ts
import type { HHMM } from "./timeline.ts";
import { addMinutes, toMinutes, rangesOverlap, slotRange } from "./timeline.ts";

export type ResStatus = "invited" | "approved" | "arrived" | "cancelled" | string;

export interface ReservationLike {
  id: string;
  date?: string;
  time?: HHMM;
  people?: number;
  tables?: number;
  status?: ResStatus;
  durationMinutes?: number;
}

export interface ComputeOccupancyInput {
  reservations: ReservationLike[];
  timeline: HHMM[];
  slotMinutes: number;
  capacityPeople: number;
  capacityTables: number;
  defaultDurationMinutes?: number;
  avgPeoplePerTable?: number;
  deriveTables?: (people: number, avgPeoplePerTable?: number) => number;
}

export interface SlotOccupancy {
  time: HHMM;
  people: number;
  tables: number;
  percentPeople: number;
  percentTables: number;
  percent: number;
  reservationIds: string[];
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function asInt(n: unknown, d = 0) { const v = Math.trunc(Number(n)); return Number.isFinite(v) ? v : d; }
function isCountable(status?: ResStatus) { return (status ?? "approved") !== "cancelled"; }

function effectiveTables(r: ReservationLike, avg: number, derive?: ComputeOccupancyInput["deriveTables"]) {
  if (asInt(r.tables, 0) > 0) return asInt(r.tables, 0);
  const p = Math.max(0, asInt(r.people, 0));
  return derive ? derive(p, avg) : Math.max(1, Math.ceil(p / Math.max(1, avg)));
}
function effectiveDuration(r: ReservationLike, fallback: number) {
  const d = asInt(r.durationMinutes, 0);
  return d > 0 ? d : Math.max(1, asInt(fallback, 120));
}

export function computeOccupancyForDay(input: ComputeOccupancyInput): SlotOccupancy[] {
  const {
    reservations, timeline, slotMinutes, capacityPeople, capacityTables,
    defaultDurationMinutes = 120, avgPeoplePerTable = 3, deriveTables,
  } = input;

  const capP = Math.max(1, asInt(capacityPeople, 1));
  const capT = Math.max(1, asInt(capacityTables, 1));
  const sMin = Math.max(1, asInt(slotMinutes, 15));

  const normalized = reservations
    .filter((r) => isCountable(r.status))
    .map((r) => {
      const start = (r.time ?? timeline[0] ?? "00:00") as HHMM;
      const dur = effectiveDuration(r, defaultDurationMinutes);
      const coverStart = start;
      const coverEnd = addMinutes(start, dur);
      return {
        id: String(r.id),
        people: Math.max(0, asInt(r.people, 0)),
        tables: Math.max(0, effectiveTables(r, avgPeoplePerTable, deriveTables)),
        coverStart, coverEnd,
      };
    });

  const out: SlotOccupancy[] = timeline.map((t) => {
    const { slotStart, slotEnd } = slotRange(t, sMin, sMin);
    let ppl = 0, tbl = 0; const ids: string[] = [];
    for (const r of normalized) {
      if (rangesOverlap(slotStart, slotEnd, r.coverStart, r.coverEnd)) {
        ppl += r.people; tbl += r.tables; ids.push(r.id);
      }
    }
    const pp = Math.round(100 * clamp01(ppl / capP));
    const pt = Math.round(100 * clamp01(tbl / capT));
    const perc = Math.max(pp, pt);
    return { time: t, people: ppl, tables: tbl, percentPeople: pp, percentTables: pt, percent: perc, reservationIds: ids };
  });

  return out;
}

export interface DaySummary {
  totalReservations: number;
  totalGuests: number;
  avgOccupancyPeople: number;
  avgOccupancyTables: number;
  peakSlot: HHMM | null;
  peakOccupancy: number;
  cancelled: number;
  noShow: number;
}

export function summarizeDay(occ: SlotOccupancy[], reservations: ReservationLike[]): DaySummary {
  const nonCancelled = reservations.filter((r) => isCountable(r.status));
  const cancelled = reservations.filter((r) => (r.status ?? "") === "cancelled").length;

  const totalReservations = nonCancelled.length;
  const totalGuests = nonCancelled.reduce((sum, r) => sum + Math.max(0, asInt(r.people, 0)), 0);

  let avgPeople = 0, avgTables = 0, peak = 0; let peakSlot: HHMM | null = null;
  if (occ.length > 0) {
    avgPeople = Math.round(occ.reduce((s, x) => s + x.percentPeople, 0) / occ.length);
    avgTables = Math.round(occ.reduce((s, x) => s + x.percentTables, 0) / occ.length);
    for (const x of occ) if (x.percent > peak) { peak = x.percent; peakSlot = x.time; }
  }

  // noShow (הערכה זהירה): לא מבטל/לא arrived והזמן עבר
  let noShow = 0;
  try {
    const now = new Date();
    const hhmmNow = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    for (const r of nonCancelled) {
      const st = (r.status ?? "").toLowerCase();
      const t = r.time as HHMM | undefined;
      if (!t) continue;
      if (toMinutes(t) + (r.durationMinutes ?? 120) <= toMinutes(hhmmNow) && st !== "arrived") noShow++;
    }
  } catch { noShow = 0; }

  return { totalReservations, totalGuests, avgOccupancyPeople: avgPeople, avgOccupancyTables: avgTables, peakSlot, peakOccupancy: peak, cancelled, noShow };
}
