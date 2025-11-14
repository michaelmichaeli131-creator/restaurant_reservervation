import { Router } from "jsr:@oak/router";
import { Status } from "jsr:@oak/http_status";
import {
  createUser,
  findUserByEmail,
  markUserVerified,
} from "../dal/users.ts";
import {
  createVerifyToken,
  createResetToken,
  findUserByToken,
  deleteToken,
} from "../dal/tokens.ts";
import { lower, randomPassword, readBody } from "../lib/util.ts";
import { hashPassword, verifyPassword } from "../lib/crypto.ts";
import { authorize } from "../middleware/auth.ts";
import { ensureAdmin } from "../middleware/ensure_admin.ts";
import { ensureOwner } from "../middleware/ensure_owner.ts";
import { getDefaultRestaurant } from "../dal/restaurants.ts";
import { addOwnerToRestaurant } from "../dal/relations.ts";
import { render } from "../lib/view.ts";
import { authRateLimitByIP } from "../middleware/rate_limit.ts";
import { initOwnerViews } from "../dal/owner_init.ts";
import { getOwnerCalendarUrl } from "../lib/url.ts";
import { phase } from "../lib/phase.ts";
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";  // ייבוא הפונקציות לשליחת אימייל

export const authRouter = new Router();

/* ---------------- Debug helpers ---------------- */

// ... קטעי קוד לא רלוונטיים לקיצור ...

/* ---------------- Router ---------------- */

/* --------- Register --------- */
authRouter.post("/auth/register", authRateLimitByIP, async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("register.input", { meta, keys: Object.keys(b) });

  // איסוף נתוני משתמש מהגוף
  const firstName   = String((b as any).firstName  ?? "").trim();
  const lastName    = String((b as any).lastName   ?? "").trim();
  const email       = lower(String((b as any).email    ?? ""));
  const password    = String((b as any).password  ?? "");
  const businessType= String((b as any).businessType ?? "").trim();
  const phone       = String((b as any).phone     ?? "").trim();

  // בדיקות אימות נתונים בסיסיות
  if (!firstName || !lastName || !email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "נא למלא את כל השדות",
      firstName, lastName, email, businessType, phone,
    });
    return;
  }
  if (password.length < 8) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "הסיסמה צריכה להכיל לפחות 8 תווים",
      firstName, lastName, email, businessType, phone,
    });
    return;
  }

  // יצירת אובייקט משתמש
  const user: Partial<User> = {
    firstName, lastName, email,
    businessType, phone,
    provider: "local",
    role: "owner",
  };

  const hash = await hashPassword(password);
  const created = await createUser({ ...(user as User), passwordHash: hash } as any);
  phase("register.created", { userId: created.id });

  // שליחת אימייל אימות
  const token = await createVerifyToken(created.id);
  try { 
    await sendVerifyEmail(created.email, token, ctx.state.lang) /* הוספת פרמטר שפה */; 
    phase("register.verify.sent", { email: created.email }); 
  }
  catch (e) { 
    phase("register.verify.error", String(e)); 
  }

  // אין התחברות אוטומטית – דורשים אימות קודם
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

  const email = lower(String((b as any).email ?? ""));
  const password = String((b as any).password ?? "");
  if (!email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { 
      title: "התחברות", page: "login", 
      error: "נא להזין דוא״ל וסיסמה" 
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { 
      title: "התחברות", page: "login", 
      error: "דוא״ל או סיסמה שגויים" 
    });
    return;
  }

  if (!user.emailVerified) {
    // חוסמים התחברות עד אימות דוא״ל
    const token = await createVerifyToken(user.id);
    try { 
      await sendVerifyEmail(user.email, token, ctx.state.lang) /* הוספת פרמטר שפה */; 
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

  // סיסמה תקינה – המשך תהליך התחברות...
  if (!(await verifyPassword(password, user.passwordHash!))) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "דוא״ל או סיסמה שגויים",
    });
    return;
  }

  // סימון התחברות משתמש (session וכד')...
  // ... קטעי קוד נוספים ...

  phase("login.success", { userId: user.id, email: user.email });
  // הפניה מחדש לדף הבית או לדף ניהול בהתאם לסוג המשתמש
  ctx.response.redirect(user.role === "admin" ? "/admin" : "/owner");
});

/* --------- Logout --------- */
authRouter.post("/auth/logout", async (ctx) => {
  // ... קוד התנתקות ...
  ctx.response.redirect("/");
});

/* --------- Email Verify (complete) --------- */
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", { 
      title: "אימות דוא״ל", page: "verify", 
      info: "קישור לא תקין" 
    });
    return;
  }
  const record = await findUserByToken(token, "verify");
  if (!record) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "verify_notice", { 
      title: "אימות דוא״ל", page: "verify", 
      info: "קישור לא תקין או שפג תוקף" 
    });
    return;
  }
  const user = await markUserVerified(record.userId);
  deleteToken(token);
  phase("verify.complete", { userId: user.id, email: user.email });
  await render(ctx, "verify_notice", { 
    title: "אימות דוא״ל", page: "verify", 
    info: "האימייל אומת בהצלחה! אפשר כעת להתחבר.", 
    postVerify: true 
  });
});

/* --------- Resend verification --------- */
authRouter.get("/auth/verify/resend", async (ctx) => {
  const emailParam = ctx.request.url.searchParams.get("email") || "";
  const email = lower(emailParam);
  if (!email) {
    await render(ctx, "verify_notice", { 
      title: "שליחת אימות", page: "verify", 
      info: "נא לספק כתובת דוא״ל" 
    });
    return;
  }
  const user = await findUserByEmail(email);
  if (!user) {
    // משיבים בצורה "עמומה" כדי לא לחשוף אם קיים משתמש או לא
    await render(ctx, "verify_notice", { 
      title: "שליחת אימות", page: "verify", 
      info: "אם הדוא״ל קיים במערכת – נשלח קישור אימות." 
    });
    return;
  }
  if (user.emailVerified) {
    await render(ctx, "verify_notice", { 
      title: "שליחת אימות", page: "verify", 
      info: "החשבון כבר מאומת. אפשר להתחבר." 
    });
    return;
  }
  const token = await createVerifyToken(user.id);
  try { 
    await sendVerifyEmail(user.email, token, ctx.state.lang) /* הוספת פרמטר שפה */; 
  } catch (e) { 
    phase("verify.resend.error", String(e)); 
  }
  await render(ctx, "verify_notice", { 
    title: "שליחת אימות", page: "verify", 
    info: "קישור אימות נשלח מחדש לתיבת הדוא״ל." 
  });
});

/* --------- Forgot / Reset --------- */
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { 
    title: "שכחתי סיסמה", page: "forgot" 
  });
});

authRouter.post("/auth/forgot", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("forgot.input", { meta, keys: Object.keys(b) });

  const email = lower(String((b as any).email ?? ""));
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { 
      title: "שכחתי סיסמה", page: "forgot", 
      error: "נא להזין דוא״ל" 
    });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    try { 
      await sendResetEmail(email, token, ctx.state.lang) /* הוספת פרמטר שפה */; 
    } catch (e) { 
      phase("forgot.send.error", String(e)); 
    }
  }
  // תמיד מציגים הודעת הצלחה עמומה, גם אם המשתמש לא נמצא
  await render(ctx, "auth/forgot", { 
    title: "שכחתי סיסמה", page: "forgot", 
    info: "אם הדוא״ל קיים במערכת, נשלח קישור לאיפוס סיסמה." 
  });
});

authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { 
      title: "איפוס סיסמה", page: "reset", 
      error: "קישור לא תקין" 
    });
    return;
  }
  await render(ctx, "auth/reset", { 
    title: "איפוס סיסמה", page: "reset", token 
  });
});

authRouter.post("/auth/reset", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("reset.input", { meta, keys: Object.keys(b) });

  const token   = String((b as any).token    ?? "");
  const pw      = String((b as any).password ?? "");
  const confirm = String((b as any).confirm  ?? (b as any).passwordConfirm ?? "");

  if (!token || !pw || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { 
      title: "איפוס סיסמה", page: "reset", token, 
      error: "נא למלא את כל השדות" 
    });
    return;
  }
  if (pw !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { 
      title: "איפוס סיסמה", page: "reset", token, 
      error: "אימות סיסמה לא תואם" 
    });
    return;
  }

  const record = await findUserByToken(token, "reset");
  if (!record) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "auth/reset", { 
      title: "איפוס סיסמה", page: "reset", token, 
      error: "קישור לא תקין או שפג תוקף" 
    });
    return;
  }
  const user = record.userId ? await findUserByEmail(record.email) : null;
  if (!user) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "auth/reset", { 
      title: "איפוס סיסמה", page: "reset", token, 
      error: "משתמש לא נמצא" 
    });
    return;
  }

  // עדכון סיסמה בפועל
  const hash = await hashPassword(pw);
  user.passwordHash = hash;
  await user.save();
  deleteToken(token);
  phase("reset.success", { userId: user.id, email: user.email });

  await render(ctx, "auth/reset", { 
    title: "איפוס סיסמה", page: "reset", 
    success: true 
  });
});

/* ... שאר הקוד והנתיבים ... */
