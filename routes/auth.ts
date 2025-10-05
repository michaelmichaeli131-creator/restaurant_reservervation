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

/* ---------------- Utils ---------------- */

function lower(s?: string) { return (s ?? "").trim().toLowerCase(); }
function pad2(n: number) { return n.toString().padStart(2, "0"); }

/* ---------------- Strong readBody (robust across Oak/Deno Deploy/Proxies) ----------------

Tries oak.body with multiple types (form/json/form-data/text/bytes)

Tries native Fetch API methods (formData/json/text) if available

Merges URL query params as last resort

Ignores unknown/empty values, keeps last non-empty
------------------------------------------------------------------------------------------ */

async function readBody(ctx: any): Promise<Record<string, unknown>> {
const dbgPhases: Array<Record<string, unknown>> = [];
const phase = (name: string, data?: unknown) => {
try { dbgPhases.push({ name, data }); } catch {}
};

const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
for (const [k, v] of Object.entries(src || {})) {
if (v !== undefined && v !== null && v !== "") dst[k] = v;
}
return dst;
};

const fromEntries = (iter: Iterable<[string, FormDataEntryValue]> | URLSearchParams) => {
const o: Record<string, unknown> = {};
// deno-lint-ignore no-explicit-any
for (const [k, v0] of (iter as any).entries?.() ?? []) {
const v = typeof v0 === "string" ? v0 : (v0?.name ?? "");
o[k] = v;
}
return o;
};

const out: Record<string, unknown> = {};
const req: any = ctx.request as any;

async function tryOak(kind: "form" | "form-data" | "json" | "text" | "bytes") {
try {
const b = await req.body?.({ type: kind });
if (!b) return;
const t = b.type;
if (t === "form") {
const v = await b.value as URLSearchParams;
const o = fromEntries(v);
phase("oak.body(form)", o);
merge(out, o);
} else if (t === "form-data") {
const v = await b.value;
const r = await v.read();
const o = (r?.fields ?? {}) as Record<string, unknown>;
phase("oak.body(form-data)", o);
merge(out, o);
} else if (t === "json") {
const j = await b.value as Record<string, unknown>;
phase("oak.body(json)", j);
merge(out, j || {});
} else if (t === "text") {
const txt = await b.value as string;
phase("oak.body(text)", txt?.slice?.(0, 200));
try {
const j = JSON.parse(txt);
phase("oak.body(text->json)", j);
merge(out, j as any);
} catch {
const sp = new URLSearchParams(txt);
const o = fromEntries(sp);
if (Object.keys(o).length) {
phase("oak.body(text->urlencoded)", o);
merge(out, o);
}
}
} else if (t === "bytes") {
const u8 = await b.value as Uint8Array;
const txt = new TextDecoder().decode(u8);
phase("oak.body(bytes)", txt?.slice?.(0, 200));
try {
const j = JSON.parse(txt);
phase("oak.body(bytes->json)", j);
merge(out, j as any);
} catch {
const sp = new URLSearchParams(txt);
const o = fromEntries(sp);
if (Object.keys(o).length) {
phase("oak.body(bytes->urlencoded)", o);
merge(out, o);
}
}
}
} catch (e) {
phase(oak.body(${kind}).error, String(e));
}
}

await tryOak("form");
await tryOak("json");
await tryOak("form-data");
await tryOak("text");
await tryOak("bytes");

// Native fetch fallbacks (Deno Deploy)
const native: any = req.originalRequest;
try {
if (native?.formData) {
const fd = await native.formData();
const o = fromEntries(fd);
if (Object.keys(o).length) { phase("native.formData", o); merge(out, o); }
}
} catch (e) { phase("native.formData.error", String(e)); }
try {
if (native?.json) {
const j = await native.json();
if (j && typeof j === "object") { phase("native.json", j); merge(out, j as any); }
}
} catch (e) { phase("native.json.error", String(e)); }
try {
if (native?.text) {
const t = await native.text();
if (t) {
phase("native.text", t?.slice?.(0, 200));
try {
const j = JSON.parse(t);
phase("native.text->json", j);
merge(out, j as any);
} catch {
const sp = new URLSearchParams(t);
const o = fromEntries(sp);
if (Object.keys(o).length) { phase("native.text->urlencoded", o); merge(out, o); }
}
}
}
} catch (e) { phase("native.text.error", String(e)); }

// Merge query string last (helps in edge-cases with proxies stripping body)
const qs = Object.fromEntries(ctx.request.url.searchParams);
if (Object.keys(qs).length) {
phase("querystring", qs);
for (const [k, v] of Object.entries(qs)) {
if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
}
}

phase("finalKeys", Object.keys(out));
// הדפסה עדינה ללוגים לצורך דיבוג בשטח (לשקול לנטרל בפרודקשן)
try { console.log("[auth.readBody] keys:", Object.keys(out)); } catch {}

return out;
}

export const authRouter = new Router();

/* ---------------- Login ---------------- */

authRouter.get("/auth/login", async (ctx) => {
await render(ctx, "auth/login", { title: "התחברות", page: "login" });
});

authRouter.post("/auth/login", async (ctx) => {
const b = await readBody(ctx);

// קבלת אימייל גם משמות חלופיים
const email = lower(
(b.email as string) ??
(b.username as string) ??
(b.user as string) ??
(b.login as string) ??
(b.mail as string)
);
const pw = String(b.password ?? "");

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

const session = (ctx.state as any)?.session;
if (session?.set) await session.set("userId", user.id);

ctx.response.status = Status.SeeOther;
ctx.response.headers.set("Location", "/");
});

/* ---------------- Logout ---------------- */

authRouter.get("/auth/logout", async (ctx) => {
const session = (ctx.state as any)?.session;
if (session?.set) await session.set("userId", null);
ctx.response.status = Status.SeeOther;
ctx.response.headers.set("Location", "/");
});

/* ---------------- Register ---------------- */

authRouter.get("/auth/register", async (ctx) => {
await render(ctx, "auth/register", { title: "הרשמה", page: "register" });
});

authRouter.post("/auth/register", async (ctx) => {
const b = await readBody(ctx);

// תמיכה בשמות חלופיים כדי להימנע מנפילות בין גרסאות טפסים
const firstName =
String((b.firstName ?? (b["first_name"] ?? b.givenName ?? b["given_name"] ?? b.name ?? b.fullName ?? ""))).trim();
const lastName =
String((b.lastName ?? (b["last_name"] ?? b.familyName ?? b["family_name"] ?? ""))).trim();

const email = lower(
(b.email as string) ??
(b.mail as string) ??
(b.username as string) // לעתים שולחים שם משתמש כאימייל
);

const password = String(b.password ?? "");
const confirm = String(
(b.confirm ?? b.passwordConfirm ?? b["password_confirm"] ?? b.passwordConfirmation ?? b["password_confirmation"] ?? "")
);

const age = Number(String(b.age ?? "")) || undefined;
const businessType = String(b.businessType ?? b["business_type"] ?? "").trim() || undefined;

// דיבוג עדין – איזה ערכים התקבלו בפועל (לוג בלבד)
try {
console.log("[register] names:", { firstName, lastName, email, hasPw: !!password, hasConfirm: !!confirm, businessType });
} catch {}

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

const username = lower(String(b.username ?? (email.split("@")[0] ?? "")));
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

const token = await createVerifyToken(user.id, user.email);
await sendVerifyEmail(user.email, token).catch(() => {});

const session = (ctx.state as any)?.session;
if (session?.set) await session.set("userId", user.id);

ctx.response.status = Status.SeeOther;
ctx.response.headers.set("Location", "/");
});

/* ---------------- Email verify ---------------- */

authRouter.get("/auth/verify", async (ctx) => {
const token = ctx.request.url.searchParams.get("token") ?? "";
if (!token) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing token"; return; }

const used = await useVerifyToken(token);
if (!used) { ctx.response.status = Status.BadRequest; ctx.response.body = "invalid/expired token"; return; }

await setEmailVerified(used.userId);
ctx.response.status = Status.SeeOther;
ctx.response.headers.set("Location", "/?verified=1");
});

/* ---------------- Forgot / Reset password ---------------- */

authRouter.get("/auth/forgot", async (ctx) => {
await render(ctx, "auth/forgot", { title: "שחזור סיסמה", page: "forgot" });
});

authRouter.post("/auth/forgot", async (ctx) => {
const body = await readBody(ctx);
const email = lower((body.email as string) ?? (body.username as string) ?? (body.mail as string) ?? "");

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
await render(ctx, "auth/forgot", { title: "שחזור סיסמה", page: "forgot", ok: "אם המשתמש קיים, נשלח מייל לשחזור." });
});

authRouter.get("/auth/reset", async (ctx) => {
const token = ctx.request.url.searchParams.get("token") ?? "";
if (!token) { ctx.response.status = Status.BadRequest; ctx.response.body = "missing token"; return; }
await render(ctx, "auth/reset", { title: "איפוס סיסמה", page: "reset", token });
});

authRouter.post("/auth/reset", async (ctx) => {
const body = await readBody(ctx);

const token = String(body.token ?? "");
const pw = String(body.password ?? "");
const confirm = String((body.confirm ?? body.passwordConfirm ?? body["password_confirm"] ?? ""));

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

export default authRouter;