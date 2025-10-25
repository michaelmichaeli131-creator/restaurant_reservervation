// /src/routes/lang.ts
// -------------------------------------------------------------
// Router responsible for manual language switching
// -------------------------------------------------------------
// - נתיב: /lang/:code
// - בודק אם הקוד תקין (he/en/ka)
// - שומר עוגייה sb_lang + lang (כדי לתאם עם middleware/i18n.ts)
// - משמר הפניה אחורה (Referer) או חוזר ל־"/"
// - תומך גם בהפעלת HTTPS cookies, SameSite:Lax, וזמן חיים 180 ימים
// -------------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";

const SUPPORTED = ["he", "en", "ka"] as const;
type Locale = typeof SUPPORTED[number];

const router = new Router();

router.get("/lang/:code", async (ctx) => {
  const code = (ctx.params.code || "").toLowerCase() as Locale;
  const back = ctx.request.headers.get("referer") || "/";

  if (!SUPPORTED.includes(code)) {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", back);
    return;
  }

  const cookieOpts = {
    httpOnly: false,
    sameSite: "Lax" as const,
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 180, // 180 ימים
  };

  // שמור גם sb_lang וגם lang (לשילוב מלא עם ה־middleware)
  await ctx.cookies.set("sb_lang", code, cookieOpts);
  await ctx.cookies.set("lang", code, cookieOpts);

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
