// src/lib/debug.ts
const ENABLED =
  (Deno.env.get("DEBUG") || "").toLowerCase() === "1" ||
  (Deno.env.get("ENV") || "").toLowerCase() !== "production";

function stamp() {
  return new Date().toISOString();
}

export function debugLog(tag: string, data?: unknown) {
  if (!ENABLED) return;
  try {
    if (data === undefined) {
      console.log(`[${stamp()}][${tag}]`);
    } else if (typeof data === "string") {
      console.log(`[${stamp()}][${tag}] ${data}`);
    } else {
      // JSON עם טיפול ב-BigInt
      const safe = JSON.stringify(
        data,
        (_k, v) => (typeof v === "bigint" ? String(v) : v),
      );
      console.log(`[${stamp()}][${tag}]`, safe);
    }
  } catch (_e) {
    // fallback הדפסה "גולמית" אם JSON.stringify נכשל
    console.log(`[${stamp()}][${tag}]`, data);
  }
}

// alias בשם dlog כדי לשמור תאימות לקוד קיים
export const dlog = debugLog;

// גם יצוא ברירת מחדל – שימושי אם יש import default איפשהו
export default debugLog;
