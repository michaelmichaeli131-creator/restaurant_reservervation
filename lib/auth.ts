// routes/auth.ts
import { Router } from "@oak/oak";
import { createUser, findUserByEmail } from "../database.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const OAUTH_CALLBACK_URL = Deno.env.get("OAUTH_CALLBACK_URL");
const OAUTH_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && OAUTH_CALLBACK_URL);

export const authRouter = new Router();

authRouter.get("/login", async (ctx) => {
  if (ctx.request.url.searchParams.get("plain") === "1") {
    ctx.response.headers.set("Content-Type", "text/plain; charset=utf-8");
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.body = "LOGIN PAGE PLAIN " + new Date().toISOString();
    return;
  }
  await render(ctx, "login", { oauthEnabled: OAUTH_ENABLED, page: "login", title: "התחברות" });
});

authRouter.get("/signup", async (ctx) => {
  await render(ctx, "signup", { page: "signup", title: "הרשמה" });
});

// Signup
authRouter.post("/signup", async (ctx) => {
  const reqId = crypto.randomUUID().slice(0, 6);
  try {
    const form = await ctx.request.formData();
    const email = form.get("email")?.toString().trim().toLowerCase();
    const pw = form.get("password")?.toString() ?? "";
    const role = (form.get("role")?.toString() as "user" | "owner") ?? "user";
    console.log(`[AUTH ${reqId}] signup attempt email=${email} role=${role}`);

    if (!email || !pw) {
      console.warn(`[AUTH ${reqId}] missing fields`);
      ctx.response.status = 400; ctx.response.body = "Missing fields"; return;
    }
    const existing = await findUserByEmail(email);
    if (existing) {
      console.warn(`[AUTH ${reqId}] email exists`);
      ctx.response.status = 409; ctx.response.body = "Email already used"; return;
    }

    const passwordHash = await hashPassword(pw);
    const id = crypto.randomUUID();
    const user = await createUser({ id, email, passwordHash, role, provider: "local" });

    await (ctx.state as any).session.set("userId", user.id);
    console.log(`[AUTH ${reqId}] signup OK user=${user.id}`);
    ctx.response.redirect("/");
  } catch (err) {
    console.error(`[AUTH ${reqId}] signup error:`, err?.stack ?? err);
    ctx.response.status = 500; ctx.response.body = "Signup failed (server)";
  }
});

// Login
authRouter.post("/login", async (ctx) => {
  const reqId = crypto.randomUUID().slice(0, 6);
  try {
    const form = await ctx.request.formData();
    const email = form.get("email")?.toString().trim().toLowerCase();
    const pw = form.get("password")?.toString() ?? "";
    console.log(`[AUTH ${reqId}] login attempt email=${email}`);

    const user = email ? await findUserByEmail(email) : null;
    if (!user || !user.passwordHash) {
      console.warn(`[AUTH ${reqId}] invalid credentials (no user or no hash)`);
      ctx.response.status = 401; ctx.response.body = "Invalid credentials"; return;
    }
    const ok = await verifyPassword(pw, user.passwordHash);
    if (!ok) {
      console.warn(`[AUTH ${reqId}] invalid password`);
      ctx.response.status = 401; ctx.response.body = "Invalid credentials"; return;
    }

    await (ctx.state as any).session.set("userId", user.id);
    console.log(`[AUTH ${reqId}] login OK user=${user.id}`);
    ctx.response.redirect("/");
  } catch (err) {
    console.error(`[AUTH ${reqId}] login error:`, err?.stack ?? err);
    ctx.response.status = 500; ctx.response.body = "Login failed (server)";
  }
});

authRouter.post("/logout", async (ctx) => {
  await (ctx.state as any).session.set("userId", null);
  ctx.response.redirect("/");
});

// OAuth נשאיר אופציונלי
