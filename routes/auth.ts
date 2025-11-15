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

const router = new Router();
export { router as authRouter };

/** Helper קטן לקריאת form ב-Oak */
async function getForm(ctx: any): Promise<URLSearchParams> {
  const body = ctx.request.body({ type: "form" });
  const form = await body.value;
  return form as URLSearchParams;
}

/* ---------------- Debug helpers ---------------- */

router.get("/auth/debug/users", async (ctx) => {
  ctx.response.status = Status.NotFound;
  ctx.response.body = "Not Implemented";
});

/* ---------------- Router ---------------- */

/* --------- Register --------- */

router.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", {
    title: "הרשמה",
    page: "register",
  });
});

router.post("/auth/register", async (ctx) => {
  const form = await getForm(ctx);

  const firstName = String(form.get("firstName") ?? "").trim();
  const lastName = String(form.get("lastName") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const passwordConfirm = String(form.get("passwordConfirm") ?? "");
  const businessType = String(form.get("businessType") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();

  const commonProps = {
    title: "הרשמה",
    page: "register",
    firstName,
    lastName,
    email,
    businessType,
    phone,
  };

  if (!firstName || !lastName || !email || !password || !passwordConfirm) {
    await render(ctx, "auth/register", {
      ...commonProps,
      error: "נא למלא את כל השדות",
    });
    ctx.response.status = Status.BadRequest;
    return;
  }

  if (password.length < 8) {
    await render(ctx, "auth/register", {
      ...commonProps,
      error: "הסיסמה צריכה להכיל לפחות 8 תווים",
    });
    ctx.response.status = Status.BadRequest;
    return;
  }

  if (password !== passwordConfirm) {
    await render(ctx, "auth/register", {
      ...commonProps,
      error: "אימות הסיסמה אינו תואם",
    });
    ctx.response.status = Status.BadRequest;
    return;
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    await render(ctx, "auth/register", {
      ...commonProps,
      error: "כתובת דוא״ל זו כבר רשומה במערכת",
    });
    ctx.response.status = Status.BadRequest;
    return;
  }

  const passwordHash = await hashPassword(password);

  const user: User = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    email,
    username: email,
    passwordHash,
    firstName,
    lastName,
    businessType,
    phone,
    role: "owner",
    emailVerified: false,
    isActive: true,
  };

  await createUser(user);
  debugLog("auth.register.created", { id: user.id, email: user.email });

  const token = await createVerifyToken(user.id);

  try {
    await sendVerifyEmail(user.email, token, (ctx.state as any).lang);
    debugLog("auth.register.verify.sent", { email: user.email });
  } catch (e) {
    debugLog("auth.register.verify.error", String(e));
  }

  await render(ctx, "verify_notice", {
    title: "בדיקת דוא״ל",
    page: "verify",
    info:
      "נשלח קישור אימות לכתובת הדוא״ל. יש ללחוץ על הקישור כדי להשלים את ההרשמה.",
    email: user.email,
    resendUrl: `/auth/verify/resend?email=${encodeURIComponent(user.email)}`,
  });
});

/* --------- Login --------- */

router.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", {
    title: "התחברות",
    page: "login",
  });
});

router.post("/auth/login", async (ctx) => {
  const form = await getForm(ctx);

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const redirectParam = String(form.get("redirect") ?? "").trim();

  const commonProps = {
    title: "התחברות",
    page: "login",
    email,
  };

  if (!email || !password) {
    await render(ctx, "auth/login", {
      ...commonProps,
      error: "נא להזין דוא״ל וסיסמה",
    });
    ctx.response.status = Status.BadRequest;
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    await render(ctx, "auth/login", {
      ...commonProps,
      error: "דוא״ל או סיסמה שגויים",
    });
    ctx.response.status = Status.Unauthorized;
    return;
  }

  if (!user.emailVerified) {
    const token = await createVerifyToken(user.id);
    try {
      await sendVerifyEmail(user.email, token, (ctx.state as any).lang);
    } catch {
      // לא מפילים בגלל כשל בשליחת מייל
    }
    await render(ctx, "auth/login", {
      ...commonProps,
      error: "נדרש אימות דוא״ל לפני התחברות. שלחנו לך קישור אימות נוסף.",
      verifyResend: true,
    });
    ctx.response.status = Status.Forbidden;
    return;
  }

  if (user.isActive === false) {
    await render(ctx, "auth/login", {
      ...commonProps,
      error: "החשבון מבוטל. פנה/י לתמיכה.",
    });
    ctx.response.status = Status.Forbidden;
    return;
  }

  const ok = await verifyPassword(password, user.passwordHash ?? "");
  if (!ok) {
    await render(ctx, "auth/login", {
      ...commonProps,
      error: "דוא״ל או סיסמה שגויים",
    });
    ctx.response.status = Status.Unauthorized;
    return;
  }

  const session = (ctx.state as any).session;
  if (session) {
    await session.set("userId", user.id);
  }
  debugLog("auth.login.success", { userId: user.id, email: user.email });

  const redirect = redirectParam || "/owner";
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", redirect);
});

/* --------- Logout --------- */

router.post("/auth/logout", async (ctx) => {
  const session = (ctx.state as any).session;
  if (session) {
    try {
      await session.set("userId", null);
    } catch {
      // ignore
    }
  }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* --------- Email Verify (complete) --------- */

router.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", {
      title: "אימות דוא״ל",
      page: "verify",
      info: "קישור לא תקין",
    });
    return;
  }

  const record = await useVerifyToken(token);
  if (!record) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "verify_notice", {
      title: "אימות דוא״ל",
      page: "verify",
      info: "קישור לא תקין או שפג תוקף",
    });
    return;
  }

  const user = await setEmailVerified(record.userId);
  debugLog("auth.verify.complete", {
    userId: user.id,
    email: user.email,
  });

  await render(ctx, "verify_notice", {
    title: "אימות דוא״ל",
    page: "verify",
    info: "האימייל אומת בהצלחה! אפשר כעת להתחבר.",
    postVerify: true,
  });
});

/* --------- Resend verification --------- */

router.get("/auth/verify/resend", async (ctx) => {
  const emailParam = ctx.request.url.searchParams.get("email") ?? "";
  const email = emailParam.trim().toLowerCase();

  if (!email) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      info: "נא לספק כתובת דוא״ל",
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      info: "אם הדוא״ל קיים במערכת – נשלח קישור אימות.",
    });
    return;
  }

  if (user.emailVerified) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      info: "החשבון כבר מאומת. אפשר להתחבר.",
    });
    return;
  }

  const token = await createVerifyToken(user.id);
  try {
    await sendVerifyEmail(user.email, token, (ctx.state as any).lang);
  } catch (e) {
    debugLog("auth.verify.resend.error", String(e));
  }

  await render(ctx, "verify_notice", {
    title: "שליחת אימות",
    page: "verify",
    info: "קישור אימות נשלח מחדש לתיבת הדוא״ל.",
  });
});

/* --------- Forgot / Reset --------- */

router.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
  });
});

router.post("/auth/forgot", async (ctx) => {
  const form = await getForm(ctx);
  const email = String(form.get("email") ?? "").trim().toLowerCase();

  if (!email) {
    await render(ctx, "auth/forgot", {
      title: "שכחתי סיסמה",
      page: "forgot",
      error: "נא להזין דוא״ל",
    });
    ctx.response.status = Status.BadRequest;
    return;
  }

  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    try {
      await sendResetEmail(email, token, (ctx.state as any).lang);
    } catch (e) {
      debugLog("auth.forgot.send.error", String(e));
    }
  }

  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    info: "אם הדוא״ל קיים במערכת, נשלח קישור לאיפוס סיסמה.",
  });
});

router.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      error: "קישור לא תקין",
    });
    return;
  }

  await render(ctx, "auth/reset", {
    title: "איפוס סיסמה",
    page: "reset",
    token,
  });
});

router.post("/auth/reset", async (ctx) => {
  const form = await getForm(ctx);

  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm =
    String(form.get("confirm") ?? form.get("passwordConfirm") ?? "");

  if (!token || !password || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: "נא למלא את כל השדות",
    });
    return;
  }

  if (password !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: "אימות סיסמה לא תואם",
    });
    return;
  }

  const record = await useResetToken(token);
  if (!record) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: "קישור לא תקין או שפג תוקף",
    });
    return;
  }

  const user = await findUserByEmail(record.email);
  if (!user) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: "משתמש לא נמצא",
    });
    return;
  }

  const passwordHash = await hashPassword(password);
  await updateUserPassword(user.id, passwordHash);
  debugLog("auth.reset.success", { userId: user.id, email: user.email });

  await render(ctx, "auth/reset", {
    title: "איפוס סיסמה",
    page: "reset",
    success: true,
  });
});
