// src/lib/debug.ts
const MAX_LEN = 20_000;

function safe(v: unknown) {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) {
        return { message: val.message, stack: val.stack };
      }
      return val;
    });
  } catch {
    try { return String(v); } catch { return "[Unserializable]"; }
  }
}

export function debugLog(label: string, payload?: unknown) {
  const ts = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[${ts}][${label}]`);
    return;
  }
  const s = safe(payload);
  const out = s.length > MAX_LEN ? s.slice(0, MAX_LEN) + "…(truncated)" : s;
  console.log(`[${ts}][${label}] ${out}`);
}
