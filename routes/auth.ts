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

/* ---------------- Utils ---------------- */

function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }
function trim(s?: string)  { return (s ?? "").trim(); }

function fromEntries(iter: Iterable<[string, FormDataEntryValue]> | URLSearchParams): Record<string, string> {
  const o: Record<string, string> = {};
  // @ts-ignore
  const entries = (iter && typeof (iter as any).entries === "function") ? (iter as any).entries() : iter;
  for (const [k, v0] of entries as Iterable<[string, FormDataEntryValue]>) {
    const v = typeof v0 === "string" ? v0 : (v0?.name ?? "");
    o[k] = v;
  }
  return o;
}

async function readBody(ctx: any): Promise<Record<string, unknown>> {
  const req = ctx.request;
  const ctRaw = req.headers.get("content-type") || "";
  const ct = ctRaw.split(";")[0].trim().toLowerCase();
  try {
    if (ct === "application/x-www-form-urlencoded") {
      const b = await req.body({ type: "form" }).value as URLSearchParams;
      return fromEntries(b);
    }
    if (ct === "multipart/form-data") {
      const b = await req.body({ type: "form-data" }).value;
      const r = await b.read();
      return (r?.fields ?? {}) as Record<string, unknown>;
    }
    if (ct === "application/json") {
      const j = await req.body({ type: "json" }).value as Record<string, unknown>;
      return j ?? {};
    }
    if (ct === "text/plain") {
      const t = await req.body({ type: "text" }).value as string;
      // נסה לפענח כ-querystring אם נראה כך
      if (t.includes("=") && t.includes("&")) {
        const params = new URLSearchParams(t);
        return fromEntries(params);
      }
      try {
        const j = JSON.parse(t);
        if (j && typeof j === "object") return j as Record<string, unknown>;
      } catch {}
      return { _raw: t };
    }
    // Unknown/empty content-type: נסה קודם form ואז json בזהירות (ניסיון יחיד לכל אחד)
    try {
      const b = await req.body({ type: "form" }).value as URLSearchParams;
      return fromEntries(b);
    } catch {}
    try {
      const j = await req.body({ type: "json" }).value as Record<string, unknown>;
      return j ?? {};
    } catch {}
    return {};
  } catch {
    return {};
  }
}

/* ---------------- Router ---------------- */

const authRouter = new Router();

/* --------- Register --------- */
authRouter.get("/auth/register", async (ctx) => {
  await render(ctx, "auth/register", { title: "הרשמה", page: "register" });
});

authRouter.post("/auth/register", async (ctx) => {
  const b = await readBody(ctx);

  const firstName = trim(String(b.firstName ?? (b as any).first_name ?? ""));
  const lastName  = trim(String(b.lastName  ?? (b as any).last_name  ?? ""));
  const email     = lower(String(b.email ?? (b as any).mail ?? (b as any).username ?? ""));
  const password  = String(b.password ?? "");
  const confirm   = String(
    (b as any).confirm ??
    (b as any).passwordConfirm ??
    (b as any)["password_confirm"] ??
    (b as any).passwordConfirmation ??
    (b as any)["password_confirmation"] ?? ""
  );

  // שדות אופציונליים
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
  const created = await createUser(user as User, hash);

  // שלח אימייל verify
  const token = await createVerifyToken(created.id);
  try { await sendVerifyEmail(created.email, token); } catch {}

  // היכנס אוטומטית
  const session = (ctx.state as any)?.session;
  if (session?.set) await session.set("userId", created.id);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?welcome=1");
});

/* --------- Login --------- */
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

authRouter.post("/auth/login", async (ctx) => {
  const b = await readBody(ctx);
  const email = lower(String(b.email ?? (b as any).username ?? ""));
  const password = String(b.password ?? "");

  if (!email || !password) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "נא למלא דוא״ל וסיסמה" });
    return;
  }

  const user = await findUserByEmail(email) ?? await findUserByUsername(email);
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  if (!(await verifyPassword(password, (user as any).passwordHash))) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  const session = (ctx.state as any)?.session;
  if (session?.set) await session.set("userId", user.id);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* --------- Logout --------- */
authRouter.get("/auth/logout", async (ctx) => {
  const session = (ctx.state as any)?.session;
  if (session?.destroy) await session.destroy();
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/");
});

/* --------- Email Verify --------- */
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
  await render(ctx, "verify_done", { title: "אימות הושלם", page: "verify" });
});

/* --------- Forgot / Reset --------- */
authRouter.get("/auth/forgot", async (ctx) => {
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot" });
});

authRouter.post("/auth/forgot", async (ctx) => {
  const b = await readBody(ctx);
  const email = lower(String(b.email ?? ""));
  if (!email) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "נא להזין דוא״ל" });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    try { await sendResetEmail(email, token); } catch {}
  }
  // גם אם לא קיים — לא חושפים
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", info: "אם הדוא״ל קיים, נשלח קישור איפוס" });
});

authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "קישור לא תקין" });
    return;
  }
  await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

authRouter.post("/auth/reset", async (ctx) => {
  const b = await readBody(ctx);
  const token = String(b.token ?? "");
  const pw    = String(b.password ?? "");
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

export { authRouter };           // <- ייצוא Named עבור server.ts
export default authRouter;        // <- נשמר גם כ-Default
