// /src/services/timeline.ts
export type HHMM = `${number}${number}:${number}${number}`;

export interface OpenWindow { start: HHMM; end: HHMM; }

/** "HH:MM" -> minutes since midnight */
export function toMinutes(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return h * 60 + mi;
}
export function toHHMM(totalMinutes: number): HHMM {
  let m = Math.floor(totalMinutes);
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mi = m % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(mi)}` as HHMM;
}
export function addMinutes(hhmm: string, delta: number): HHMM {
  const m = toMinutes(hhmm);
  if (Number.isNaN(m)) return hhmm as HHMM;
  return toHHMM(m + delta);
}
export function floorToGrid(hhmm: string, slotMinutes: number): HHMM {
  const m = toMinutes(hhmm);
  if (Number.isNaN(m)) return hhmm as HHMM;
  const aligned = Math.floor(m / slotMinutes) * slotMinutes;
  return toHHMM(aligned);
}
export function lt(a: HHMM, b: HHMM): boolean { return toMinutes(a) < toMinutes(b); }

/** Build day's slots list from open windows (supports crossing midnight) */
export function buildDayTimeline(openWindows: OpenWindow[] = [], slotMinutes = 15): HHMM[] {
  const s = Math.max(1, Math.floor(slotMinutes));
  const times: HHMM[] = [];
  for (const win of openWindows) {
    const start = floorToGrid(win.start, s);
    const end = win.end as HHMM;
    if (!lt(end, start)) {
      for (let t = toMinutes(start); t < toMinutes(end); t += s) times.push(toHHMM(t));
    } else {
      for (let t = toMinutes(start); t < 1440; t += s) times.push(toHHMM(t));
      for (let t = 0; t < toMinutes(end); t += s) times.push(toHHMM(t));
    }
  }
  const uniq = Array.from(new Set(times));
  uniq.sort((a, b) => toMinutes(a) - toMinutes(b));
  return uniq;
}

/** Slot range & coverage for a given start time */
export function slotRange(
  time: HHMM,
  durationMinutes = 120,
  slotMinutes = 15,
): { slotStart: HHMM; slotEnd: HHMM; coverStart: HHMM; coverEnd: HHMM } {
  const s = Math.max(1, Math.floor(slotMinutes));
  const start = floorToGrid(time, s);
  const slotEnd = addMinutes(start, s);
  const coverStart = start;
  const coverEnd = addMinutes(time, Math.max(1, Math.floor(durationMinutes)));
  return { slotStart: start, slotEnd, coverStart, coverEnd };
}

export function rangesOverlap(aStart: HHMM, aEnd: HHMM, bStart: HHMM, bEnd: HHMM): boolean {
  const a0 = toMinutes(aStart), a1 = toMinutes(aEnd);
  const b0 = toMinutes(bStart), b1 = toMinutes(bEnd);
  return a0 < b1 && b0 < a1;
}
export function enumerateSlots(start: HHMM, end: HHMM, slotMinutes = 15): HHMM[] {
  const s = Math.max(1, Math.floor(slotMinutes));
  const out: HHMM[] = [];
  if (!lt(end, start)) {
    for (let t = toMinutes(start); t < toMinutes(end); t += s) out.push(toHHMM(t));
  } else {
    for (let t = toMinutes(start); t < 1440; t += s) out.push(toHHMM(t));
    for (let t = 0; t < toMinutes(end); t += s) out.push(toHHMM(t));
  }
  return out;
}
