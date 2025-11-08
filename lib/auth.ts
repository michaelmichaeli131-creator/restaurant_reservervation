// ===== file: src/routes/auth.ts =====
import { Router, Status } from "jsr:@oak/oak";
import {
  createUser, findUserByEmail, getUserById, setUserEmailVerified,
  updateUserPassword, issueSession, requirePasswordResetToken,
  createPasswordResetToken, consumePasswordResetToken,
  createEmailVerifyToken, consumeEmailVerifyToken
} from "../database.ts";
import { render } from "../lib/view.ts";
import { sanitizeEmailMinimal, isValidEmailStrict, normalizePlain } from "./restaurants/_utils/rtl.ts";
import { debugLog } from "../lib/debug.ts";
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";

/* ===== i18n helpers (local to this router) ===== */
function getLang(ctx: any): string {
  const lang = ctx.state?.lang;
  if (lang) return String(lang);
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

export const authRouter = new Router();

// --- GET /auth/login ---
authRouter.get("/auth/login", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  await render(ctx, "auth_login", {
    page: "auth_login",
    t,
    title: t("auth.login.title", "התחברות"),
  });
});

// --- POST /auth/login ---
authRouter.post("/auth/login", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  const body = await ctx.request.body?.({ type: "form" }).value;
  const emailRaw = body?.get("email") ?? "";
  const password = body?.get("password") ?? "";
  const email = sanitizeEmailMinimal(String(emailRaw));

  const user = await findUserByEmail(email);
  if (!user) {
    await render(ctx, "auth_login", {
      page: "auth_login",
      t,
      title: t("auth.login.title", "התחברות"),
      error: t("auth.login.err", "אימייל או סיסמה שגויים"),
    });
    return;
  }
  const ok = await verifyPassword(String(password), user.passwordHash);
  if (!ok) {
    await render(ctx, "auth_login", {
      page: "auth_login",
      t,
      title: t("auth.login.title", "התחברות"),
      error: t("auth.login.err", "אימייל או סיסמה שגויים"),
    });
    return;
  }
  await issueSession(ctx, user.id);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// --- GET /auth/register ---
authRouter.get("/auth/register", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  await render(ctx, "auth_register", {
    page: "auth_register",
    t,
    title: t("auth.register.title", "הרשמה"),
  });
});

// --- POST /auth/register ---
authRouter.post("/auth/register", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  const body = await ctx.request.body?.({ type: "form" }).value;
  const email = sanitizeEmailMinimal(String(body?.get("email") ?? ""));
  const name  = normalizePlain(String(body?.get("name") ?? ""));
  const pass1 = String(body?.get("password") ?? "");
  const pass2 = String(body?.get("password2") ?? "");

  if (!email || !isValidEmailStrict(email)) {
    await render(ctx, "auth_register", {
      page: "auth_register", t,
      title: t("auth.register.title", "הרשמה"),
      error: t("auth.register.err.email", "נא להזין אימייל תקין"),
    });
    return;
  }
  if (!name || pass1.length < 6 || pass1 !== pass2) {
    await render(ctx, "auth_register", {
      page: "auth_register", t,
      title: t("auth.register.title", "הרשמה"),
      error: t("auth.register.err.pass", "סיסמה לא תקינה / לא תואמת"),
    });
    return;
  }
  const exists = await findUserByEmail(email);
  if (exists) {
    await render(ctx, "auth_register", {
      page: "auth_register", t,
      title: t("auth.register.title", "הרשמה"),
      error: t("auth.register.err.exists", "המשתמש כבר קיים"),
    });
    return;
  }

  const hash = await hashPassword(pass1);
  const created = await createUser({ email, name, passwordHash: hash, emailVerified: false, isActive: true });

  // שליחת מייל אימות לפי שפת המשתמש
  const token = await createEmailVerifyToken(created.id);
  await sendVerifyEmail(created.email, token, getLang(ctx));

  await issueSession(ctx, created.id);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// --- GET /auth/verify?token=... ---
authRouter.get("/auth/verify", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = t("auth.verify.bad", "קישור אימות שגוי");
    return;
  }
  const userId = await consumeEmailVerifyToken(token);
  if (!userId) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = t("auth.verify.bad", "קישור אימות שגוי");
    return;
  }
  await setUserEmailVerified(userId, true);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// --- GET /auth/reset/request ---
authRouter.get("/auth/reset/request", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  await render(ctx, "auth_reset_request", {
    page: "auth_reset_request", t,
    title: t("auth.reset.title", "איפוס סיסמה"),
  });
});

// --- POST /auth/reset/request ---
authRouter.post("/auth/reset/request", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  const body = await ctx.request.body?.({ type: "form" }).value;
  const email = sanitizeEmailMinimal(String(body?.get("email") ?? ""));
  if (!email || !isValidEmailStrict(email)) {
    await render(ctx, "auth_reset_request", {
      page: "auth_reset_request", t,
      title: t("auth.reset.title", "איפוס סיסמה"),
      error: t("auth.reset.err.email", "נא להזין אימייל תקין"),
    });
    return;
  }
  const user = await findUserByEmail(email);
  if (!user) {
    // לא מדליפים קיום חשבון
    await render(ctx, "auth_reset_request", {
      page: "auth_reset_request", t,
      title: t("auth.reset.title", "איפוס סיסמה"),
      ok: true,
    });
    return;
  }
  const token = await createPasswordResetToken(user.id);
  await sendResetEmail(email, token, getLang(ctx)); // ← כאן התיקון
  await render(ctx, "auth_reset_request", {
    page: "auth_reset_request", t,
    title: t("auth.reset.title", "איפוס סיסמה"),
    ok: true,
  });
});

// --- GET /auth/reset?token=... ---
authRouter.get("/auth/reset", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  const token = ctx.request.url.searchParams.get("token") ?? "";
  const uid = await requirePasswordResetToken(token);
  if (!uid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = t("auth.reset.bad", "קישור איפוס לא תקין או שגוי");
    return;
  }
  await render(ctx, "auth_reset_form", {
    page: "auth_reset_form", t,
    title: t("auth.reset.title", "איפוס סיסמה"),
    token,
  });
});

// --- POST /auth/reset?token=... ---
authRouter.post("/auth/reset", async (ctx) => {
  const t = ctx.state?.t ?? ((_k: string, fb?: string) => fb ?? "");
  const token = ctx.request.url.searchParams.get("token") ?? "";
  const uid = await requirePasswordResetToken(token);
  if (!uid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = t("auth.reset.bad", "קישור איפוס לא תקין או שגוי");
    return;
  }
  const body = await ctx.request.body?.({ type: "form" }).value;
  const pass1 = String(body?.get("password") ?? "");
  const pass2 = String(body?.get("password2") ?? "");
  if (pass1.length < 6 || pass1 !== pass2) {
    await render(ctx, "auth_reset_form", {
      page: "auth_reset_form", t,
      title: t("auth.reset.title", "איפוס סיסמה"),
      token,
      error: t("auth.reset.err.pass", "סיסמה לא תקינה / לא תואמת"),
    });
    return;
  }
  const hash = await hashPassword(pass1);
  await updateUserPassword(uid, hash);
  await consumePasswordResetToken(token);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/auth/login");
});
