// src/lib/mail_wrappers.ts
// עטיפות נוחות לשימוש: שולחות מייל אימות/שחזור עם lang מה-ctx (או cookie / accept-language)
// כך לא צריך לשנות את לוגיקת הראוטרים, רק את הקריאה לשליחת המייל.

import { sendVerifyEmail, sendResetEmail } from "./mail.ts";

/* ====== זיהוי שפה עקבי ====== */
function getLangFromCtx(ctx: any): "he" | "en" | "ka" {
  // 1) state.lang מה-middleware/i18n.ts שלך
  const st = ctx?.state;
  if (st && typeof st.lang === "string") {
    const v = st.lang.toLowerCase();
    if (v === "he" || v === "en" || v === "ka") return v;
  }

  // 2) שאילתא
  try {
    const q = ctx?.request?.url?.searchParams?.get?.("lang");
    if (q) {
      const v = String(q).toLowerCase();
      if (v === "he" || v === "en" || v === "ka") return v as any;
    }
  } catch {}

  // 3) cookie "lang"
  try {
    const c = ctx?.cookies?.get?.("lang");
    if (c) {
      const v = String(c).toLowerCase();
      if (v === "he" || v === "en" || v === "ka") return v as any;
    }
  } catch {}

  // 4) Accept-Language
  try {
    const al = ctx?.request?.headers?.get?.("accept-language") || "";
    if (/^en/i.test(al)) return "en";
    if (/^ka/i.test(al)) return "ka";
    if (/^he/i.test(al)) return "he";
  } catch {}

  return "he";
}

/* ====== עטיפות ציבוריות ====== */
export async function sendVerifyEmailWithCtx(
  ctx: any,
  to: string,
  token: string,
) {
  const lang = getLangFromCtx(ctx);
  return await sendVerifyEmail(to, token, lang);
}

export async function sendResetEmailWithCtx(
  ctx: any,
  to: string,
  token: string,
) {
  const lang = getLangFromCtx(ctx);
  return await sendResetEmail(to, token, lang);
}
