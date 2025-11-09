// /src/routes/auth.ts
// Auth routes (login/register/verify/forgot/reset) עם תמיכה מלאה ב־i18n למיילים.
// תיקון קריטי: קריאת lang מגוף ה-POST (form) לפני cookie/URL/Accept-Language,
// ושמירתו בקוקי כדי שהמשך הזרימה יישאר באותה שפה.

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

// ========= i18n helpers =========
type Lang = "he" | "en" | "ka";
const SUPPORTED = new Set<Lang>(["he", "en", "ka"]);
function normLang(x?: string | null): Lang {
  const v = String(x ?? "").toLowerCase();
  return (SUPPORTED.has(v as Lang) ? v : "he") as Lang;
}

/** קובע שפה לפי סדר עדיפויות: state → body.lang → ?lang → cookie → Accept-Language */
function pickLang(ctx: any, body?: URLSearchParams | FormData | null): Lang {
  const st = ctx.state?.lang;
  if (st) return normLang(st);

  const b = (body as any)?.get?.("lang");
  if (b) return normLang(String(b));

  const q = ctx.request.url.searchParams.get("lang");
  if (q) return normLang(q);

  const c = ctx.cookies?.get?.("lang");
  if (c) return normLang(c);

  const al = ctx.request.headers.get("accept-language") || "";
  if (/^en/i.test(al)) return "en";
  if (/^ka/i.test(al)) return "ka";
  if (/^he/i.test(al)) return "he";
  return "he";
}

/** שומר קוקי שפה אם הועברה ב-POST (lang) או ב-URL (?lang) */
function persistLangCookie(ctx: any, langFromBody?: string | null) {
  const hasQ = ctx.request.url.searchParams.has("lang");
  const bodyLang = langFromBody ? String(langFromBody) : null;
  if (!hasQ && !bodyLang) return;

  const val = hasQ
    ? ctx.request.url.searchParams.get("lang")!
    : bodyLang!;
  ctx.cookies?.set?.("lang", normLang(val), {
    httpOnly: false,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

const router = new Router();

// ========= Login =========
router.get("/auth/login", async (ctx) => {
  const lang = pickLang(ctx, null);
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
  const form = await ctx.request.body({ type: "form" }).value;
  const lang = pickLang(ctx, form);
  persistLangCookie(ctx, form.get("lang"));

  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");

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

  const redirect = String(form.get("redirect") || "/");
  // משמרים את השפה בניווט חזרה אם רלוונטי
  const url = new URL(redirect, "http://local");
  if (!url.searchParams.has("lang")) url.searchParams.set("lang", lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set(
    "Location",
    redirect.startsWith("/") ? `${url.pathname}${url.search}` : redirect,
  );
});

// ========= Register =========
router.get("/auth/register", async (ctx) => {
  const lang = pickLang(ctx, null);
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
  const form = await ctx.request.body({ type: "form" }).value;
  const lang = pickLang(ctx, form);
  persistLangCookie(ctx, form.get("lang"));

  const email = String(form.get("email") || "").trim().toLowerCase();
  const firstName = String(form.get("firstName") || "").trim();
  const lastName = String(form.get("lastName") || "").trim();
  const password = String(form.get("password") || "");

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

  // מייל אימות בשפת המשתמש
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

  // לשמר שפה בניווט
  const back = new URL("/", "http://local");
  back.searchParams.set("lang", lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `${back.pathname}${back.search}`);
});

// ========= Email Verify =========
router.get("/auth/verify", async (ctx) => {
  const lang = pickLang(ctx, null);
  // אם מגיעים עם ?lang – נשמור
  persistLangCookie(ctx, null);

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

  const url = new URL("/", "http://local");
  url.searchParams.set("lang", lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `${url.pathname}${url.search}`);
});

// ========= Forgot password =========
router.get("/auth/forgot", async (ctx) => {
  const lang = pickLang(ctx, null);
  const t = ctx.state?.t ?? ((_: string, fb?: string) => fb ?? "");
  const sent = ctx.request.url.searchParams.get("sent") === "1";
  await render(ctx, "forgot_password", {
    page: "forgot",
    lang,
    dir: lang === "he" ? "rtl" : "ltr",
    t,
    sent,
    title: t("auth.forgot.title", "שחזור סיסמה"),
  });
});

router.post("/auth/forgot", async (ctx) => {
  const form = await ctx.request.body({ type: "form" }).value;
  const lang = pickLang(ctx, form);                  // ← קריטי: מה-POST
  persistLangCookie(ctx, form.get("lang"));          // ← שומר קוקי לשפה

  const email = String(form.get("email") || "").trim().toLowerCase();

  const user = await findUserByEmail(email);
  if (user) {
    try {
      const token = await createResetToken(user.id);
      await sendResetEmail(email, token, lang);      // ← שולח לפי השפה מהטופס
    } catch (e) {
      console.warn("[auth.forgot] sendResetEmail failed:", e);
      // לא נחשוף שגיאה למשתמש
    }
  }

  // לא חושפים קיום משתמש; משמרים שפה ב-redirect
  const back = new URL("/auth/forgot", "http://local");
  back.searchParams.set("sent", "1");
  back.searchParams.set("lang", lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `${back.pathname}${back.search}`);
});

// ========= Reset password (via token) =========
router.get("/auth/reset", async (ctx) => {
  const lang = pickLang(ctx, null);
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
  const form = await ctx.request.body({ type: "form" }).value;
  const lang = pickLang(ctx, form);
  persistLangCookie(ctx, form.get("lang"));

  const token = String(form.get("token") || "");
  const password = String(form.get("password") || "");

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

  const url = new URL("/", "http://local");
  url.searchParams.set("reset", "ok");
  url.searchParams.set("lang", lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `${url.pathname}${url.search}`);
});

// ========= Logout =========
router.post("/auth/logout", async (ctx) => {
  try {
    const session = (ctx.state as any).session;
    if (session) await session.set("userId", null);
  } catch { /* ignore */ }
  // לשמר שפה מהקוקי אם קיימת
  const lang = pickLang(ctx, null);
  const url = new URL("/", "http://local");
  url.searchParams.set("lang", lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `${url.pathname}${url.search}`);
});

export const authRouter = router;
