// /src/lib/mail_wrappers.ts
// שכבת wrapper דקה מעל mail.ts:
// - אם מועבר ctx: נחלץ ממנו שפה (he/en/ka)
// - אם מועברת מחרוזת שפה: נשתמש בה ישירות
// - אם לא הועבר כלום: ברירת מחדל "he"
// בנוסף: מייצא בדיוק את אותם שמות שהקוד שלך מצפה להם (sendVerifyEmail, sendResetEmail),
// וגם re-export לפונקציות האחרות כדי שתוכל לייבא אותן מהקובץ הזה אם תרצה.

import {
  sendVerifyEmail as _sendVerifyEmail,
  sendResetEmail as _sendResetEmail,
  sendReservationEmail,
  notifyOwnerEmail,
  sendReminderEmail,
} from "./mail.ts";

type MaybeCtx = any;
type Lang = "he" | "en" | "ka";

function normLang(l?: string | null): Lang {
  const v = String(l || "").toLowerCase();
  return v === "en" || v === "ka" ? (v as Lang) : "he";
}

function langFromCtx(ctx?: MaybeCtx): Lang {
  // 1) ctx.state.lang (אם יש i18n middleware)
  const s1 = ctx?.state?.lang;
  if (s1) return normLang(s1);

  // 2) ?lang=... מה-URL
  try {
    const sp = ctx?.request?.url?.searchParams;
    const s2 = sp?.get?.("lang");
    if (s2) return normLang(s2);
  } catch {}

  // 3) cookie "lang"
  try {
    const s3 = ctx?.cookies?.get?.("lang");
    if (s3) return normLang(s3);
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

/** שלח מייל אימות משתמש. מקבל:
 *  - (to, token, langString?)
 *  - (to, token, ctx?)  ← נשלפת שפה מהקונטקסט
 */
export async function sendVerifyEmail(
  to: string,
  token: string,
  langOrCtx?: string | null | MaybeCtx,
) {
  const L =
    typeof langOrCtx === "string" || langOrCtx == null
      ? normLang(langOrCtx as string | null | undefined)
      : langFromCtx(langOrCtx);
  return await _sendVerifyEmail(to, token, L);
}

/** שלח מייל שחזור סיסמה. חתימה זהה ל-verify:
 *  - (to, token, langString?)
 *  - (to, token, ctx?)
 */
export async function sendResetEmail(
  to: string,
  token: string,
  langOrCtx?: string | null | MaybeCtx,
) {
  const L =
    typeof langOrCtx === "string" || langOrCtx == null
      ? normLang(langOrCtx as string | null | undefined)
      : langFromCtx(langOrCtx);
  return await _sendResetEmail(to, token, L);
}

// אם תרצה לייבא מכאן גם את השאר:
export { sendReservationEmail, notifyOwnerEmail, sendReminderEmail } from "./mail.ts";
