// /src/routes/auth.ts
import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  createUser,
  findUserByEmail,
  findUserByUsername,
  getUserById,
  setEmailVerified,
  createVerifyToken,
  useVerifyToken,
  createResetToken,
  useResetToken,
  updateUserPassword,
} from "../database.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
// נשאר עם המימוש הרב־לשוני הקיים שלך ב-mail.ts
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";

const router = new Router();

/* ---------- הוספה: עוזרי שפה, זהים ל־reservation.controller ---------- */
type Lang = "he" | "en" | "ka";
function getLang(ctx: any): Lang {
  const q = ctx.request.url.searchParams.get("lang");
  if (q && /^(he|en|ka)\b/i.test(q)) return q.toLowerCase() as Lang;
  const c = ctx.cookies?.get?.("lang");
  if (c && /^(he|en|ka)\b/i.test(c)) return c.toLowerCase() as Lang;
  const al = ctx.request.headers.get("accept-language") || "";
  if (/^en/i.test(al)) return "en";
  if (/^ka/i.test(al)) return "ka";
  if (/^he/i.test(al)) return "he";
  return "he";
}
function rememberLangIfQuery(ctx: any, lang: Lang) {
  if (ctx.request.url.searchParams.has("lang")) {
    ctx.cookies?.set?.("lang", lang, { httpOnly: false, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
  }
}
/* -------------------------------------------------------------------- */

// GET /auth/register
router.get("/auth/register", async (ctx) => {
  await render(ctx, "auth_register", { page: "register", title: "Sign up" });
});

// POST /auth/register
router.post("/auth/register", async (ctx) => {
  const form = await ctx.request.body({ type: "form" }).value;
  const email = String(form.get("email") ?? "").trim();
  const username = String(form.get("username") ?? "").trim();
  const firstName = String(form.get("firstName") ?? "").trim();
  const lastName = String(form.get("lastName") ?? "").trim();
  const password = String(form.get("password") ?? "");

  const lang = getLang(ctx);
  rememberLangIfQuery(ctx, lang);

  if (!email || !password) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing email/password";
    return;
  }

  const exists =
    (await findUserByEmail(email)) ||
    (username ? await findUserByUsername(username) : null);
  if (exists) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = "user already exists";
    return;
  }

  const passwordHash = await hashPassword(password);
  const created = await createUser({
    email,
    username,
    firstName,
    lastName,
    passwordHash,
    role: "owner",
    provider: "local",
  });

  // שלח אימות בשפה הנכונה
  const token = await createVerifyToken(created.id, created.email);
  await sendVerifyEmail(created.email, token, lang).catch((e) =>
    console.warn("[mail] sendVerifyEmail failed:", e)
  );

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/auth/login?sent=1");
});

// GET /auth/verify?token=...
router.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing token";
    return;
  }
  const payload = await useVerifyToken(token);
  if (!payload) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "invalid/expired token";
    return;
  }
  await setEmailVerified(payload.userId);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/auth/login?verified=1");
});

// GET /auth/login
router.get("/auth/login", async (ctx) => {
  await render(ctx, "auth_login", { page: "login", title: "Login" });
});

// POST /auth/login
router.post("/auth/login", async (ctx) => {
  const form = await ctx.request.body({ type: "form" }).value;
  const emailOrUser = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  const user =
    (await findUserByEmail(emailOrUser)) ||
    (await findUserByUsername(emailOrUser));
  if (!user || !user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "invalid credentials";
    return;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "invalid credentials";
    return;
  }

  const session = (ctx.state as any).session;
  if (session) {
    await session.set("userId", user.id);
  }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// GET /auth/forgot
router.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth_forgot", { page: "forgot", title: "Forgot password" });
});

// POST /auth/forgot
router.post("/auth/forgot", async (ctx) => {
  const form = await ctx.request.body({ type: "form" }).value;
  const email = String(form.get("email") ?? "").trim();

  const lang = getLang(ctx);
  rememberLangIfQuery(ctx, lang);

  if (!email) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing email";
    return;
  }
  const user = await findUserByEmail(email);
  // לא מדליפים אם יש/אין משתמש – מתנהגים כאילו נשלח
  if (user) {
    const token = await createResetToken(user.id);
    // ← כאן היה חסר lang; עכשיו מעבירים
    await sendResetEmail(email, token, lang).catch((e) =>
      console.warn("[mail] sendResetEmail failed:", e)
    );
  }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/auth/forgot?sent=1");
});

// GET /auth/reset?token=...
router.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing token";
    return;
  }
  await render(ctx, "auth_reset", { page: "reset", title: "Reset password", token });
});

// POST /auth/reset
router.post("/auth/reset", async (ctx) => {
  const form = await ctx.request.body({ type: "form" }).value;
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (!token || !password) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing token/password";
    return;
  }
  const payload = await useResetToken(token);
  if (!payload) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "invalid/expired token";
    return;
  }
  const hash = await hashPassword(password);
  await updateUserPassword(payload.userId, hash);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/auth/login?reset=1");
});

// GET /auth/logout
router.get("/auth/logout", async (ctx) => {
  const session = (ctx.state as any).session;
  if (session) await session.set("userId", null);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

export const authRouter = router;
