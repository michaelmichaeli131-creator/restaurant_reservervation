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

/* ---------- helpers to access original Fetch Request (not Oak wrapper) ---------- */
function getFetchRequest(ctx: any): Request | null {
  // Oak exposes the underlying fetch Request in some properties depending on version:
  // - ctx.request.originalRequest
  // - ctx.request.rawRequest
  // - ctx.request.secureRequest (rare)
  // - ctx.requestEvent?.request
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

  // urlencoded (explicit ct, או detect לפי תבנית)
  if (base === "application/x-www-form-urlencoded" ||
      (t.includes("=") && t.includes("&") && !t.trim().startsWith("{"))) {
    const params = new URLSearchParams(t);
    return { kind: "urlencoded", data: entriesToObject(params.entries()) };
  }

  // json
  if (base === "application/json" || t.trim().startsWith("{") || t.trim().startsWith("[")) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === "object") return { kind: "json", data: j as Record<string, unknown> };
    } catch { /* fallthrough to raw */ }
  }

  // raw text
  return { kind: "rawtext", data: { _raw: t } };
}

/**
 * Universal body reader for Oak/Deno Deploy:
 * 1) Try Oak API: ctx.request.body({type:"form"|"json"|"text"}).
 * 2) Else use underlying Fetch Request (originalRequest/rawRequest/requestEvent.request):
 *    - prefer .formData()/.json()/.text() if exist
 *    - fallback to stream getReader() on original Fetch Request (NOT on ctx.request)
 */
async function readBody(ctx: any): Promise<{ data: Record<string, unknown>; meta: Record<string,string> }> {
  // Collect meta
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
    fetchHasFormDataFn: typeof fetchReq?.formData === "function",
    fetchHasJsonFn: typeof fetchReq?.json === "function",
    fetchHasTextFn: typeof fetchReq?.text === "function",
    fetchHasStream: !!fetchReq?.body,
  });

  // 1) Oak API path
  try {
    if (typeof oakReq?.body === "function") {
      // Choose explicit parser to avoid double consumption
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
      // fall back to text
      const txt = await oakReq.body({ type: "text" }).value as string;
      const parsed = parseByContentType(txt, ct);
      meta.parser = `oak:text->${parsed.kind}`;
      phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
      return { data: parsed.data, meta };
    }
  } catch (e) {
    phase("body.oak.error", String(e));
  }

  // 2) Fetch Request path (preferred on Deno Deploy)
  if (fetchReq) {
    // Use native helpers if available
    try {
      if ((ct === "application/x-www-form-urlencoded" || ct === "multipart/form-data") &&
          typeof fetchReq.formData === "function") {
        const fd = await fetchReq.formData();
        const r = formDataToObject(fd);
        meta.parser = ct.includes("multipart") ? "fetch:formData(multipart)" : "fetch:formData(urlencoded)";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      }
    } catch (e) {
      phase("body.fetch.formData.error", String(e));
    }

    try {
      if (ct === "application/json" && typeof fetchReq.json === "function") {
        const j = await fetchReq.json() as Record<string, unknown>;
        const r = j ?? {};
        meta.parser = "fetch:json";
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(r) });
        return { data: r, meta };
      }
    } catch (e) {
      phase("body.fetch.json.error", String(e));
    }

    try {
      if (typeof fetchReq.text === "function") {
        const t = await fetchReq.text();
        const parsed = parseByContentType(t, ct);
        meta.parser = `fetch:text->${parsed.kind}`;
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
        return { data: parsed.data, meta };
      }
    } catch (e) {
      phase("body.fetch.text.error", String(e));
    }

    // 2c) Raw stream (only on original Fetch Request)
    try {
      if (fetchReq.body) {
        const t = await readAllFromStream(fetchReq as Request);
        const parsed = parseByContentType(t, ct);
        meta.parser = `fetch:stream->${parsed.kind}`;
        phase("body.parsed", { parser: meta.parser, keys: Object.keys(parsed.data) });
        return { data: parsed.data, meta };
      }
    } catch (e) {
      phase("body.fetch.stream.error", String(e));
    }
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

  // אופציונלי
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

  // שליחת אימות
  const token = await createVerifyToken(created.id);
  try { await sendVerifyEmail(created.email, token); phase("register.verify.sent", { email: created.email }); }
  catch (e) { phase("register.verify.error", String(e)); }

  // session
  const session = (ctx.state as any)?.session;
  try {
    if (session?.set) await session.set("userId", created.id);
    phase("register.session.set", { userId: created.id, hasSession: !!session });
  } catch (e) { phase("register.session.error", String(e)); }

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

  const user = await (findUserByEmail(email) ?? findUserByUsername(email));
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
