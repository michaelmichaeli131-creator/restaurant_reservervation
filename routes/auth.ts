// src/routes/auth.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  createUser,
  findUserByEmail,
  findUserByUsername,
  createVerifyToken,
  setEmailVerified,
  useVerifyToken,
  createResetToken,
  useResetToken,
  updateUserPassword,
  type User,
} from "../database.ts";
import { render } from "../lib/view.ts";
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";
import { loginRequired } from "../lib/session.ts";
import { redirectWithBody } from "../lib/misc.ts";
import { router as restaurantsRouter } from "./restaurants/index.ts";

const authRouter = new Router();

// GET /auth/login - get login page
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

// GET /auth/register - get signup page
authRouter.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", { title: "הרשמה", page: "register" });
});

// GET /auth/forgot - forgot password page
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot" });
});

// GET /auth/logout - log out
authRouter.get("/auth/logout", (ctx) => {
  ctx.state.session = null;
  return ctx.response.redirect("/");
});

// GET /auth/verify - verify email (link in email)
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  const tokenData = await useVerifyToken(token);
  if (!tokenData) {
    // invalid or expired token
    await render(ctx, "verify_done", { title: "אימות", page: "verify", info: "קישור האימות אינו תקין או שפג תוקפו." });
    return;
  }

  // אימות אישור - סימון המשתמש כמאומת
  const userId = tokenData.userId;
  await setEmailVerified(userId);
  await render(ctx, "verify_done", { title: "אימות", page: "verify", info: "תודתנו על אימות כתובת הדוא״ל!" });
});

// GET /auth/reset - reset password form (link in email)
authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  const tokenData = await useResetToken(token);
  if (!tokenData) {
    // invalid or expired token
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "הקישור אינו תקין או שפג תוקפו." });
    return;
  }
  // token is valid - allow setting new password
  await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

// GET /auth/verify/resend - form to request verification email again
authRouter.get("/auth/verify/resend", async (ctx) => {
  await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "נא להזין את כתובת הדוא״ל שלך לשליחת קישור אימות חדש." });
});

// GET /auth/verify/resend/submit?email=... - actual resending of verification email
authRouter.get("/auth/verify/resend/submit", async (ctx) => {
  const email = ctx.request.url.searchParams.get("email") || "";
  if (!email) {
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "אם הדוא״ל קיים — נשלח קישור אימות." });
    return;
  }
  const user = await findUserByEmail(email);
  if (!user) {
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "אם הדוא״ל קיים — נשלח קישור אימות." });
    return;
  }
  if (user.emailVerified) {
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "החשבון כבר מאומת. אפשר להתחבר." });
    return;
  }
  const token = await createVerifyToken(user.id);
  try { await sendVerifyEmail(user.email, token, ctx.state.lang); } catch (e) { phase("verify.resend.error", String(e)); }
  await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "קישור אימות נשלח מחדש לתיבת הדוא״ל." });
});

// POST /auth/register - handle user registration
authRouter.post("/auth/register", async (ctx) => {
  const body = ctx.request.body({ type: "form" });
  const value = await body.value.catch(() => ({}));
  const firstName = value.get("firstName")?.trim() || "";
  const lastName = value.get("lastName")?.trim() || "";
  const username = value.get("username")?.trim() || "";
  const email = value.get("email")?.trim().toLowerCase() || "";
  const phone = value.get("phone")?.trim() || "";
  const businessType = value.get("businessType")?.trim() || "";
  const password = value.get("password") || "";

  // בדיקת שדות ריקים
  if (!firstName || !lastName || !username || !email || !phone || !businessType || !password) {
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "נא למלא את כל השדות",
      firstName,
      lastName,
      username,
      email,
      phone,
      businessType,
    });
    return;
  }

  // בדיקת אימייל תקין
  const emailPattern = /^(?:[A-Za-z0-9]+(?:[._%+-][A-Za-z0-9]+)*)@(?:[A-Za-z0-9-]+)(?:\.[A-Za-z0-9-]+)*$/;
  if (!emailPattern.test(email)) {
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "נא להזין כתובת דוא״ל תקינה",
      firstName,
      lastName,
      username,
      email,
      phone,
      businessType,
    });
    return;
  }

  // בדיקת סיסמה מינימום 8 תווים
  if (password.length < 8) {
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "הסיסמה צריכה להכיל לפחות 8 תווים",
      firstName,
      lastName,
      username,
      email,
      phone,
      businessType,
    });
    return;
  }

  // לוודא שהמשתמש לא קיים
  if (await findUserByEmail(email)) {
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "כתובת דוא״ל זו כבר רשומה במערכת",
      firstName,
      lastName,
      username,
      email,
      phone,
      businessType,
    });
    return;
  }
  if (await findUserByUsername(username)) {
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "שם משתמש זה כבר תפוס",
      firstName,
      lastName,
      username,
      email,
      phone,
      businessType,
    });
    return;
  }

  // יצירת חשבון חדש
  const user: Partial<User> = {
    firstName, lastName, email,
    businessType, phone,
    provider: "local",
    role: "owner",
  };

  const hash = await hashPassword(password);
  const created = await createUser({ ...(user as User), passwordHash: hash } as any);
  phase("register.created", { userId: created.id });

  // שליחת אימות
  const token = await createVerifyToken(created.id);
  try { await sendVerifyEmail(created.email, token, ctx.state.lang); phase("register.verify.sent", { email: created.email }); }
  catch (e) { phase("register.verify.error", String(e)); }

  // אין התחברות! דורשים אימות קודם
  await render(ctx, "verify_notice", {
    title: "בדיקת דוא״ל",
    page: "verify",
    info: "חשבונך נוצר בהצלחה! לפני התחברות יש לאמת את כתובת הדוא״ל. שלחנו אליך קישור אימות.",
  });
});

// POST /auth/login - handle user login
authRouter.post("/auth/login", async (ctx) => {
  const body = ctx.request.body({ type: "form" });
  const value = await body.value.catch(() => ({}));
  const email = value.get("email")?.trim().toLowerCase() || "";
  const password = value.get("password") || "";

  // בדיקת אימייל או סיסמה ריקים
  if (!email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "נא למלא את כל השדות" });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  if (!user.emailVerified) {
    // חוסמים התחברות עד אימות
    const token = await createVerifyToken(user.id);
    try { await sendVerifyEmail(user.email, token, ctx.state.lang); } catch {}
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "נדרש אימות דוא״ל לפני התחברות. שלחנו לך קישור אימות נוסף.",
      email,
    });
    return;
  }

  // אימות סיסמה
  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים", email });
    return;
  }

  // התחברות מוצלחת
  ctx.state.session = { userId: user.id };
  phase("login.success", { userId: user.id });
  return ctx.response.redirect("/");
});

// POST /auth/forgot - handle forgot password form
authRouter.post("/auth/forgot", async (ctx) => {
  const body = ctx.request.body({ type: "form" });
  const value = await body.value.catch(() => ({}));
  const email = value.get("email")?.trim().toLowerCase() || "";

  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "נא להזין דוא״ל" });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    try { await sendResetEmail(email, token, ctx.state.lang); } catch (e) { phase("forgot.send.error", String(e)); }
  }
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", info: "אם הדוא״ל קיים, נשלח קישור איפוס" });
});

// POST /auth/reset - handle password reset submission
authRouter.post("/auth/reset", async (ctx) => {
  const body = ctx.request.body({ type: "form" });
  const value = await body.value.catch(() => ({}));
  const token = value.get("token") || "";
  const password = value.get("password") || "";

  // token and password are required
  if (!token || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "חסרים נתונים לשחזור סיסמה" });
    return;
  }

  const tokenData = await useResetToken(token);
  if (!tokenData) {
    // invalid or expired token
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "הקישור אינו תקין או שפג תוקפו." });
    return;
  }
  const userId = tokenData.userId;
  if (password.length < 8) {
    // new password too short
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "הסיסמה צריכה להכיל לפחות 8 תווים" });
    return;
  }

  const hash = await hashPassword(password);
  await updateUserPassword(userId, hash);
  phase("reset.success", { userId });
  await render(ctx, "auth/login", { title: "התחברות", page: "login", info: "הסיסמה אופסה בהצלחה! אפשר להתחבר עם הסיסמה החדשה." });
});

// Protect the /auth/* routes from unauthorized access (except /login, /register, /forgot, /verify and /reset which must stay public)
authRouter.use(async (ctx, next) => {
  const { pathname } = ctx.request.url;
  if (
    pathname.startsWith("/auth/") &&
    !pathname.startsWith("/auth/login") &&
    !pathname.startsWith("/auth/register") &&
    !pathname.startsWith("/auth/forgot") &&
    !pathname.startsWith("/auth/verify") &&
    !pathname.startsWith("/auth/reset")
  ) {
    // For any other /auth route, require login
    return loginRequired(ctx, next);
  }
  return next();
});

// mount nested routers
authRouter.use(restaurantsRouter.routes());
authRouter.use(restaurantsRouter.allowedMethods());

// debugging: log any error thrown in auth routes
function phase(name: string, data?: unknown) {
  try { debugLog(`[auth] ${name}`, data); } catch (_e) {}
}

export { authRouter };
