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

<<<<<<< HEAD
const authRouter = new Router();

// GET /auth/login - get login page
=======
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
function formDataToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : (v?.name ?? "");
  return out;
}

/* ---------- helpers to access original Fetch Request (not Oak wrapper) ---------- */
function getFetchRequest(ctx: any): Request | null {
  const r =
    (ctx?.request as any)?.originalRequest ??
    (ctx?.request as any)?.rawRequest ??
    (ctx as any)?.requestEvent?.request ??
    null;
  return r ?? null;
}

async function readAllFromStream(req: Request): Promise<string> {
  const body = (req as any).body as ReadableStream<Uint8Array> | null;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(merged);
}

function parseByContentType(t: string, ct: string): { kind: string; data: Record<string, unknown> } {
  if (!t) return { kind: "empty", data: {} };
  const base = (ct || "").toLowerCase().split(";")[0].trim();

  if (base === "application/x-www-form-urlencoded" ||
      (t.includes("=") && t.includes("&") && !t.trim().startsWith("{"))) {
    const params = new URLSearchParams(t);
    return { kind: "urlencoded", data: entriesToObject(params.entries()) };
  }

  if (base === "application/json" || t.trim().startsWith("{") || t.trim().startsWith("[")) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object") return { kind: "json", data: j as Record<string, unknown> };
    } catch { /* raw */ }
  }

  return { kind: "rawtext", data: { _raw: t } };
}

async function readBody(ctx: any): Promise<{ data: Record<string, unknown>; meta: Record<string,string> }> {
  const meta: Record<string, string> = {};
  const oakReq: any = ctx?.request;
  const fetchReq: any = getFetchRequest(ctx);
  const ctRaw: string =
    (oakReq?.headers?.get?.("content-type"))?.toString() ??
    (fetchReq?.headers?.get?.("content-type"))?.toString() ??
    "";
  const ct = ctRaw.split(";")[0].trim().toLowerCase();

  phase("body.start", {
    method: oakReq?.method ?? fetchReq?.method ?? "",
    url: String(oakReq?.url ?? fetchReq?.url ?? ""),
    contentType: ctRaw || "(none)",
    hasOakBodyFn: typeof oakReq?.body === "function",
    hasFetchReq: !!fetchReq,
  });

  try {
    if (typeof oakReq?.body === "function") {
      if (ct === "application/x-www-form-urlencoded" || ct === "multipart/form-data") {
        const form = await oakReq.body({ type: "form" }).value as URLSearchParams;
        const r = entriesToObject(form.entries());
        meta.parser = ct.includes("multipart") ? "oak:form(multipart)" : "oak:form(urlencoded)";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      }
      if (ct === "application/json") {
        const j = await oakReq.body({ type: "json" }).value as Record<string, unknown>;
        const r = j ?? {};
        meta.parser = "oak:json";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      }
      const txt = await oakReq.body({ type: "text" }).value as string;
      const parsed = parseByContentType(txt, ct);
      meta.parser = `oak:text->${parsed.kind}`;
      phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
      return { data: parsed.data, meta };
    }
  } catch (e) {
    phase("body.oak.error", String(e));
  }

  if (fetchReq) {
    try {
      if ((ct === "application/x-www-form-urlencoded" || ct === "multipart/form-data") &&
          typeof fetchReq.formData === "function") {
        const fd = await fetchReq.formData();
        const r = formDataToObject(fd);
        meta.parser = ct.includes("multipart") ? "fetch:formData(multipart)" : "fetch:formData(urlencoded)";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      }
    } catch (e) { phase("body.fetch.formData.error", String(e)); }

    try {
      if (ct === "application/json" && typeof fetchReq.json === "function") {
        const j = await fetchReq.json() as Record<string, unknown>;
        const r = j ?? {};
        meta.parser = "fetch:json";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      }
    } catch (e) { phase("body.fetch.json.error", String(e)); }

    try {
      if (typeof fetchReq.text === "function") {
        const t = await fetchReq.text();
        const parsed = parseByContentType(t, ct);
        meta.parser = `fetch:text->${parsed.kind}`;
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
        return { data: parsed.data, meta };
      }
    } catch (e) { phase("body.fetch.text.error", String(e)); }

    try {
      if (fetchReq.body) {
        const t = await readAllFromStream(fetchReq as Request);
        const parsed = parseByContentType(t, ct);
        meta.parser = `fetch:stream->${parsed.kind}`;
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
        return { data: parsed.data, meta };
      }
    } catch (e) { phase("body.fetch.stream.error", String(e)); }
  }

  meta.parser = "empty";
  phase("body.empty");
  return { data: {}, meta };
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

  const firstName = trim(String((b as any).firstName ?? (b as any).first_name ?? ""));
  const lastName  = trim(String((b as any).lastName  ?? (b as any).last_name  ?? ""));
  const email     = lower(String((b as any).email ?? (b as any).mail ?? (b as any).username ?? ""));
  const password  = String((b as any).password ?? "");
  const confirm   = String(
    (b as any).confirm ??
    (b as any).passwordConfirm ??
    (b as any)["password_confirm"] ??
    (b as any).passwordConfirmation ??
    (b as any)["password_confirmation"] ?? ""
  );

  const businessType = trim(String((b as any).businessType ?? (b as any)["business_type"] ?? "")) || undefined;
  const phone        = trim(String((b as any).phone ?? "")) || undefined;

  if (!firstName || !lastName || !email || !password || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register", error: "נא למלא את כל השדות החיוניים" });
    return;
  }
  if (password !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register", error: "אימות סיסמה לא תואם" });
    return;
  }
  if (await findUserByEmail(email)) {
    ctx.response.status = Status.Conflict;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register", error: "דוא״ל כבר קיים במערכת" });
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

  // שליחת אימות
  const token = await createVerifyToken(created.id);
  try { await sendVerifyEmail(created.email, token); phase("register.verify.sent", { email: created.email }); }
  catch (e) { phase("register.verify.error", String(e)); }

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
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

<<<<<<< HEAD
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
=======
authRouter.post("/auth/login", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("login.input", { meta, keys: Object.keys(b) });

  const emailOrUser = lower(String((b as any).email ?? (b as any).username ?? ""));
  const password = String((b as any).password ?? "");

  if (!emailOrUser || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "נא למלא דוא״ל/שם משתמש וסיסמה" });
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
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
<<<<<<< HEAD
    try { await sendVerifyEmail(user.email, token, ctx.state.lang); } catch {}
=======
    try { await sendVerifyEmail(user.email, token); } catch {}
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "נדרש אימות דוא״ל לפני התחברות. שלחנו לך קישור אימות נוסף.",
<<<<<<< HEAD
      email,
=======
      verifyResend: true,
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
    });
    return;
  }

<<<<<<< HEAD
  // אימות סיסמה
  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
=======
  if (user.isActive === false) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "auth/login", {
      title: "התחברות",
      page: "login",
      error: "החשבון מבוטל. פנה/י לתמיכה.",
    });
    return;
  }

  const ok = await verifyPassword(password, (user as any).passwordHash);
  if (!ok) {
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים", email });
    return;
  }

<<<<<<< HEAD
  // התחברות מוצלחת
  ctx.state.session = { userId: user.id };
  phase("login.success", { userId: user.id });
  return ctx.response.redirect("/");
});

// POST /auth/forgot - handle forgot password form
=======
  const session = (ctx.state as any)?.session;
  try {
    if (session?.set) await session.set("userId", user.id);
  } catch (e) { phase("login.session.error", String(e)); }

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* --------- Logout --------- */
authRouter.get("/auth/logout", async (ctx) => {
  const session = (ctx.state as any)?.session;
  try {
    if (session?.destroy) await session.destroy();
    phase("logout.session.destroyed", { hasSession: !!session });
  } catch (e) {
    phase("logout.session.error", String(e));
  }
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* --------- Email Verify (complete) --------- */
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", { title: "אימות אימייל", page: "verify", error: "קישור אימות לא תקין" });
    return;
  }
  const used = await useVerifyToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "verify_notice", { title: "אימות אימייל", page: "verify", error: "קישור פג או לא תקין" });
    return;
  }
  await setEmailVerified(used.userId);

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
    await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", error: "חסר דוא״ל לשליחת קישור אימות" });
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
  try { await sendVerifyEmail(user.email, token); } catch (e) { phase("verify.resend.error", String(e)); }
  await render(ctx, "verify_notice", { title: "שליחת אימות", page: "verify", info: "קישור אימות נשלח מחדש לתיבת הדוא״ל." });
});

/* --------- Forgot / Reset --------- */
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot" });
});

>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
authRouter.post("/auth/forgot", async (ctx) => {
  const body = ctx.request.body({ type: "form" });
  const value = await body.value.catch(() => ({}));
  const email = value.get("email")?.trim().toLowerCase() || "";

<<<<<<< HEAD
=======
  const email = lower(String((b as any).email ?? ""));
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "נא להזין דוא״ל" });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
<<<<<<< HEAD
    try { await sendResetEmail(email, token, ctx.state.lang); } catch (e) { phase("forgot.send.error", String(e)); }
=======
    try { await sendResetEmail(email, token); } catch (e) { phase("forgot.send.error", String(e)); }
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
  }
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", info: "אם הדוא״ל קיים, נשלח קישור איפוס" });
});

<<<<<<< HEAD
// POST /auth/reset - handle password reset submission
=======
authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "קישור לא תקין" });
    return;
  }
  await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
authRouter.post("/auth/reset", async (ctx) => {
  const body = ctx.request.body({ type: "form" });
  const value = await body.value.catch(() => ({}));
  const token = value.get("token") || "";
  const password = value.get("password") || "";

<<<<<<< HEAD
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
=======
  const token   = String((b as any).token ?? "");
  const pw      = String((b as any).password ?? "");
  const confirm = String((b as any).confirm ?? (b as any).passwordConfirm ?? "");

  if (!token || !pw || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "נא למלא את כל השדות" });
    return;
  }
  if (pw !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "אימות סיסמה לא תואם" });
    return;
  }

  const used = await useResetToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "קישור פג או לא תקין" });
    return;
  }

  const hash = await hashPassword(pw);
  await updateUserPassword(used.userId, hash);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?resetOk=1");
});

export { authRouter };
export default authRouter;
>>>>>>> f9a4f18d4f26c38c81b1cef7a67ea6653c8c797b
