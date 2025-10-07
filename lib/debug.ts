// src/lib/debug.ts
const DEF = (typeof Deno !== "undefined" && (Deno.env?.get?.("DEBUG") || "")) || "";
const NAMES = new Set(
  DEF.split(/[,\s]+/)
     .map(s => s.trim())
     .filter(Boolean)
);

function on(scope: string) {
  if (NAMES.size === 0) return true; // ברירת מחדל: הכל
  return NAMES.has(scope) || NAMES.has("*");
}

function ts() {
  const d = new Date();
  const pad = (n:number)=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,"0")}`;
}

export function debugLog(scope: string, msg: string, data?: unknown) {
  if (!on(scope)) return;
  const base = `[${ts()}][${scope}] ${msg}`;
  if (data === undefined) {
    console.log(base);
    return;
  }
  try {
    // הדפסה יפה לאובייקטים
    console.log(base + ": " + JSON.stringify(data, null, 2));
  } catch {
    console.log(base + ": " + String(data));
  }
}

// כלי עזר מקוצר
export const dlog = debugLog;
