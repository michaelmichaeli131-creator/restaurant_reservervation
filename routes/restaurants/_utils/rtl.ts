// src/routes/restaurants/_utils/rtl.ts
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ZSP  = /[\s\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]+/g;
const FULLWIDTH_AT = /＠/g;
const FULLWIDTH_DOT = /．/g;

export function normalizePlain(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(BIDI, "");
  s = s.replace(ZSP, " ").trim();
  s = s.replace(/^[<\"'\s]+/, "").replace(/[>\"'\s]+$/, "");
  return s;
}

export function sanitizeEmailMinimal(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(BIDI, "");
  s = s.replace(FULLWIDTH_AT, "@").replace(FULLWIDTH_DOT, ".");
  s = s.replace(ZSP, " ").trim();
  s = s.replace(/^[<\"'\s]+/, "").replace(/[>\"'\s]+$/, "");
  s = s.replace(/\s*@\s*/g, "@");
  const at = s.indexOf("@");
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1).toLowerCase();
    s = `${local}@${domain}`;
  }
  return s;
}

export function isValidEmailStrict(s: string): boolean {
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s);
}

export function sanitizeNote(raw: unknown): string {
  const s = normalizePlain(raw ?? "");
  return s.replace(/\s+/g, " ").slice(0, 500);
}
