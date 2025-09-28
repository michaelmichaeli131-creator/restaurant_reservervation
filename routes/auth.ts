// routes/auth.ts
import { Router } from "jsr:@oak/oak";
import { createUser, findUserByEmail } from "../database.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const OAUTH_CALLBACK_URL = Deno.env.get("OAUTH_CALLBACK_URL");
const OAUTH_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && OAUTH_CALLBACK_URL);

export const authRouter = new Router();

// דף התחברות רגיל
authRouter.get("/login", async (ctx) => {
  await render(ctx, "login", { oauthEnabled: OAUTH_ENABLED, page: "login", title: "התחברות" });
});

// דף "כניסת מנהלים" – רק עטיפה שמזריקה intendedRole=owner
authRouter.get("/owner/login", async (ctx) => {
  await render(ctx, "login", { intendedRole: "owner", page: "login", title: "כניסת מנהלים" });
});

authRouter.get("/signup", async (ctx) => {
  await render(ctx, "signup", { page: "signup", title: "הרשמה" });
});

// Signup (Oak v17)
authRouter.post("/signup", async (ctx) => {
  const reqId = crypto.randomUUID().slice(0, 6);
  try {
    const form = await ctx.request.body.form();
    const email = form.get("email")?.toString().trim().toLowerCase();
    const pw    = form.get("password")?.toString() ?? "";
    const role  = (form.get("role")?.toString() as "user" | "owner") ?? "user";
    if (!email || !pw) { ctx.response.status = 400; ctx.response.body = "Missing fields"; return; }

    const existing = await findUserByEmail(email);
    if (existing) { ctx.response.status = 409; ctx.response.body = "Email already used"; return; }

    const passwordHash = await hashPassword(pw);
    const id = crypto.randomUUID();
    const user = await createUser({ id, email, passwordHash, role, provider: "local" });

    await (ctx.state as any).session.set("userId", user.id);
    ctx.response.redirect("/");
  } catch (err) {
    console.error("[AUTH signup] error:", err?.stack ?? err);
    ctx.response.status = 500; ctx.response.body = "Signup failed (server)";
  }
});

// Login (Oak v17) + אכיפת role אם זו כניסת מנהלים
authRouter.post("/login", async (ctx) => {
  const reqId = crypto.randomUUID().slice(0, 6);
  try {
    const form = await ctx.request.body.form();
    const email = form.get("email")?.toString().trim().toLowerCase();
    const pw    = form.get("password")?.toString() ?? "";
    const intendedRole = form.get("intendedRole")?.toString(); // "owner" או ריק

    const user = email ? await findUserByEmail(email) : null;
    if (!user || !user.passwordHash) {
      await render(ctx, "login", { intendedRole, error: "Invalid credentials", title: "התחברות" });
      return;
    }

    const ok = await verifyPassword(pw, user.passwordHash);
    if (!ok) {
      await render(ctx, "login", { intendedRole, error: "Invalid credentials", title: "התחברות" });
      return;
    }

    // אם זה מסך "כניסת מנהלים" – נדרוש שהמשתמש יהיה owner
    if (intendedRole === "owner" && user.role !== "owner") {
      await render(ctx, "login", { intendedRole, error: "המשתמש אינו מנהל/בעל מסעדה", title: "כניסת מנהלים" });
      return;
    }

    await (ctx.state as any).session.set("userId", user.id);
    // אם זה כניסת מנהלים – ננתב ישירות ללוח מנהלים
    if (intendedRole === "owner") {
      ctx.response.redirect("/owner");
    } else {
      ctx.response.redirect("/");
    }
  } catch (err) {
    console.error(`[AUTH ${reqId}] login error:`, err?.stack ?? err);
    ctx.response.status = 500; ctx.response.body = "Login failed (server)";
  }
});

authRouter.post("/logout", async (ctx) => {
  await (ctx.state as any).session.set("userId", null);
  ctx.response.redirect("/");
});
