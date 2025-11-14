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

/* ---------------- Debug helpers ---------------- */
function phase(name: string, data?: unknown) {
  try { debugLog(`[auth] ${name}`, data ?? ""); } catch {}
}
function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }
function trim(s?: string)  { return (s ?? "").trim(); }
function entriesToObject(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}
function formDataToObject(formData: FormData): Record<string, string> {
  return entriesToObject(formData.entries());
}
async function readBody(ctx: any): Promise<{ data: Record<string, unknown>; meta: Record<string, unknown> }> {
  const body = ctx.request.body({ type: "form-data" });
  const form = await body.value.read({ maxSize: 2_000_000 });
  const data = form.fields as Record<string, unknown>;
  return { data, meta: { ...form, fields: undefined } };
}

/* ---------------- Router ---------------- */
const authRouter = new Router();

/* --------- Register --------- */
authRouter.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", { title: "הרשמה", page: "register" });
});

authRouter.post("/auth/register", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("register.input", { meta, keys: Object.keys(b) });

  const username    = trim((b as any).username);
  const email       = lower((b as any).email);
  const password    = String((b as any).password ?? "");
  const firstName   = trim((b as any).firstName ?? (b as any).fullname ?? (b as any)["first_name"]);
  const lastNameRaw = trim((b as any).lastName  ?? (b as any)["last_name"]);
  const lastName    = lastNameRaw || (firstName ? "-" : ""); // lastName optional; if firstName given and last not – use dash.
  const phone       = trim((b as any).phone ?? "");
  const businessTypeRaw = trim((b as any).businessType ?? (b as any)["business_type"]);
  const businessType = businessTypeRaw || undefined;

  if (!username || !email || !password || !firstName) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register",
      error: "יש למלא את כל השדות הדרושים (שם משתמש, שם פרטי, דוא״ל וסיסמה)" });
    return;
  }
  if ((b as any).tos !== "on") {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register",
      error: "עליך לאשר את תנאי השימוש בכדי להירשם למערכת" });
    return;
  }

  // בדיקות ייחודיות
  if (await findUserByUsername(username)) {
    ctx.response.status = Status.Conflict;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register",
      error: "שם משתמש זה כבר תפוס, אנא בחר שם אחר." });
    return;
  }
  if (await findUserByEmail(email)) {
    ctx.response.status = Status.Conflict;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register",
      error: "כתובת דוא״ל זו כבר רשומה במערכת. ניתן לאפס סיסמה אם שכחת." });
    return;
  }

  const user: Partial<User> = {
    firstName, lastName, email,
    businessType, phone,
    provider: "local",
    role: "owner",
  };

  const hash = await hashPassword(password);
  const created = await createUser({ ...(user as User), passwordHash: hash } as any);
  phase("register.created", { userId: created.id });

  // שליחת אימות (המייל יישלח בשפת הממשק הנוכחית)
  const token = await createVerifyToken(created.id);
  try {
    await sendVerifyEmail(created.email, token, ctx.state.lang);
    phase("register.verify.sent", { email: created.email });
  } catch (e) {
    phase("register.verify.error", String(e));
  }

  // אין התחברות! דורשים אימות קודם
  await render(ctx, "verify_notice", {
    title: "בדיקת דוא״ל",
    page: "verify",
    info: "נשלח קישור אימות לכתובת הדוא״ל. יש ללחוץ על הקישור כדי להשלים את ההרשמה.",
    email: created.email,
    resendUrl: `/auth/verify/resend?email=${encodeURIComponent(created.email)}`,
  });
});

/* --------- Login --------- */
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

authRouter.post("/auth/login", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("login.input", { meta, keys: Object.keys(b) });

  const emailOrUser = lower(String((b as any).email ?? (b as any).username ?? ""));
  const password = String((b as any).password ?? "");

  if (!emailOrUser || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { title: "התחברות", page: "login",
      error: "נא למלא דוא״ל/שם משתמש וסיסמה" });
    return;
  }

  const user = await findUserByEmail(emailOrUser) || await findUserByUsername(emailOrUser);
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login",
      error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  if (!user.emailVerified) {
    // חוסמים התחברות עד אימות
    const token = await createVerifyToken(user.id);
    // שליחת מייל אימות נוסף בשפת הממשק הנוכחית
    try {
      await sendVerifyEmail(user.email, token, ctx.state.lang);
    } catch {}
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "נדרש אימות דוא״ל לפני התחברות. שלחנו לך קישור אימות נוסף.",
      verifyResend: true,
    });
    return;
  }

  if (user.isActive === false) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "החשבון מבוטל. פנה/י לתמיכה.",
    });
    return;
  }

  // ... (logic for successful login, setting session, etc.)

  // הפניה לאחר התחברות מוצלחת
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* --------- Verify (email confirmation after registration) --------- */
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing token";
    return;
  }
  const used = await useVerifyToken(token);
  if (!used) {
    // invalid or expired token
    await render(ctx, "verify_notice", {
      title: "אימות משתמש",
      page: "verify",
      error: "קוד אימות לא תקין או שפג תוקפו. יש לבצע הרשמה מחדש.",
    });
    return;
  }

  // לאחר אימות – מחברים אוטומטית
  const session = (ctx.state as any)?.session;
  try { if (session?.set) await session.set("userId", used.userId); } catch {}

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?verified=1");
});

/* --------- Resend verification --------- */
authRouter.get("/auth/verify/resend", async (ctx) => {
  const email = lower(ctx.request.url.searchParams.get("email") || "");
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      error: "חסר דוא״ל לשליחת קישור אימות"
    });
    return;
  }
  const user = await findUserByEmail(email);
  if (!user) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      info: "אם הדוא״ל קיים — נשלח קישור אימות."
    });
    return;
  }
  if (user.emailVerified) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      info: "החשבון כבר מאומת. אפשר להתחבר."
    });
    return;
  }
  const token = await createVerifyToken(user.id);
  // שליחת מייל אימות חוזר בשפת הממשק הנוכחית
  try {
    await sendVerifyEmail(user.email, token, ctx.state.lang);
  } catch (e) {
    phase("verify.resend.error", String(e));
  }
  await render(ctx, "verify_notice", {
    title: "שליחת אימות",
    page: "verify",
    info: "קישור אימות נשלח מחדש לתיבת הדוא״ל."
  });
});

/* --------- Forgot / Reset --------- */
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot" });
});

authRouter.post("/auth/forgot", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("forgot.input", { meta, keys: Object.keys(b) });

  const email = lower(String((b as any).email ?? ""));
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", {
      title: "שכחתי סיסמה",
      page: "forgot",
      error: "נא להזין דוא״ל"
    });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    // שליחת מייל איפוס סיסמה בשפת הממשק הנוכחית
    try {
      await sendResetEmail(email, token, ctx.state.lang);
    } catch (e) {
      phase("forgot.send.error", String(e));
    }
  }
  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    info: "אם הדוא״ל קיים, נשלח קישור איפוס"
  });
});

authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "forgot",
      error: "קישור לא תקין או שפג תוקפו."
    });
    return;
  }
  // ... (handling of reset token verification and showing reset form)
});

authRouter.post("/auth/reset", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("reset.input", { meta, keys: Object.keys(b) });

  const token = String((b as any).token ?? ctx.request.url.searchParams.get("token") ?? "");
  const password = String((b as any).password ?? "");
  if (!token || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "forgot",
      error: "קוד או סיסמה חסרים"
    });
    return;
  }
  const used = await useResetToken(token);
  if (!used) {
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "forgot",
      error: "קוד איפוס לא תקין או שפג תוקפו"
    });
    return;
  }

  // ממשיכים לעדכון הסיסמה...
  const hash = await hashPassword(password);
  await updateUserPassword(used.userId, hash);

  ctx.response.headers.set("Location", "/?reset=1");
  ctx.response.status = Status.SeeOther;
});

export default authRouter;
