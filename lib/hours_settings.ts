/** Validate all supplied fields before making any database change. */
export function parseHoursSettings(params: URLSearchParams, previous: Record<string, unknown> = {}) {
  const patch: Record<string, unknown> = {};
  for (const [key, min, max] of [['capacity', 1, Number.MAX_SAFE_INTEGER], ['slotIntervalMinutes', 5, 180], ['serviceDurationMinutes', 15, 240]] as const) {
    if (!params.has(key)) continue;
    const raw = params.get(key)!.trim(), value = Number(raw);
    if (!raw || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(key);
    patch[key] = value;
  }
  const weekly = {...previous};
  let touched = false;
  const time = (value: string | null) => {
    const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
    return match[1].padStart(2, '0') + ':' + match[2];
  };
  for (let day = 0; day < 7; day++) {
    const prefix = `w${day}_`;
    if (!['closed','open','close'].some(key => params.has(prefix + key))) continue;
    touched = true;
    if (params.get(prefix + 'closed') === 'on') {weekly[day] = null;continue;}
    const open = time(params.get(prefix + 'open')), close = time(params.get(prefix + 'close'));
    if (!open || !close || close <= open) throw new Error(prefix + 'hours');
    weekly[day] = {open,close};
  }
  if (touched) patch.weeklySchedule = weekly;
  return patch;
}
