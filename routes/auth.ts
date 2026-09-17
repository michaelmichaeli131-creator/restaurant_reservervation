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

const AUTH_I18N: Record<string, Record<string, string>> = {
  en: {
    staff_no_signup: "Staff sign-up is disabled. Ask the restaurant owner to create your account.",
    fill_required: "Please fill in all required fields",
    passwords_mismatch: "Passwords do not match",
    password_min_8: "Password must contain at least 8 characters",
    email_exists: "This email address already exists in the system",
    login_fill: "Please enter email and password",
    login_invalid: "Incorrect email or password",
    email_verify_required: "Email verification is required before logging in. We sent you another verification link.",
    account_disabled: "This account is disabled. Please contact support.",
    change_fill_all: "Please fill in all fields",
    current_password_wrong: "Current password is incorrect",
    password_updated: "Password updated successfully",
    bad_link: "Invalid link",
    bad_or_expired_link: "Invalid or expired link",
    provide_email: "Please provide an email address",
    verify_if_exists: "If the email exists in the system, a verification link has been sent.",
    account_already_verified: "The account is already verified. You can log in.",
    verify_resent: "A verification link has been resent to your email inbox.",
    enter_email: "Please enter an email address",
    reset_if_exists: "If the email exists in the system, a password reset link has been sent.",
    confirm_password_mismatch: "Password confirmation does not match",
    user_not_found: "User not found"
  },
  he: {
    staff_no_signup: "אין הרשמה לעובדים. פנה/י לבעל המסעדה כדי שיצור עבורך משתמש.",
    fill_required: "נא למלא את כל השדות החיוניים",
    passwords_mismatch: "הסיסמאות אינן תואמות",
    password_min_8: "הסיסמה צריכה להכיל לפחות 8 תווים",
    email_exists: "כתובת הדוא״ל כבר קיימת במערכת",
    login_fill: "נא להזין דוא״ל וסיסמה",
    login_invalid: "דוא״ל או סיסמה שגויים",
    email_verify_required: "נדרש אימות דוא״ל לפני התחברות. שלחנו לך קישור אימות נוסף.",
    account_disabled: "החשבון מבוטל. פנה/י לתמיכה.",
    change_fill_all: "נא למלא את כל השדות",
    current_password_wrong: "הסיסמה הנוכחית שגויה",
    password_updated: "הסיסמה עודכנה בהצלחה",
    bad_link: "קישור לא תקין",
    bad_or_expired_link: "קישור לא תקין או שפג תוקף",
    provide_email: "נא לספק כתובת דוא״ל",
    verify_if_exists: "אם הדוא״ל קיים במערכת – נשלח קישור אימות.",
    account_already_verified: "החשבון כבר מאומת. אפשר להתחבר.",
    verify_resent: "קישור אימות נשלח מחדש לתיבת הדוא״ל.",
    enter_email: "נא להזין דוא״ל",
    reset_if_exists: "אם הדוא״ל קיים במערכת, נשלח קישור לאיפוס סיסמה.",
    confirm_password_mismatch: "אימות סיסמה לא תואם",
    user_not_found: "משתמש לא נמצא"
  },
  ka: {
    staff_no_signup: "პერსონალისთვის თვითრეგისტრაცია გამორთულია. სთხოვეთ რესტორნის მფლობელს, შეგიქმნათ ანგარიში.",
    fill_required: "გთხოვთ, შეავსოთ ყველა სავალდებულო ველი",
    passwords_mismatch: "პაროლები არ ემთხვევა",
    password_min_8: "პაროლი უნდა შეიცავდეს მინიმუმ 8 სიმბოლოს",
    email_exists: "ეს ელ-ფოსტა უკვე გამოყენებულია.",
    login_fill: "გთხოვთ, შეიყვანოთ ელ-ფოსტა და პაროლი",
    login_invalid: "ელ-ფოსტა ან პაროლი არასწორია",
    email_verify_required: "შესვლამდე საჭიროა ელ-ფოსტის დადასტურება. ახალი ბმული უკვე გამოგიგზავნეთ.",
    account_disabled: "ეს ანგარიში გამორთულია. გთხოვთ, დაუკავშირდეთ მხარდაჭერას.",
    change_fill_all: "გთხოვთ, შეავსოთ ყველა ველი",
    current_password_wrong: "მიმდინარე პაროლი არასწორია",
    password_updated: "პაროლი წარმატებით განახლდა",
    bad_link: "არასწორი ბმული",
    bad_or_expired_link: "ბმული არასწორია ან ვადა გაუვიდა.",
    provide_email: "გთხოვთ, მიუთითოთ ელ-ფოსტის მისამართი",
    verify_if_exists: "თუ ეს ელ-ფოსტა ჩვენს სისტემაშია, დამადასტურებელი ბმული უკვე გამოგზავნილია.",
    account_already_verified: "ანგარიში უკვე დადასტურებულია. შეგიძლიათ შეხვიდეთ.",
    verify_resent: "დამადასტურებელი ბმული ხელახლა გამოგიგზავნეთ.",
    enter_email: "გთხოვთ, შეიყვანოთ ელ-ფოსტა",
    reset_if_exists: "თუ ეს ელ-ფოსტა ჩვენს სისტემაშია, პაროლის აღდგენის ბმული უკვე გამოგზავნილია.",
    confirm_password_mismatch: "პაროლის დადასტურება არ ემთხვევა",
    user_not_found: "მომხმარებელი ვერ მოიძებნა"
  }
};

function authMsg(ctx: any, key: string): string {
  const lang = String(ctx.state?.lang || 'en');
  return AUTH_I18N[lang]?.[key] || AUTH_I18N.en[key] || key;
}

function requireLoggedIn(ctx: any): boolean {
  const user = ctx.state?.user;
  if (!user) {
    const redirect = "/auth/login?redirect=" +
      encodeURIComponent(ctx.request.url.pathname);
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", redirect);
    return false;
  }
  return true;
}

/* ---------------- Utils ---------------- */

const lower = (s: string) => s.trim().toLowerCase();

function pageTitle(ctx: any, key: string, fb: string): string {
  const t = (ctx.state as any)?.t;
  if (typeof t === 'function') {
    const s = t(key);
    if (s && s !== key && s !== `(${key})`) return s;
  }
  return fb;
}

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
    title: pageTitle(ctx, "page_titles.register", "הרשמה"),
    page: "register",
  });
});

authRouter.post("/auth/register", async (ctx) => {
  const b = await readForm(ctx);

  const firstName = String(b.firstName ?? "").trim();
  const lastName = String(b.lastName ?? "").trim();
  const email = lower(String(b.email ?? ""));
  const password = String(b.password ?? "");
  const confirm = String(b.confirm ?? b.passwordConfirm ?? "");
  const businessType = String(b.businessType ?? "").trim();
  const phone = String(b.phone ?? "").trim();

  // סוג חשבון ציבורי: customer / owner בלבד
  const rawAccountType = String(b.accountType ?? "").trim();
  if (rawAccountType === "staff") {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: pageTitle(ctx, "page_titles.register", "הרשמה"),
      page: "register",
      error: authMsg(ctx, "staff_no_signup"),
      prefill: {
        firstName,
        lastName,
        email,
        businessType,
        phone,
        accountType: "owner",
      },
    });
    return;
  }

  const accountType: "customer" | "owner" =
    rawAccountType === "customer" ? "customer" : "owner";

  const prefill = { firstName, lastName, email, businessType, phone, accountType };

  if (!firstName || !lastName || !email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: pageTitle(ctx, "page_titles.register", "הרשמה"),
      page: "register",
      error: authMsg(ctx, "fill_required"),
      prefill,
    });
    return;
  }

  // אימות סיסמה מול confirm (הטופס שולח confirm)
  if (confirm && password !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: pageTitle(ctx, "page_titles.register", "הרשמה"),
      page: "register",
      error: authMsg(ctx, "passwords_mismatch"),
      prefill,
    });
    return;
  }

  if (password.length < 8) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: pageTitle(ctx, "page_titles.register", "הרשמה"),
      page: "register",
      error: authMsg(ctx, "password_min_8"),
      prefill,
    });
    return;
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: pageTitle(ctx, "page_titles.register", "הרשמה"),
      page: "register",
      error: authMsg(ctx, "email_exists"),
      prefill,
    });
    return;
  }

  const passwordHash = await hashPassword(password);

  // מיפוי accountType → user.role
  // customer → user, owner → owner
  const targetRole: "user" | "owner" = accountType === "customer" ? "user" : "owner";

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

  // אין הרשמה ציבורית לעובדים — יצירת StaffMember מתבצעת רק ע"י בעלים מתוך /owner/staff

  const token = await createVerifyToken(created.id);
  const lang = (ctx.state?.lang as string | undefined) ?? "he";

  try {
    await sendVerifyEmail(created.email, token, lang);
  } catch (e) {
    console.error("[auth.register] sendVerifyEmail failed:", e);
  }

  // כאן אין info – הטקסט מגיע מ-i18n (auth.verify.info.before)
  await render(ctx, "verify_notice", {
    title: pageTitle(ctx, "page_titles.verify_email", "בדיקת דוא״ל"),
    page: "verify",
    email: created.email,
    resendUrl:
      `/auth/verify/resend?email=${encodeURIComponent(created.email)}`,
  });
});

/* ---------------- Login ---------------- */

authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", {
    title: pageTitle(ctx, "page_titles.login", "התחברות"),
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
      title: pageTitle(ctx, "page_titles.login", "התחברות"),
      page: "login",
      error: authMsg(ctx, "login_fill"),
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: pageTitle(ctx, "page_titles.login", "התחברות"),
      page: "login",
      error: authMsg(ctx, "login_invalid"),
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
      title: pageTitle(ctx, "page_titles.login", "התחברות"),
      page: "login",
      error:
        authMsg(ctx, "email_verify_required"),
      verifyResend: true,
    });
    return;
  }

  if (user.isActive === false) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: pageTitle(ctx, "page_titles.login", "התחברות"),
      page: "login",
      error: authMsg(ctx, "account_disabled"),
    });
    return;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: pageTitle(ctx, "page_titles.login", "התחברות"),
      page: "login",
      error: authMsg(ctx, "login_invalid"),
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



/* ---------------- Change password (logged-in) ---------------- */

authRouter.get("/auth/change-password", async (ctx) => {
  if (!requireLoggedIn(ctx)) return;

  await render(ctx, "auth/change_password", {
    title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
    page: "change_password",
  });
});

authRouter.post("/auth/change-password", async (ctx) => {
  if (!requireLoggedIn(ctx)) return;

  const user = ctx.state.user as any;
  const b = await readForm(ctx);

  const currentPassword = String(b.currentPassword ?? "");
  const newPassword = String(b.newPassword ?? "");
  const confirm = String(b.confirm ?? b.passwordConfirm ?? "");

  // Google / חשבונות ללא סיסמה
  if (user?.provider !== "local" || !user?.passwordHash) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/change_password", {
      title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
      page: "change_password",
      error:
        "החשבון שלך אינו משתמש בסיסמה מקומית (למשל התחברות עם Google). אין אפשרות לשנות סיסמה כאן.",
    });
    return;
  }

  if (!currentPassword || !newPassword || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/change_password", {
      title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
      page: "change_password",
      error: authMsg(ctx, "change_fill_all"),
    });
    return;
  }

  if (newPassword.length < 8) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/change_password", {
      title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
      page: "change_password",
      error: authMsg(ctx, "password_min_8"),
    });
    return;
  }

  if (newPassword !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/change_password", {
      title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
      page: "change_password",
      error: authMsg(ctx, "passwords_mismatch"),
    });
    return;
  }

  // וידוא סיסמה נוכחית
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/change_password", {
      title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
      page: "change_password",
      error: authMsg(ctx, "current_password_wrong"),
    });
    return;
  }

  const newHash = await hashPassword(newPassword);
  await updateUserPassword(user.id, newHash);

  // עדכון אובייקט המשתמש ב-ctx.state כך שבאותה בקשה/רינדור הוא מעודכן
  try {
    (ctx.state.user as any).passwordHash = newHash;
  } catch {
    // ignore
  }

  await render(ctx, "auth/change_password", {
    title: pageTitle(ctx, "page_titles.change_password", "שינוי סיסמה"),
    page: "change_password",
    info: authMsg(ctx, "password_updated"),
  });
});



/* ---------------- Email verify ---------------- */

authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";

  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", {
      title: pageTitle(ctx, "page_titles.verify", "אימות דוא״ל"),
      page: "verify",
      infoKey: "auth.verify.info.linkInvalid",             // ⭐
      info: authMsg(ctx, "bad_link"),
    });
    return;
  }

  const record = await useVerifyToken(token);
  if (!record) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "verify_notice", {
      title: pageTitle(ctx, "page_titles.verify", "אימות דוא״ל"),
      page: "verify",
      infoKey: "auth.verify.info.linkInvalidOrExpired",    // ⭐
      info: authMsg(ctx, "bad_or_expired_link"),
    });
    return;
  }

  await setEmailVerified(record.userId);

  // כאן שוב אין info – הטקסט מגיע מ-i18n (auth.verify.info.after)
  await render(ctx, "verify_notice", {
    title: pageTitle(ctx, "page_titles.verify", "אימות דוא״ל"),
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
      title: pageTitle(ctx, "page_titles.resend_verify", "שליחת אימות"),
      page: "verify",
      infoKey: "auth.verify.info.needEmail",               // ⭐
      info: authMsg(ctx, "provide_email"),
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    // לא חושפים אם המשתמש קיים
    await render(ctx, "verify_notice", {
      title: pageTitle(ctx, "page_titles.resend_verify", "שליחת אימות"),
      page: "verify",
      infoKey: "auth.verify.info.maybeExists",             // ⭐
      info: authMsg(ctx, "verify_if_exists"),
    });
    return;
  }

  if (user.emailVerified) {
    await render(ctx, "verify_notice", {
      title: pageTitle(ctx, "page_titles.resend_verify", "שליחת אימות"),
      page: "verify",
      infoKey: "auth.verify.info.alreadyVerified",         // ⭐
      info: authMsg(ctx, "account_already_verified"),
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
    title: pageTitle(ctx, "page_titles.resend_verify", "שליחת אימות"),
    page: "verify",
    infoKey: "auth.verify.info.resent",                   // ⭐
    info: authMsg(ctx, "verify_resent"),
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
      error: authMsg(ctx, "enter_email"),
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
    info: authMsg(ctx, "reset_if_exists"),
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
      error: authMsg(ctx, "bad_link"),
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
      error: authMsg(ctx, "change_fill_all"),
    });
    return;
  }

  if (pw !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: authMsg(ctx, "confirm_password_mismatch"),
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
      error: authMsg(ctx, "bad_or_expired_link"),
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
      error: authMsg(ctx, "user_not_found"),
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
