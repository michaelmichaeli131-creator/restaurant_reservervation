// src/routes/auth.ts
// -------------------------------------------------------------
// Auth routes: register / login / logout / verify / resend /
// forgot / reset – מותאם ל-Deno Deploy + jsr:@oak/oak
// בלי שימוש ישיר ב-ctx.request.body() / formData()
// -------------------------------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import {
  createUser,
  findUserByEmail,
  findUserByUsername,
  createVerifyToken,
  useVerifyToken,
  createResetToken,
  useResetToken,
  updateUserPassword,
} from "../database.ts";
import { render } from "../lib/view.ts";
import { sendVerifyEmail, sendResetEmail } from "../lib/mail.ts";
import { phase } from "../lib/phase.ts";
import { authRateLimitByIP } from "../middleware/rate_limit.ts";

export const authRouter = new Router();

/* -----------------------------------------------------------
 * Helpers
 * --------------------------------------------------------- */

function lower(s: string): string {
  return (s ?? "").toString().trim().toLowerCase();
}

function randomPassword(len = 12): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_+-=";
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) {
    out += chars[buf[i] % chars.length];
  }
  return out;
}

function entriesToObject(
  entries: Iterable<[string, string]>,
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [k, v] of entries) {
    obj[k] = v;
  }
  return obj;
}

function getUnderlyingFetchRequest(ctx: any): Request | null {
  // מנסה למצוא את ה-Request המקורי של Deno / Fetch
  const r =
    (ctx?.request as any)?.originalRequest ??
    (ctx?.request as any)?.raw ??
    (ctx?.request as any)?.req ??
    (ctx?.request as any)?.request ??
    (ctx as any)?.request ??
    (ctx as any)?.requestEvent?.request ??
    null;
  return r ?? null;
}

// קריאה מאוחדת לגוף – בלי ctx.request.body() ישירות
async function readBody(
  ctx: any,
): Promise<{ data: Record<string, unknown>; meta: Record<string, unknown> }> {
  const meta: Record<string, unknown> = { ok: false };
  const oakReq = (ctx as any).request;
  const fetchReq = getUnderlyingFetchRequest(ctx);

  const ctHeader =
    fetchReq?.headers?.get("content-type") ??
    oakReq?.headers?.get("content-type") ??
    "";
  const ct = ctHeader.split(";")[0].trim().toLowerCase();
  meta["contentType"] = ct;

  // 1) קודם נסה דרך Fetch Request (Deno Deploy)
  if (fetchReq) {
    try {
      if (
        ct === "application/x-www-form-urlencoded" ||
        ct === "multipart/form-data"
      ) {
        if (typeof (fetchReq as any).formData === "function") {
          const fd = await (fetchReq as any).formData();
          const data = entriesToObject(fd.entries() as any);
          meta.ok = true;
          meta.via = "fetch:formData";
          return { data, meta };
        }
      }
      if (ct === "application/json") {
        const json = await (fetchReq as any).json().catch(() => ({}));
        meta.ok = true;
        meta.via = "fetch:json";
        return { data: json ?? {}, meta };
      }
      if (typeof (fetchReq as any).text === "function") {
        const text = await (fetchReq as any).text();
        meta.ok = true;
        meta.via = "fetch:text";
        // ננסה לפרסר כ-urlencoded אם מתאים
        if (ct === "application/x-www-form-urlencoded") {
          const params = new URLSearchParams(text);
          const data = entriesToObject(params.entries());
          return { data, meta };
        }
        return { data: { raw: text }, meta };
      }
    } catch (e) {
      meta.fetchError = String(e);
    }
  }

  // 2) Fallback – Oak request.body() רק אם זו פונקציה
  if (oakReq && typeof oakReq.body === "function") {
    try {
      const body = oakReq.body(); // בלי פרמטרים – Oak בוחר לבד
      const val = await body.value;
      meta.ok = true;
      meta.via = `oak:body(${body.type})`;
      if (body.type === "form" || body.type === "form-data") {
        const data = entriesToObject((val as URLSearchParams).entries());
        return { data, meta };
      }
      if (body.type === "json") {
        return { data: val ?? {}, meta };
      }
      return { data: val ?? {}, meta };
    } catch (e) {
      meta.oakError = String(e);
    }
  }

  // 3) אין כלום
  return { data: {}, meta };
}

/* -----------------------------------------------------------
 * Register
 * --------------------------------------------------------- */

authRouter.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", {
    title: "הרשמה",
    page: "register",
  });
});

authRouter.post("/auth/register", authRateLimitByIP, async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("auth.register.input", { meta });

  const firstName = String((b as any).firstName ?? "").trim();
  const lastName = String((b as any).lastName ?? "").trim();
  const email = lower(String((b as any).email ?? ""));
  const password = String((b as any).password ?? "");
  const businessType = String((b as any).businessType ?? "").trim();
  const phone = String((b as any).phone ?? "").trim();

  if (!firstName || !lastName || !email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "נא למלא את כל השדות",
      firstName,
      lastName,
      email,
      businessType,
      phone,
    });
    return;
  }
  if (password.length < 8) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "הסיסמה צריכה להכיל לפחות 8 תווים",
      firstName,
      lastName,
      email,
      businessType,
      phone,
    });
    return;
  }

  // בדיקה שאין משתמש קיים
  const existing = await findUserByEmail(email);
  if (existing) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", {
      title: "הרשמה",
      page: "register",
      error: "קיים כבר משתמש עם כתובת דוא״ל זו",
      firstName,
      lastName,
      email,
      businessType,
      phone,
    });
    return;
  }

  // יצירת משתמש
  const userPartial: any = {
    firstName,
    lastName,
    email,
    businessType,
    phone,
    provider: "local",
    role: "owner",
  };

  const passwordHash = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(password))
    .then((buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );

  const created = await createUser({
    ...userPartial,
    passwordHash,
  } as any);

  phase("auth.register.created", { userId: created.id, email: created.email });

  const token = await createVerifyToken(created.id);
  const lang = (ctx.state as any)?.lang ?? null;

  try {
    await sendVerifyEmail(created.email, token, lang);
    phase("auth.register.verify.sent", { email: created.email });
  } catch (e) {
    phase("auth.register.verify.error", { error: String(e) });
  }

  await render(ctx, "verify_notice", {
    title: "בדיקת דוא״ל",
    page: "verify",
    info:
      "נשלח קישור אימות לכתובת הדוא״ל. יש ללחוץ על הקישור כדי להשלים את ההרשמה.",
    email: created.email,
    resendUrl: `/auth/verify/resend?email=${encodeURIComponent(created.email)}`,
  });
});

/* -----------------------------------------------------------
 * Login / Logout
 * --------------------------------------------------------- */

authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", {
    title: "התחברות",
    page: "login",
  });
});

async function verifyPassword(
  plain: string,
  hashHex: string | null | undefined,
): Promise<boolean> {
  if (!hashHex) return false;
  const enc = new TextEncoder();
  const plainBuf = await crypto.subtle.digest("SHA-256", enc.encode(plain));
  const plainHex = Array.from(new Uint8Array(plainBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return plainHex === hashHex;
}

authRouter.post("/auth/login", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("auth.login.input", { meta });

  const email = lower(String((b as any).email ?? ""));
  const password = String((b as any).password ?? "");
  const redirectParam = String((b as any).redirect ?? "") ||
    ctx.request.url.searchParams.get("redirect") ?? "";

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
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "דוא״ל או סיסמה שגויים",
    });
    return;
  }

  if (!user.emailVerified) {
    const token = await createVerifyToken(user.id);
    const lang = (ctx.state as any)?.lang ?? null;
    try {
      await sendVerifyEmail(user.email, token, lang);
    } catch {
      // מתעלמים – עדיין נחסום
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

  if (!(await verifyPassword(password, (user as any).passwordHash))) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "דוא״ל או סיסמה שגויים",
    });
    return;
  }

  // שמירת userId בסשן – זה מה שהמידלוור ב-server.ts קורא
  const session = (ctx.state as any).session;
  if (session && typeof session.set === "function") {
    await session.set("userId", user.id);
  }

  phase("auth.login.success", { userId: user.id, email: user.email });

  const target =
    redirectParam ||
    (user.role === "admin" ? "/admin" : "/owner");

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", target);
});

authRouter.post("/auth/logout", async (ctx) => {
  const session = (ctx.state as any).session;
  if (session && typeof session.set === "function") {
    await session.set("userId", null);
  }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* -----------------------------------------------------------
 * Email verify + resend
 * --------------------------------------------------------- */

authRouter.get("/auth/verify", async (ctx) => {
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

  const used = await useVerifyToken(token);
  if (!used) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "verify_notice", {
      title: "אימות דוא״ל",
      page: "verify",
      info: "קישור לא תקין או שפג תוקף",
    });
    return;
  }

  // useVerifyToken כבר דואג לסמן את המשתמש כמאומת בבסיס הנתונים (לפי הקוד המקורי)
  phase("auth.verify.complete", {
    userId: used.userId,
    email: used.email,
  });

  await render(ctx, "verify_notice", {
    title: "אימות דוא״ל",
    page: "verify",
    info: "האימייל אומת בהצלחה! אפשר כעת להתחבר.",
    postVerify: true,
  });
});

authRouter.get("/auth/verify/resend", async (ctx) => {
  const emailParam = ctx.request.url.searchParams.get("email") ?? "";
  const email = lower(emailParam);

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
  const lang = (ctx.state as any)?.lang ?? null;

  try {
    await sendVerifyEmail(user.email, token, lang);
    phase("auth.verify.resend.sent", { email: user.email });
  } catch (e) {
    phase("auth.verify.resend.error", { error: String(e) });
  }

  await render(ctx, "verify_notice", {
    title: "שליחת אימות",
    page: "verify",
    info: "קישור אימות נשלח מחדש לתיבת הדוא״ל.",
  });
});

/* -----------------------------------------------------------
 * Forgot / Reset password
 * --------------------------------------------------------- */

authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
  });
});

authRouter.post("/auth/forgot", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("auth.forgot.input", { meta });

  const email = lower(String((b as any).email ?? ""));
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", {
      title: "שכחתי סיסמה",
      page: "forgot",
      error: "נא להזין דוא״ל",
    });
    return;
  }

  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    const lang = (ctx.state as any)?.lang ?? null;
    try {
      await sendResetEmail(email, token, lang);
      phase("auth.forgot.send", { email });
    } catch (e) {
      phase("auth.forgot.send.error", { error: String(e) });
    }
  }

  await render(ctx, "auth/forgot", {
    title: "שכחתי סיסמה",
    page: "forgot",
    info: "אם הדוא״ל קיים במערכת, נשלח קישור לאיפוס סיסמה.",
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
  const { data: b, meta } = await readBody(ctx);
  phase("auth.reset.input", { meta });

  const token = String((b as any).token ?? "");
  const pw = String((b as any).password ?? "");
  const confirm = String(
    (b as any).confirm ?? (b as any).passwordConfirm ?? "",
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

  const used = await useResetToken(token);
  if (!used) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "auth/reset", {
      title: "איפוס סיסמה",
      page: "reset",
      token,
      error: "קישור לא תקין או שפג תוקף",
    });
    return;
  }

  const newHashBuf = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(pw));
  const newHashHex = Array.from(new Uint8Array(newHashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await updateUserPassword(used.userId, newHashHex);
  phase("auth.reset.success", { userId: used.userId, email: used.email });

  await render(ctx, "auth/reset", {
    title: "איפוס סיסמה",
    page: "reset",
    success: true,
  });
});

// סוף קובץ
