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

// helpers
function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }

// דוגמת hash בסיסית (SHA-256). אפשר להחליף ל-bcrypt בהמשך.
// Web Crypto subtle.digest מתועד ב־Deno/MDN.
async function hashPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// קריאת גוף בקשה (תואם JSON / x-www-form-urlencoded / text)
// Oak: ctx.request.body({type:"json"|"form"|"text"}).value
async function readBody(ctx: any): Promise<Record<string, unknown>> {
  const req: any = ctx.request as any;
  const ct = ctx.request.headers.get("content-type") ?? "";
  try {
    if (typeof req.body === "function") {
      if (ct.includes("application/json")) {
        const v = await req.body({ type: "json" }).value;
        return v && typeof v === "object" ? v : {};
      }
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.body({ type: "form" }).value as URLSearchParams;
        return Object.fromEntries(form.entries());
      }
      if (ct.includes("text/plain")) {
        const t = await req.body({ type: "text" }).value as string;
        try { return t ? JSON.parse(t) : {}; } catch { return {}; }
      }
      // נסה form כברירת מחדל
      const form = await req.body({ type: "form" }).value as URLSearchParams;
      return Object.fromEntries(form.entries());
    }
    // Deno Deploy: נסיון דרך originalRequest
    const native: any = req.originalRequest;
    if (native?.formData) {
      const fd = await native.formData();
      return Object.fromEntries(fd.entries());
    }
    if (native?.json) {
      const v = await native.json();
      return v && typeof v === "object" ? v : {};
    }
  } catch { /* ignore */ }
  return {};
}

export const authRouter = new Router();

// GET /auth/login
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

// POST /auth/login
authRouter.post("/auth/login", async (ctx) => {
  const body = await readBody(ctx);
  const email = lower(body.email as string);
  const pw = String(body.password ?? "");

  if (!email || !pw) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "נא למלא דוא״ל וסיסמה" });
    return;
  }

  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  const h = await hashPassword(pw);
  if (h !== user.passwordHash) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  // שמירת session
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
  const b = await readBody(ctx);

  const firstName = String(b.firstName ?? "").trim();
  const lastName = String(b.lastName ?? "").trim();
  const age = Number(String(b.age ?? "")) || undefined;
  const businessType = String(b.businessType ?? "").trim() || undefined;
  const email = lower(b.email as string);
  const username = lower(String(b.username ?? (email.split("@")[0] ?? "")));
  const password = String(b.password ?? "");
  const confirm = String(b.confirm ?? "");

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
  if (await findUserByUsername(username)) {
    ctx.response.status = Status.Conflict;
    await render(ctx, "auth/register", { title: "הרשמה", page: "register", error: "שם משתמש כבר קיים במערכת" });
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
  await sendVerifyEmail(user.email, token).catch(() => {});

  // התחברות מידית אחרי הרשמה (אופציונלי)
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
  await render(ctx, "auth/forgot", { title: "שחזור סיסמה", page: "forgot" });
});

// POST /auth/forgot
authRouter.post("/auth/forgot", async (ctx) => {
  const body = await readBody(ctx);
  const email = lower(body.email as string);

  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שחזור סיסמה", page: "forgot", error: "נא להזין דוא״ל" });
    return;
  }

  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    await sendResetEmail(email, token).catch(() => {});
  }
  // לא חושפים אם קיים/לא קיים
  await render(ctx, "auth/forgot", { title: "שחזור סיסמה", page: "forgot", ok: "אם המשתמש קיים, נשלח מייל לשחזור." });
});

// GET /auth/reset?token=...
authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  if (!token) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing token"; return; }
  await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

// POST /auth/reset
authRouter.post("/auth/reset", async (ctx) => {
  const body = await readBody(ctx);

  const token = String(body.token ?? "");
  const pw = String(body.password ?? "");
  const confirm = String(body.confirm ?? "");

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
