// /src/routes/lang.ts
// -------------------------------------------------------------
// Router responsible for manual language switching
// -------------------------------------------------------------
// - נתיב: /lang/:code
// - בודק אם הקוד תקין (he/en/ka)
// - שומר עוגייה sb_lang + lang (כדי לתאם עם middleware/i18n.ts)
// - משמר הפניה אחורה (Referer) או חוזר ל־"/"
// - תומך גם בהפעלת HTTPS cookies, SameSite:Lax, וזמן חיים 180 ימים
// - מוסיף Fallback: אם כתיבת Cookie עם secure נכשלת, ננסה שוב עם secure:false
// -------------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";

const SUPPORTED = ["he", "en", "ka"] as const;
type Locale = typeof SUPPORTED[number];

const router = new Router();

// helper לזיהוי אם הבקשה מאובטחת (HTTPS/מאחורי פרוקסי)
function isSecure(ctx: any): boolean {
  if (ctx.request?.secure) return true;
  const xf = ctx.request?.headers.get("x-forwarded-proto");
  if (xf && xf.toLowerCase() === "https") return true;
  try {
    return ctx.request.url.protocol === "https:";
  } catch {
    return false;
  }
}

async function setLangCookiesWithFallback(ctx: any, code: Locale) {
  const base = {
    httpOnly: false,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 180, // 180 ימים
  };
  const firstTry = { ...base, secure: isSecure(ctx) };

  try {
    await ctx.cookies.set("sb_lang", code, firstTry);
    await ctx.cookies.set("lang", code, firstTry);
  } catch (err) {
    // אם נכשל עקב "Cannot send secure cookie over unencrypted connection"
    try {
      const secondTry = { ...base, secure: false };
      await ctx.cookies.set("sb_lang", code, secondTry);
      await ctx.cookies.set("lang", code, secondTry);
      console.warn("[lang] secure cookie failed over HTTP, retried with secure:false");
    } catch (err2) {
      console.error("[lang] failed to set cookies even after fallback:", err2);
      // לא מפילים את הבקשה — עדיין נמשיך להפניה
    }
  }
}

router.get("/lang/:code", async (ctx) => {
  const code = (ctx.params.code || "").toLowerCase() as Locale;
  const back = ctx.request.headers.get("referer") || "/";

  if (!SUPPORTED.includes(code)) {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", back);
    return;
  }

  await setLangCookiesWithFallback(ctx, code);

  // אם יש session פעיל (middleware/session.ts), עדכן גם שם
  try {
    // deno-lint-ignore no-explicit-any
    const session = (ctx.state as any)?.session;
    if (session?.set) await session.set("lang", code);
  } catch {
    // לא קריטי, נמשיך הלאה
  }

  // הפניה חזרה לעמוד הקודם
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", back);
});

export default router;
