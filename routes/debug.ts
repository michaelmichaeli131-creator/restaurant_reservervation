// src/lib/debug.ts
export function debugLog(label: string, obj: unknown) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    console.log(`[DEBUG] ${label}: ${s}`);
  } catch (e) {
    console.log(`[DEBUG] ${label}: (couldn't stringify)`, obj);
  }
}
