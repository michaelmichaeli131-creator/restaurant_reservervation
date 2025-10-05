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

function formDataToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : (v?.name ?? "");
  return out;
}

async function readStreamText(req: Request): Promise<string> {
  // פוליביל: קורא את הגוף מה-ReadableStream גם אם אין text()/json()/formData()
  const dec = new TextDecoder();
  const body = (req as any).body as ReadableStream<Uint8Array> | null;
  if (!body) return "";
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  // איחוד כל המקטעים
  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return dec.decode(merged);
}

/**
 * קורא את גוף הבקשה באופן הדטרמיניסטי:
 * 1) ניסיונות API אם קיימים (formData/json/text).
 * 2) קריאה ישירה מה-Stream כ-פוליביל.
 * 3) פירוק תוכן לפי Content-Type (urlencoded/json/text).
 */
async function readBody(ctx: any): Promise<{ data: Record<string, unknown>; meta: Record<string,string> }> {
  const req = ctx.request as Request;
  const ctRaw = (req.headers.get("content-type") || "").trim();
  const ct = ctRaw.split(";")[0].toLowerCase();
  const meta: Record<string, string> = { contentType: ct || "(empty)" };

  phase("body.start", {
    method: (ctx.request as any).method ?? "POST",
    url: String((ctx.request as any).url ?? ""),
    contentType: ctRaw,
    hasFormDataFn: typeof (req as any).formData === "function",
    hasJsonFn: typeof (req as any).json === "function",
    hasTextFn: typeof (req as any).text === "function",
  });

  try {
    // 1) אם יש formData() ו-CT תואם
    if ((ct === "application/x-www-form-urlencoded" || ct === "multipart/form-data")
        && typeof (req as any).formData === "function") {
      try {
        const fd = await (req as any).formData();
        const r = formDataToObject(fd);
        meta.parser = ct.includes("multipart") ? "formData(multipart)" : "formData(urlencoded)";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      } catch (e) {
        phase("body.formData.api.error", String(e));
      }
    }

    // 2) JSON אם יש json()
    if (ct === "application/json" && typeof (req as any).json === "function") {
      try {
        const j = await (req as any).json() as Record<string, unknown>;
        const r = j ?? {};
        meta.parser = "json(api)";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      } catch (e) {
        phase("body.json.api.error", String(e));
      }
    }

    // 3) TEXT אם יש text()
    if (typeof (req as any).text === "function") {
      try {
        const t = await (req as any).text() as string;
        const parsed = parseByContentType(t, ct);
        meta.parser = `text(api)->${parsed.kind}`;
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
        return { data: parsed.data, meta };
      } catch (e) {
        phase("body.text.api.error", String(e));
      }
    }

    // 4) פוליביל: קורא Stream ידנית
    const t = await readStreamText(req);
    const parsed = parseByContentType(t, ct);
    meta.parser = `stream->${parsed.kind}`;
    phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
    return { data: parsed.data, meta };
  } catch (e) {
    phase("body.error", String(e));
    return { data: {}, meta };
  }
}

function parseByContentType(t: string, ct: string): { kind: string; data: Record<string, unknown> } {
  if (!t) return { kind: "empty", data: {} };

  // urlencoded
  if (ct === "application/x-www-form-urlencoded" || (t.includes("=") && t.includes("&") && !t.trim().startsWith("{"))) {
    const params = new URLSearchParams(t);
    const r = entriesToObject(params.entries());
    return { kind: "urlencoded", data: r };
  }

  // json
  if (ct === "application/json" || t.trim().startsWith("{") || t.trim().startsWith("[")) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object") return { kind: "json", data: j as Record<string, unknown> };
    } catch {
      // נפל—נחזיר raw
    }
  }

  // text raw
  return { kind: "rawtext", data: { _raw: t } };
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

  // שדות אופציונליים
  const businessType = trim(String((b as any).businessType ?? (b as any)["business_type"] ?? "")) || undefined;
  const phone        = trim(String((b as any).phone ?? "")) || undefined;

  phase("register.fields", { firstName: !!firstName, lastName: !!lastName, email: !!email, password: !!password, confirm: !!confirm });

  if (!firstName || !lastName || !email || !password || !confirm) {
    ctx.response.status = Status.BadRequest;
    phase("register.validation.missing", { firstName, lastName, email, password: password ? `(len:${String(password.length)})` : "", confirm: !!confirm });
    await render(ctx, "auth/register", { title: "הרשמה", page: "register", error: "נא למלא את כל השדות החיוניים" });
    return;
  }
  if (password !== confirm) {
    ctx.response.status = Status.BadRequest;
    phase("register.validation.mismatch");
    await render(ctx, "auth/register", { title: "הרשמה", page: "register", error: "אימות סיסמה לא תואם" });
    return;
  }

  if (await findUserByEmail(email)) {
    ctx.response.status = Status.Conflict;
    phase("register.conflict.email", email);
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
  phase("register.created", { userId: created.id });

  // שלח אימייל verify
  const token = await createVerifyToken(created.id);
  try {
    await sendVerifyEmail(created.email, token);
    phase("register.verify.sent", { email: created.email });
  } catch (e) {
    phase("register.verify.error", String(e));
  }

  // היכנס אוטומטית
  const session = (ctx.state as any)?.session;
  try {
    if (session?.set) await session.set("userId", created.id);
    phase("register.session.set", { userId: created.id, hasSession: !!session });
  } catch (e) {
    phase("register.session.error", String(e));
  }

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?welcome=1");
});

/* --------- Login --------- */
authRouter.get("/auth/login", async (ctx) => {
  await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

authRouter.post("/auth/login", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("login.input", { meta, keys: Object.keys(b) });

  const email = lower(String((b as any).email ?? (b as any).username ?? ""));
  const password = String((b as any).password ?? "");

  if (!email || !password) {
    ctx.response.status = Status.BadRequest;
    phase("login.validation.missing", { email: !!email, password: !!password });
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "נא למלא דוא״ל וסיסמה" });
    return;
  }

  const user = await findUserByEmail(email) ?? await findUserByUsername(email);
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    phase("login.notfound", email);
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  const ok = await verifyPassword(password, (user as any).passwordHash);
  phase("login.password.verify", { ok });
  if (!ok) {
    ctx.response.status = Status.Unauthorized;
    await render(ctx, "auth/login", { title: "התחברות", page: "login", error: "דוא״ל או סיסמה שגויים" });
    return;
  }

  const session = (ctx.state as any)?.session;
  try {
    if (session?.set) await session.set("userId", user.id);
    phase("login.session.set", { userId: user.id, hasSession: !!session });
  } catch (e) {
    phase("login.session.error", String(e));
  }

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

/* --------- Email Verify --------- */
authRouter.get("/auth/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    phase("verify.badtoken");
    await render(ctx, "verify_notice", { title: "אימות אימייל", page: "verify", error: "קישור אימות לא תקין" });
    return;
  }
  const used = await useVerifyToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    phase("verify.notused");
    await render(ctx, "verify_notice", { title: "אימות אימייל", page: "verify", error: "קישור פג או לא תקין" });
    return;
  }
  await setEmailVerified(used.userId);
  phase("verify.ok", { userId: used.userId });
  await render(ctx, "verify_done", { title: "אימות הושלם", page: "verify" });
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
    phase("forgot.validation.missing");
    await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", error: "נא להזין דוא״ל" });
    return;
  }
  const user = await findUserByEmail(email);
  if (user) {
    const token = await createResetToken(user.id);
    try {
      await sendResetEmail(email, token);
      phase("forgot.sent", { email });
    } catch (e) {
      phase("forgot.send.error", String(e));
    }
  }
  // גם אם לא קיים — לא חושפים
  await render(ctx, "auth/forgot", { title: "שכחתי סיסמה", page: "forgot", info: "אם הדוא״ל קיים, נשלח קישור איפוס" });
});

authRouter.get("/auth/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") || "";
  if (!token) {
    ctx.response.status = Status.BadRequest;
    phase("reset.badtoken");
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "קישור לא תקין" });
    return;
  }
  await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

authRouter.post("/auth/reset", async (ctx) => {
  const { data: b, meta } = await readBody(ctx);
  phase("reset.input", { meta, keys: Object.keys(b) });

  const token   = String((b as any).token ?? "");
  const pw      = String((b as any).password ?? "");
  const confirm = String((b as any).confirm ?? (b as any).passwordConfirm ?? "");

  if (!token || !pw || !confirm) {
    ctx.response.status = Status.BadRequest;
    phase("reset.validation.missing", { token: !!token, pw: !!pw, confirm: !!confirm });
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "נא למלא את כל השדות" });
    return;
  }
  if (pw !== confirm) {
    ctx.response.status = Status.BadRequest;
    phase("reset.validation.mismatch");
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token, error: "אימות סיסמה לא תואם" });
    return;
  }

  const used = await useResetToken(token);
  if (!used) {
    ctx.response.status = Status.BadRequest;
    phase("reset.token.invalid");
    await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", error: "קישור פג או לא תקין" });
    return;
  }

  const hash = await hashPassword(pw);
  await updateUserPassword(used.userId, hash);
  phase("reset.ok", { userId: used.userId });

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/?resetOk=1");
});

export { authRouter };
export default authRouter;
