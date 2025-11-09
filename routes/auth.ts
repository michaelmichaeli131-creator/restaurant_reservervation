import { Status } from "jsr:@oak/http_status";
import { Router } from "jsr:@oak/router";
import { ensureStateUser, insertUser, findUserByEmail, findUserByUsername, findUserById, updateUserVerified, updateUserPassword } from "../database.ts";
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

/* ---------------- Debug helpers ---------------- */
function phase(name: string, data?: unknown) {
  try { debugLog(`[auth] ${name}`, data ?? ""); } catch {}
}
function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }
function trim(s?: string)  { return (s ?? "").trim(); }
function entriesToObject(entries: Iterable<[string, string]>): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [k, v] of entries) obj[k] = v;
  return obj;
}

/* ----------------- Router ----------------- */
export const authRouter = new Router();

// GET /auth/signup - sign up page (just render page)
authRouter.get("/auth/signup", async (ctx) => {
  await render(ctx, "auth/register", { title: "הרשמה", page: "register" });
});

// POST /auth/register - handle sign up submission
authRouter.post("/auth/register", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("register.input", { meta, keys: Object.keys(b) });

  const firstName = trim(String((b as any).firstName ?? (b as any).first_name ?? ""));
  const lastName  = trim(String((b as any).lastName  ?? (b as any).last_name  ?? ""));
  const emailRaw  = String((b as any).email ?? "");
  const email     = lower(emailRaw);
  const password  = String((b as any).password ?? "");
  const password2 = String((b as any).password2 ?? "");
  const agree     = String((b as any).agree ?? (b as any).terms ?? "");
  const isAgree   = agree === "1" || agree === "true" || agree === "on";

  // Basic validation
  if (!firstName || !lastName || !email || !password || !password2 || !isAgree) {
    phase("register.missing-fields");
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה", page: "register",
      error: "אנא מלא/י את כל השדות וסמן/י את אישור התנאים"
    });
    return;
  }
  if (password !== password2) {
    phase("register.password-mismatch");
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה", page: "register",
      error: "הסיסמאות אינן תואמות"
    });
    return;
  }

  // Password strength (optional check – not implemented here)
  // ...

  // Insert user (with unverified email)
  let created;
  try {
    const hashed = await hashPassword(password);
    created = await insertUser({ firstName, lastName, email, password: hashed, emailVerified: false });
    phase("register.created", { id: created?.id, email: created?.email });
  } catch (e) {
    phase("register.insert.error", String(e));
    ctx.response.status = Status.InternalServerError;
    await render(ctx, "auth/register", {
      title: "הרשמה", page: "register",
      error: "תקלה בהרשמה. ייתכן שהדוא״ל כבר רשום במערכת."
    });
    return;
  }

  // Send verification email
  if (created && created.id) {
    try {
      const token = await createVerifyToken(created.id);
      // העברת פרמטר שפה כדי שהמייל יישלח בשפה הנוכחית
      await sendVerifyEmail(created.email, token, ctx.state.lang);  // [שונה: הוספת ctx.state.lang]
      phase("register.verify.sent", { email: created.email });
    } catch (e) {
      phase("register.verify.error", String(e));
      // Note: even if email fails, user is created. We still show next page.
    }
  }

  // Render notice to check email for verification link
  await render(ctx, "verify_notice", {
    title: "בדיקת דוא״ל",
    page: "verify",
    info: "נשלח קישור אימות לכתובת הדוא״ל שסיפקת. יש להיכנס לקישור על מנת להשלים את ההרשמה.",
    resendUrl: `/auth/verify/resend?email=${encodeURIComponent(created.email)}`,
  });
});

// GET /auth/verify - verification link clicked
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  phase("verify.click", { token });

  let userId: string | null = null;
  if (token) {
    try {
      userId = await verifyVerifyToken(token);
      phase("verify.token.ok", { userId });
    } catch (e) {
      phase("verify.token.error", String(e));
    }
  }

  if (!userId) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_done", {
      title: "אימות כתובת דוא״ל",
      page: "verify",
      error: "קישור האימות אינו תקין או שפג תוקפו. יש להתחבר וללחוץ 'שלח שוב אימייל אימות'."
    });
    return;
  }

  // Mark user as verified
  try {
    await updateUserVerified(userId, true);
    phase("verify.user.verified", { userId });
  } catch (e) {
    phase("verify.user.error", String(e));
  }

  // Render success page
  await render(ctx, "verify_done", {
    title: "אימות כתובת דוא״ל",
    page: "verify",
    info: "כתובת הדוא״ל אומתה בהצלחה! כעת ניתן להתחבר למערכת."
  });
});

// GET /auth/verify/resend - resend verification email
authRouter.get("/auth/verify/resend", async (ctx) => {
  const email = lower(ctx.request.url.searchParams.get("email") || "");
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", error: "חסר דוא״ל לשליחת קישור אימות." });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", error: "חשבון עם דוא״ל זה לא נמצא." });
    return;
  }
  if (user.emailVerified) {
    // Already verified
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "הכתובת כבר אומתה בעבר. ניתן להתחבר." });
    return;
  }

  // Create a new verify token and send email
  try {
    const token = await createVerifyToken(user.id);
    await sendVerifyEmail(user.email, token, ctx.state.lang);  // [שונה: הוספת ctx.state.lang]
  } catch (e) {
    phase("verify.resend.error", String(e));
  }

  // Render notice page (same as after registration)
  await render(ctx, "verify_notice", {
    title: "שליחת אימות",
    page: "verify",
    info: "אם החשבון קיים, נשלח אליו כעת אימייל אימות נוסף.",
    resendUrl: `/auth/verify/resend?email=${encodeURIComponent(email)}`,
  });
});

// GET /auth/login - login page
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

// POST /auth/login - handle login submission
authRouter.post("/auth/login", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("login.input", { meta, keys: Object.keys(b) });

  const emailOrUser = lower(String((b as any).email ?? (b as any).username ?? ""));
  const password = String((b as any).password ?? "");
  if (!emailOrUser || !password) {
    phase("login.missing-fields");
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", {
      title: "התחברות", page: "login",
      error: "יש למלא דוא״ל/שם משתמש וסיסמה."
    });
    return;
  }

  const user = await findUserByEmail(emailOrUser) || await findUserByUsername(emailOrUser);
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  if (!user.emailVerified) {
    // חוסמים התחברות עד אימות
    const token = await createVerifyToken(user.id);
    try { 
      await sendVerifyEmail(user.email, token, ctx.state.lang);  // [שונה: הוספת ctx.state.lang]
    } catch {}
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "החשבון טרם אומת. שלחנו אליך שוב מייל לאימות – יש ללחוץ על קישור האימות ולאחר מכן להתחבר."
    });
    return;
  }

  // Verify password
  let ok = false;
  try {
    ok = await verifyPassword(password, user.password);
  } catch (e) {
    phase("login.verify.error", String(e));
  }
  if (!ok) {
    phase("login.bad-password");
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  // Mark user as logged in (persist session etc.)
  try {
    // deno-lint-ignore no-explicit-any
    const session = (ctx.state as any).session;
    if (session) {
      await session.set("userId", String(user.id));
      await session.set("firstName", user.firstName);
      await session.set("email", user.email);
      await session.set("lang", ctx.state.lang || "he");
      phase("login.session.set", { userId: user.id, lang: ctx.state.lang });
    }
  } catch (e) {
    phase("login.session.error", String(e));
  }

  // Redirect to home/dashboard after successful login
  ctx.response.status = Status.Found;
  ctx.response.redirect("/");
});

// GET /auth/logout - log out (destroy session)
authRouter.get("/auth/logout", async (ctx) => {
  try {
    // deno-lint-ignore no-explicit-any
    await (ctx.state as any).session?.delete();
    phase("logout.deleted");
  } catch (e) {
    phase("logout.error", String(e));
  }
  ctx.response.status = Status.Found;
  ctx.response.redirect("/");
});

// GET /auth/forgot - forgot password page
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot" });
});

// POST /auth/forgot - handle forgot-password submission
authRouter.post("/auth/forgot", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("forgot.input", { meta, keys: Object.keys(b) });

  const emailRaw = String((b as any).email ?? "");
  const email = lower(emailRaw);
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "יש להזין כתובת דוא״ל." });
    return;
  }

  const user = await findUserByEmail(email);
  let token: string | null = null;
  if (user) {
    // Create password-reset token (regardless of verified or not)
    try {
      token = await createResetToken(user.id);
    } catch (e) {
      phase("forgot.token.error", String(e));
    }
  }

  if (token && user) {
    try { 
      await sendResetEmail(email, token, ctx.state.lang);  // [שונה: הוספת ctx.state.lang]
    } catch (e) {
      phase("forgot.send.error", String(e));
    }
  }

  // Always respond with a generic message (to prevent email enumeration)
  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    info: "אם הדוא״ל קיים, נשלח קישור איפוס לכתובת זו."
  });
});

// GET /auth/reset - reset password form (user clicked email link)
authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  phase("reset.click", { token });

  // Minimal check: ensure token exists (full verification done on POST)
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "קישור האיפוס אינו תקין." });
    return;
  }

  await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

// POST /auth/reset - handle reset-password submission (from email link)
authRouter.post("/auth/reset", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("reset.input", { meta, keys: Object.keys(b) });

  const token = String((b as any).token ?? "");
  const password = String((b as any).password ?? "");
  const password2 = String((b as any).password2 ?? "");
  if (!token || !password || !password2) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "יש למלא את כל השדות." });
    return;
  }
  if (password !== password2) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "הסיסמאות אינן תואמות." });
    return;
  }

  // Verify token and update password
  let userId: string | null = null;
  if (token) {
    try {
      userId = await verifyResetToken(token);
      phase("reset.token.ok", { userId });
    } catch (e) {
      phase("reset.token.error", String(e));
    }
  }
  if (!userId) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "קישור האיפוס אינו תקין או שפג תוקפו." });
    return;
  }

  try {
    const hashed = await hashPassword(password);
    await updateUserPassword(userId, hashed);
    phase("reset.password.updated", { userId });
  } catch (e) {
    phase("reset.update.error", String(e));
    ctx.response.status = Status.InternalServerError;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "אירעה שגיאה בעדכון הסיסמה." });
    return;
  }

  // Success – render confirmation
  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    info: "הסיסמה אופסה בהצלחה! ניתן כעת להתחבר באמצעות הסיסמה החדשה."
  });
});
