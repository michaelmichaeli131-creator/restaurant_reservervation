// src/routes/auth.ts
// ----------------------
// Auth routes: register, login, logout, verify, forgot/reset
// ללא dal/, ללא phase, ללא rate_limit – רק מה שקיים בפועל בפרויקט שלך.
// מותאם ל-Oak 17 + Deno Deploy.
// ----------------------

import { Router, Status } from "jsr:@oak/oak";

import {
  createUser,
  findUserByEmail,
  createVerifyToken,
  createResetToken,
  useVerifyToken,
  useResetToken,
  setEmailVerified,
  updateUserPassword,
  getUserById,
} from "../database.ts";

import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { render } from "../lib/view.ts";
// עטיפות האימיילים עם תמיכה בשפה
import { sendVerifyEmail, sendResetEmail } from "../lib/mail_wrappers.ts";

export const authRouter = new Router();

/* ---------------- Utils ---------------- */

const lower = (s: string) => s.trim().toLowerCase();

/**
 * קריאת form בצורה שתעבוד גם עם Oak 17 (ctx.request.body.form())
 * וגם עם סביבות אחרות (fallback ל-formData אם קיים).
 */
async function readForm(ctx: any): Promise<Record<string, string>> {
  const req: any = ctx.request as any;

  // 🔹 קודם כל – API החדש של Oak 17: ctx.request.body.form()
  try {
    const body = req.body;
    if (body && typeof body.form === "function") {
      const form = await body.form();
      const out: Record<string, string> = {};

      if (form && typeof form.entries === "function") {
        for (const [k, v] of form.entries()) {
          out[k] = typeof v === "string" ? v : String(v);
        }
      } else if (form && typeof form === "object") {
        for (const [k, v] of Object.entries(form)) {
          out[k] = String(v);
        }
      }
      return out;
    }
  } catch (e) {
    console.warn("[auth.readForm] body.form() failed", e);
  }

  // 🔹 fallback – ניסיון להשתמש ב-Request.formData() אם יש originalRequest
  try {
    const rawReq: any = (req as any).originalRequest ?? req;
    if (rawReq && typeof rawReq.formData === "function") {
      const fd = await rawReq.formData();
      const out: Record<string, string> = {};
      for (const [k, v] of fd.entries()) {
        out[k] = typeof v === "string" ? v : String(v);
      }
      return out;
    }
  } catch (e) {
    console.warn("[auth.readForm] rawReq.formData() failed", e);
  }

  // אם שום דבר לא עבד – נחזיר אובייקט ריק
  return {};
}

/* ---------------- Register ---------------- */

authRouter.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", {
    title: "הרשמה",
    page: "register",
  });
});

authRouter.post("/auth/register", async (ctx) => {
  const b = await readForm(ctx);

  const firstName = String(b.firstName ?? "").trim();
  const lastName = String(b.lastName ?? "").trim();
  const email = lower(String(b.email ?? ""));
  const password = String(b.password ?? "");
  const businessType = String(b.businessType ?? "").trim();
  const phone = String(b.phone ?? "").trim();

  // 🔥 חדש – שדות סיווג חשבון
  const rawAccountType = String(b.accountType ?? "").trim();
  const accountType: "customer" | "owner" | "staff" =
    rawAccountType === "customer" || rawAccountType === "staff"
      ? (rawAccountType as any)
      : "owner";

  const staffRole = String(b.staffRole ?? "").trim();
  const staffRestaurantName = String(b.staffRestaurantName ?? "").trim();

  // אובייקט prefill שמתאים ל-register.eta החדש
  const prefill = {
    firstName,
    lastName,
    email,
    businessType,
    phone,
    accountType,
    staffRole,
    staffRestaurantName,
  };

  if (!firstName || !lastName || !email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "נא למלא את כל השדות החיוניים",
      prefill,
    });
    return;
  }

  // אם נרשם כעובד – חובה תפקיד + מסעדה
  if (accountType === "staff" && (!staffRole || !staffRestaurantName)) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "לעובדי מסעדה חובה לבחור תפקיד ולהזין לאיזו מסעדה אתה שייך.",
      prefill,
    });
    return;
  }

  if (password.length < 8) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "הסיסמה צריכה להכיל לפחות 8 תווים",
      prefill,
    });
    return;
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "כתובת הדוא״ל כבר קיימת במערכת",
      prefill,
    });
    return;
  }

  const passwordHash = await hashPassword(password);

  // מיפוי accountType → user.role
  // customer → user, owner → owner, staff → staff
  let targetRole: "user" | "owner" | "staff" | "manager";
  if (accountType === "customer") {
    targetRole = "user";
  } else if (accountType === "staff") {
    targetRole = "staff";
  } else {
    targetRole = "owner";
  }

  const created = await createUser({
    firstName,
    lastName,
    email,
    phone,
    businessType,
    passwordHash,
    role: targetRole as any, // createUser טייפ ישן ("user" | "owner") – גוררים ידנית
    provider: "local",
  } as any);

  // בשלב זה: גם לקוח וגם עובד צריכים אימות מייל, כמו בעלים.
  const token = await createVerifyToken(created.id);
  const lang = (ctx.state?.lang as string | undefined) ?? "he";

  try {
    await sendVerifyEmail(created.email, token, lang);
  } catch (e) {
    console.error("[auth.register] sendVerifyEmail failed:", e);
  }

  // כאן אין info – הטקסט מגיע מ-i18n (auth.verify.info.before)
  await render(ctx, "verify_notice", {
    title: "בדיקת דוא״ל",
    page: "verify",
    email: created.email,
    resendUrl:
      `/auth/verify/resend?email=${encodeURIComponent(created.email)}`,
  });
});

/* ---------------- Login ---------------- */

authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", {
    title: "התחברות",
    page: "login",
  });
});

authRouter.post("/auth/login", async (ctx) => {
  const b = await readForm(ctx);
  const email = lower(String(b.email ?? ""));
  const password = String(b.password ?? "");

  if (!email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "נא להזין דוא״ל וסיסמה",
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "דוא״ל או סיסמה שגויים",
    });
    return;
  }

  if (!user.emailVerified) {
    // שולחים אימייל אימות שוב ומונעים התחברות
    const token = await createVerifyToken(user.id);
    const lang = (ctx.state?.lang as string | undefined) ?? "he";
    try {
      await sendVerifyEmail(user.email, token, lang);
    } catch (e) {
      console.error("[auth.login] resend verify failed:", e);
    }
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error:
        "נדרש אימות דוא״ל לפני התחברות. שלחנו לך קישור אימות נוסף.",
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

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "דוא״ל או סיסמה שגויים",
    });
    return;
  }

  const session = (ctx.state as any).session;
  if (session) {
    await session.set("userId", user.id);
  }

  // שמרתי את ההתנהגות הקיימת כדי לא לשבור כלום:
  // admin → /admin, כל השאר → /owner
  ctx.response.redirect(user.role === "admin" ? "/admin" : "/owner");
});

/* ---------------- Logout ---------------- */

async function doLogout(ctx: any) {
  const session = (ctx.state as any).session;
  if (session) {
    await session.destroy();
  }
  ctx.response.redirect("/");
}

// תמיכה גם ב-POST (מכפתור/טופס) וגם ב-GET (מלינק פשוט)
authRouter.post("/auth/logout", doLogout);
authRouter.get("/auth/logout", doLogout);



/* ---------------- Email verify ---------------- */

authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";

  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", {
      title: "אימות דוא״ל",
      page: "verify",
      infoKey: "auth.verify.info.linkInvalid",             // ⭐
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
      infoKey: "auth.verify.info.linkInvalidOrExpired",    // ⭐
      info: "קישור לא תקין או שפג תוקף",
    });
    return;
  }

  await setEmailVerified(record.userId);

  // כאן שוב אין info – הטקסט מגיע מ-i18n (auth.verify.info.after)
  await render(ctx, "verify_notice", {
    title: "אימות דוא״ל",
    page: "verify",
    postVerify: true,
  });
});

/* ---------------- Resend verification ---------------- */

authRouter.get("/auth/verify/resend", async (ctx) => {
  const emailParam = ctx.request.url.searchParams.get("email") ?? "";
  const email = lower(emailParam);

  if (!email) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      infoKey: "auth.verify.info.needEmail",               // ⭐
      info: "נא לספק כתובת דוא״ל",
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    // לא חושפים אם המשתמש קיים
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      infoKey: "auth.verify.info.maybeExists",             // ⭐
      info: "אם הדוא״ל קיים במערכת – נשלח קישור אימות.",
    });
    return;
  }

  if (user.emailVerified) {
    await render(ctx, "verify_notice", {
      title: "שליחת אימות",
      page: "verify",
      infoKey: "auth.verify.info.alreadyVerified",         // ⭐
      info: "החשבון כבר מאומת. אפשר להתחבר.",
    });
    return;
  }

  const token = await createVerifyToken(user.id);
  const lang = (ctx.state?.lang as string | undefined) ?? "he";
  try {
    await sendVerifyEmail(user.email, token, lang);
  } catch (e) {
    console.error("[auth.verify.resend] send failed:", e);
  }

  await render(ctx, "verify_notice", {
    title: "שליחת אימות",
    page: "verify",
    infoKey: "auth.verify.info.resent",                   // ⭐
    info: "קישור אימות נשלח מחדש לתיבת הדוא״ל.",
  });
});

/* ---------------- Forgot / Reset password ---------------- */

authRouter.get("/auth/forgot", async (ctx) => {
  const email = ctx.request.url.searchParams.get("email") ?? "";
  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    prefill: email ? { email } : undefined,
  });
});

authRouter.post("/auth/forgot", async (ctx) => {
  const b = await readForm(ctx);
  const rawEmail = String(b.email ?? "");
  const email = lower(rawEmail);

  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", {
      title: "שכחתי סיסמה",
      page: "forgot",
      error: "נא להזין דוא״ל",
      prefill: { email: rawEmail }, // כדי שהשדה יישאר מלא
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    const lang = (ctx.state?.lang as string | undefined) ?? "he";
    try {
      await sendResetEmail(email, token, lang);
    } catch (e) {
      console.error("[auth.forgot] sendResetEmail failed:", e);
    }
  }

  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    info: "אם הדוא״ל קיים במערכת, נשלח קישור לאיפוס סיסמה.",
    // אפשר גם להוסיף infoKey אם תרצה, אבל נפתור את זה ב-ETA דרך i18n קבועה
  });
});

authRouter.get("/auth/reset", async (ctx) => {
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

authRouter.post("/auth/reset", async (ctx) => {
  const b = await readForm(ctx);

  const token = String(b.token ?? "");
  const pw = String(b.password ?? "");
  const confirm = String(
    b.confirm ?? b.passwordConfirm ?? "",
  );

  if (!token || !pw || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: "נא למלא את כל השדות",
    });
    return;
  }

  if (pw !== confirm) {
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

  const user = await getUserById(record.userId);
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

  const passwordHash = await hashPassword(pw);
  await updateUserPassword(user.id, passwordHash);

  await render(ctx, "auth/reset", {
    title: "איפוס סיסמה",
    page: "reset",
    success: true,
  });
});
