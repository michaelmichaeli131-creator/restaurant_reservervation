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

function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }
function hashPassword(pw: string) { // דמה — החלף ל-bcrypt אם תרצה
  const data = new TextEncoder().encode(pw);
  return crypto.subtle.digest("SHA-256", data).then((buf) =>
    Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

export const authRouter = new Router();

// GET /auth/login
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

// POST /auth/login
authRouter.post("/auth/login", async (ctx) => {
  const req: any = (ctx.request as any);
  let body: any = {};
  // קריאת form/urlencoded או json
  try {
    const ct = ctx.request.headers.get("content-type") ?? "";
    if (typeof req.body === "function") {
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.body({ type: "form" }).value;
        body = Object.fromEntries(form.entries());
      } else if (ct.includes("application/json")) {
        body = await req.body({ type: "json" }).value;
      } else {
        const t = await req.body({ type: "text" }).value;
        body = t ? JSON.parse(t) : {};
      }
    } else if ((req as any).originalRequest?.formData) {
      const fd = await (req as any).originalRequest.formData();
      body = Object.fromEntries(fd.entries());
    }
  } catch { body = {}; }

  const email = lower(body.email);
  const pw = String(body.password ?? "");
  if (!email || !pw) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { title: "התחברות", error: "נא למלא דוא״ל וסיסמה" });
    return;
  }
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", error: "דוא״ל או סיסמה שגויים" });
    return;
  }
  const h = await hashPassword(pw);
  if (h !== user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", error: "דוא״ל או סיסמה שגויים" });
    return;
  }
  // שמירה ל-session (middleware קיים אצלך: ctx.state.session)
  const session = (ctx.state as any)?.session;
  if (session?.set) await session.set("userId", user.id);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// GET /auth/logout
authRouter.get("/auth/logout", async (ctx) => {
  const session = (ctx.state as any)?.session;
  if (session?.set) await session.set("userId", null);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// GET /auth/register
authRouter.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", { title: "הרשמה", page: "register" });
});

// POST /auth/register
authRouter.post("/auth/register", async (ctx) => {
  const req: any = (ctx.request as any);
  let b: any = {};
  try {
    const ct = ctx.request.headers.get("content-type") ?? "";
    if (typeof req.body === "function") {
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.body({ type: "form" }).value;
        b = Object.fromEntries(form.entries());
      } else if (ct.includes("application/json")) {
        b = await req.body({ type: "json" }).value;
      } else {
        const t = await req.body({ type: "text" }).value;
        b = t ? JSON.parse(t) : {};
      }
    } else if ((req as any).originalRequest?.formData) {
      const fd = await (req as any).originalRequest.formData();
      b = Object.fromEntries(fd.entries());
    }
  } catch { b = {}; }

  const firstName = String(b.firstName ?? "").trim();
  const lastName = String(b.lastName ?? "").trim();
  const age = Number(String(b.age ?? "")) || undefined;
  const businessType = String(b.businessType ?? "").trim() || undefined;
  const email = lower(b.email);
  const username = lower(String(b.username ?? email.split("@")[0] ?? "")); // יוזר ברירת מחדל מהדוא״ל
  const password = String(b.password ?? "");
  const confirm = String(b.confirm ?? "");

  // ולידציה בסיסית
  if (!firstName || !lastName || !email || !password || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", { title: "הרשמה", error: "נא למלא את כל השדות החיוניים" });
    return;
  }
  if (password !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/register", { title: "הרשמה", error: "אימות סיסמה לא תואם" });
    return;
  }

  // בדיקת קיום משתמש
  if (await findUserByEmail(email)) {
    ctx.response.status = Status.Conflict;
    await render(ctx, "auth/register", { title: "הרשמה", error: "דוא״ל כבר קיים במערכת" });
    return;
  }
  if (await findUserByUsername(username)) {
    ctx.response.status = Status.Conflict;
    await render(ctx, "auth/register", { title: "הרשמה", error: "שם משתמש כבר קיים במערכת" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user: User = await createUser({
    id: crypto.randomUUID(),
    email,
    username,
    firstName,
    lastName,
    age,
    businessType,
    passwordHash,
    role: "user",
    provider: "local",
  });

  // אימות מייל
  const token = await createVerifyToken(user.id, user.email);
  await sendVerifyEmail(user.email, token).catch(() => { /* לא להפיל רישום */ });

  const session = (ctx.state as any)?.session;
  if (session?.set) await session.set("userId", user.id);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

// GET /auth/verify?token=...
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing token"; return; }
  const used = await useVerifyToken(token);
  if (!used) { ctx.response.status = Status.BadRequest; ctx.response.body = "invalid/expired token"; return; }
  await setEmailVerified(used.userId);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?verified=1");
});

// GET /auth/forgot
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { title: "שחזור סיסמה" });
});

// POST /auth/forgot
authRouter.post("/auth/forgot", async (ctx) => {
  const req: any = (ctx.request as any);
  let body: any = {};
  try {
    const ct = ctx.request.headers.get("content-type") ?? "";
    if (typeof req.body === "function") {
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.body({ type: "form" }).value;
        body = Object.fromEntries(form.entries());
      } else if (ct.includes("application/json")) {
        body = await req.body({ type: "json" }).value;
      } else {
        const t = await req.body({ type: "text" }).value;
        body = t ? JSON.parse(t) : {};
      }
    } else if ((req as any).originalRequest?.formData) {
      const fd = await (req as any).originalRequest.formData();
      body = Object.fromEntries(fd.entries());
    }
  } catch { body = {}; }

  const email = lower(body.email);
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שחזור סיסמה", error: "נא להזין דוא״ל" });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    await sendResetEmail(email, token).catch(() => {});
  }
  // לא חושפים אם קיים/לא קיים
  await render(ctx, "auth/forgot", { title: "שחזור סיסמה", ok: "אם המשתמש קיים, נשלח מייל לשחזור." });
});

// GET /auth/reset?token=...
authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing token"; return; }
  await render(ctx, "auth/reset", { title: "איפוס סיסמה", token });
});

// POST /auth/reset
authRouter.post("/auth/reset", async (ctx) => {
  const req: any = (ctx.request as any);
  let body: any = {};
  try {
    const ct = ctx.request.headers.get("content-type") ?? "";
    if (typeof req.body === "function") {
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.body({ type: "form" }).value;
        body = Object.fromEntries(form.entries());
      } else if (ct.includes("application/json")) {
        body = await req.body({ type: "json" }).value;
      } else {
        const t = await req.body({ type: "text" }).value;
        body = t ? JSON.parse(t) : {};
      }
    } else if ((req as any).originalRequest?.formData) {
      const fd = await (req as any).originalRequest.formData();
      body = Object.fromEntries(fd.entries());
    }
  } catch { body = {}; }

  const token = String(body.token ?? "");
  const pw = String(body.password ?? "");
  const confirm = String(body.confirm ?? "");
  if (!token || !pw || !confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", token, error: "נא למלא את כל השדות" });
    return;
  }
  if (pw !== confirm) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", token, error: "אימות סיסמה לא תואם" });
    return;
  }

  const used = await useResetToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", error: "קישור פג או לא תקין" });
    return;
  }
  const hash = await hashPassword(pw);
  await updateUserPassword(used.userId, hash);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?resetOk=1");
});
