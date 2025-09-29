// src/routes/auth.ts
import { Router } from "jsr:@oak/oak";
import { createUser, findUserByEmail, createVerifyToken, useVerifyToken, setEmailVerified } from "../database.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { render } from "../lib/view.ts";
import { sendVerifyEmail } from "../lib/mail.ts";

export const authRouter = new Router();

authRouter.get("/login", async (ctx) => {
  await render(ctx, "login", { title: "התחברות" });
});
authRouter.get("/owner/login", async (ctx) => {
  await render(ctx, "login", { intendedRole: "owner", title: "כניסת מנהלים" });
});
authRouter.get("/signup", async (ctx) => {
  await render(ctx, "signup", { title: "הרשמה" });
});

// Signup + שליחת מייל אימות
authRouter.post("/signup", async (ctx) => {
  try {
    const form = await ctx.request.body.form();
    const email = form.get("email")?.toString().trim().toLowerCase();
    const pw = form.get("password")?.toString() ?? "";
    const role = (form.get("role")?.toString() as "user" | "owner") ?? "user";
    if (!email || !pw) { ctx.response.status = 400; ctx.response.body = "Missing fields"; return; }

    const existing = await findUserByEmail(email);
    if (existing) { await render(ctx, "signup", { error: "Email already used", title: "הרשמה" }); return; }

    const passwordHash = await hashPassword(pw);
    const id = crypto.randomUUID();
    const user = await createUser({ id, email, passwordHash, role, provider: "local" });

    const token = await createVerifyToken(user.id, user.email);
    await sendVerifyEmail(user.email, token);

    await (ctx.state as any).session.set("userId", user.id);
    await render(ctx, "verify_notice", { email: user.email, title: "נשלח אימייל אימות" });
  } catch (err) {
    console.error("[AUTH signup] error:", err);
    ctx.response.status = 500; ctx.response.body = "Signup failed";
  }
});

// Login + בדיקת אימות
authRouter.post("/login", async (ctx) => {
  const form = await ctx.request.body.form();
  const email = form.get("email")?.toString().trim().toLowerCase();
  const pw = form.get("password")?.toString() ?? "";
  const intendedRole = form.get("intendedRole")?.toString();

  const user = email ? await findUserByEmail(email) : null;
  if (!user || !user.passwordHash || !(await verifyPassword(pw, user.passwordHash))) {
    await render(ctx, "login", { intendedRole, error: "Invalid credentials", title: "התחברות" }); return;
  }

  if (!user.emailVerified) {
    const token = await createVerifyToken(user.id, user.email);
    await sendVerifyEmail(user.email, token);
    await render(ctx, "verify_notice", { email: user.email, title: "נדרש אימות מייל" }); return;
  }

  if (intendedRole === "owner" && user.role !== "owner") {
    await render(ctx, "login", { intendedRole, error: "המשתמש אינו מנהל/בעל מסעדה", title: "כניסת מנהלים" }); return;
  }

  await (ctx.state as any).session.set("userId", user.id);
  ctx.response.redirect(intendedRole === "owner" ? "/owner" : "/");
});

// קישור אימות
authRouter.get("/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  const v = await useVerifyToken(token);
  if (!v) { ctx.response.status = 400; ctx.response.body = "Invalid/expired token"; return; }
  await setEmailVerified(v.userId);
  await render(ctx, "verify_done", { title: "האימות בוצע בהצלחה" });
});

authRouter.post("/logout", async (ctx) => {
  await (ctx.state as any).session.set("userId", null);
  ctx.response.redirect("/");
});
