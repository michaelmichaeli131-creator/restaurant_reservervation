// /src/routes/auth.ts
// Auth routes (login/register/verify/forgot/reset) עם תמיכה מלאה ב־i18n למיילים.
// תיקון חשוב: קביעת cookie לשפה גם ב-GET כדי שה-POST של forgot יישאר באותה שפה.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  createUser,
  findUserByEmail,
  getUserById,
  setEmailVerified,
  createVerifyToken,
  useVerifyToken,
  createResetToken,
  useResetToken,
  updateUserPassword,
} from "../database.ts";

import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";

// ========= helpers =========
function getLang(ctx: any): string {
  // סדר עדיפות: state.lang → query ?lang → cookie → Accept-Language → 'he'
  const st = ctx.state?.lang;
  if (st) return st;

  const q = ctx.request.url.searchParams.get("lang");
  if (q) return q;

  const c = ctx.cookies?.get?.("lang");
  if (c) return c;

  const al = ctx.request.headers.get("accept-language") || "";
  if (/^en/i.test(al)) return "en";
  if (/^ka/i.test(al)) return "ka";
  if (/^he/i.test(al)) return "he";

  return "he";
}

function setLangCookieIfPresent(ctx: any, lang: string) {
  // אם יש ?lang בבקשה — נשמור cookie (כמו בשאר הראוטרים אצלך)
  if (ctx.request.url.searchParams.has("lang")) {
    try {
      ctx.cookies?.set?.("lang", lang, {
        httpOnly: false,
        sameSite: "Lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    } catch {
      /* ignore cookie errors */
    }
  }
}

const router = new Router();

// ========= Login =========
router.get("/auth/login", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang); // ← חדש: קובע cookie גם ב-GET

  const t = ctx.state?.t ?? ((_: string, fb?: string) => fb ?? "");
  await render(ctx, "login", {
    page: "login",
    lang,
    dir: lang === "he" ? "rtl" : "ltr",
    t,
    title: t("auth.login.title", "התחברות"),
  });
});

router.post("/auth/login", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang);

  const body = await ctx.request.body({ type: "form" }).value;
  const email = String(body.get("email") || "").trim().toLowerCase();
  const password = String(body.get("password") || "");

  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "Invalid credentials";
    return;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "Invalid credentials";
    return;
  }

  try {
    const session = (ctx.state as any).session;
    if (session) await session.set("userId", user.id);
  } catch { /* ignore */ }

  const redirect = String(body.get("redirect") || "/");
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", redirect);
});

// ========= Register =========
router.get("/auth/register", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang); // ← חדש: קובע cookie גם ב-GET

  const t = ctx.state?.t ?? ((_: string, fb?: string) => fb ?? "");
  await render(ctx, "register", {
    page: "register",
    lang,
    dir: lang === "he" ? "rtl" : "ltr",
    t,
    title: t("auth.register.title", "הרשמה"),
  });
});

router.post("/auth/register", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang);

  const body = await ctx.request.body({ type: "form" }).value;
  const email = String(body.get("email") || "").trim().toLowerCase();
  const firstName = String(body.get("firstName") || "").trim();
  const lastName = String(body.get("lastName") || "").trim();
  const password = String(body.get("password") || "");

  const existing = await findUserByEmail(email);
  if (existing) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = "email_exists";
    return;
  }

  const passwordHash = password ? await hashPassword(password) : undefined;

  const user = await createUser({
    email,
    firstName,
    lastName,
    passwordHash,
    role: "owner",
    provider: "local",
  });

  // אימות מייל בשפת המשתמש
  try {
    const token = await createVerifyToken(user.id, user.email);
    await sendVerifyEmail(user.email, token, lang);
  } catch (e) {
    console.warn("[auth.register] sendVerifyEmail failed:", e);
  }

  try {
    const session = (ctx.state as any).session;
    if (session) await session.set("userId", user.id);
  } catch { /* ignore */ }

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// ========= Email Verify =========
router.get("/auth/verify", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang); // ← חדש: קובע cookie גם ב-GET

  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing token";
    return;
  }

  const used = await useVerifyToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "invalid_or_used_token";
    return;
  }

  const user = await getUserById(used.userId);
  if (!user) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "user_not_found";
    return;
  }

  await setEmailVerified(user.id);

  try {
    const session = (ctx.state as any).session;
    if (session) await session.set("userId", user.id);
  } catch { /* ignore */ }

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// ========= Forgot password =========
router.get("/auth/forgot", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang); // ← קריטי: כך ה-POST ישאב את אותה שפה מה-cookie

  const t = ctx.state?.t ?? ((_: string, fb?: string) => fb ?? "");
  await render(ctx, "forgot_password", {
    page: "forgot",
    lang,
    dir: lang === "he" ? "rtl" : "ltr",
    t,
    title: t("auth.forgot.title", "שחזור סיסמה"),
  });
});

router.post("/auth/forgot", async (ctx) => {
  // 1) קבע/גזור שפה
  let lang = getLang(ctx);

  // אם ה-GET לא העביר ?lang, אפשר גם לתמוך בשדה חבוי בטופס (לא חובה):
  try {
    const bodyPeek = await ctx.request.body({ type: "form" }).value;
    const bodyLang = String(bodyPeek.get("lang") || "").trim();
    if (bodyLang) lang = bodyLang;
    // אם הגיע lang בגוף — נשמור cookie לעתיד
    if (bodyLang) {
      ctx.cookies?.set?.("lang", lang, {
        httpOnly: false,
        sameSite: "Lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    // שלוף מייל מהגוף
    const email = String(bodyPeek.get("email") || "").trim().toLowerCase();

    const user = await findUserByEmail(email);
    if (user) {
      try {
        const token = await createResetToken(user.id);
        await sendResetEmail(email, token, lang); // ← שולחים בשפה הנוכחית
      } catch (e) {
        console.warn("[auth.forgot] sendResetEmail failed:", e);
      }
    }
  } catch (e) {
    console.warn("[auth.forgot] body parse failed:", e);
    // גם במקרה של כשל פרסינג לא חושפים מידע — חוזרים למסך sent=1
  }

  // לא חושפים אם המשתמש קיים או לא
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/auth/forgot?sent=1");
});

// ========= Reset password (via token) =========
router.get("/auth/reset", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang); // ← חדש: קובע cookie גם ב-GET

  const t = ctx.state?.t ?? ((_: string, fb?: string) => fb ?? "");
  const token = ctx.request.url.searchParams.get("token") || "";
  await render(ctx, "reset_password", {
    page: "reset",
    lang,
    dir: lang === "he" ? "rtl" : "ltr",
    t,
    title: t("auth.reset.title", "איפוס סיסמה"),
    token,
  });
});

router.post("/auth/reset", async (ctx) => {
  const lang = getLang(ctx);
  setLangCookieIfPresent(ctx, lang);

  const body = await ctx.request.body({ type: "form" }).value;
  const token = String(body.get("token") || "");
  const password = String(body.get("password") || "");

  if (!token || !password) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing token or password";
    return;
  }

  const used = await useResetToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "invalid_or_expired_token";
    return;
  }

  const user = await getUserById(used.userId);
  if (!user) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "user_not_found";
    return;
  }

  const passwordHash = await hashPassword(password);
  await updateUserPassword(user.id, passwordHash);

  try {
    const session = (ctx.state as any).session;
    if (session) await session.set("userId", user.id);
  } catch { /* ignore */ }

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?reset=ok");
});

// ========= Logout =========
router.post("/auth/logout", async (ctx) => {
  try {
    const session = (ctx.state as any).session;
    if (session) await session.set("userId", null);
  } catch { /* ignore */ }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

export const authRouter = router;
