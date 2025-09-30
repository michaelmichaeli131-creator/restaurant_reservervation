// src/routes/auth.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  createUser,
  findUserByEmail,
  findUserByUsername,
  createVerifyToken,
  useVerifyToken,
  setEmailVerified,
  createResetToken,
  useResetToken,
  updateUserPassword,
} from "../database.ts";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { render } from "../lib/view.ts";
import { sendVerifyEmail, sendPasswordResetEmail } from "../lib/mail.ts";

export const authRouter = new Router();

// ----- Login -----
authRouter.get("/login", async (ctx) => {
  await render(ctx, "login", { title: "התחברות" });
});
authRouter.get("/owner/login", async (ctx) => {
  await render(ctx, "login", { intendedRole: "owner", title: "כניסת מנהלים" });
});
authRouter.post("/login", async (ctx) => {
  const form = await ctx.request.body.formData();
  const email = (form.get("email")?.toString() ?? "").trim();
  const password = form.get("password")?.toString() ?? "";
  const intendedRole = form.get("intendedRole")?.toString() ?? "";

  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await render(ctx, "login", { error: "אימייל או סיסמה שגויים", intendedRole });
    return;
  }
  if (intendedRole === "owner" && user.role !== "owner") {
    await render(ctx, "login", { error: "אין לך הרשאות מנהל", intendedRole });
    return;
  }
  await (ctx.state as any).session.set("userId", user.id);
  ctx.response.redirect("/");
});

// ----- Signup -----
authRouter.get("/signup", async (ctx) => {
  await render(ctx, "signup", { title: "הרשמה" });
});

authRouter.post("/signup", async (ctx) => {
  const form = await ctx.request.body.formData();
  const firstName = (form.get("firstName")?.toString() ?? "").trim();
  const lastName  = (form.get("lastName")?.toString() ?? "").trim();
  const username  = (form.get("username")?.toString() ?? "").trim();
  const ageStr    = (form.get("age")?.toString() ?? "").trim();
  const businessType = (form.get("businessType")?.toString() ?? "").trim();
  const email     = (form.get("email")?.toString() ?? "").trim();
  const password  = form.get("password")?.toString() ?? "";
  const confirm   = form.get("confirm")?.toString() ?? "";
  const role      = (form.get("role")?.toString() ?? "user") as "user" | "owner";

  const age = ageStr ? Number(ageStr) : undefined;

  const errors: string[] = [];
  if (!firstName) errors.push("יש להזין שם");
  if (!lastName)  errors.push("יש להזין שם משפחה");
  if (!username)  errors.push("יש להזין שם משתמש");
  if (!email)     errors.push("יש להזין כתובת דואר אלקטרוני");
  if (!password)  errors.push("יש להזין סיסמה");
  if (password && password.length < 6) errors.push("סיסמה חייבת להיות באורך 6 תווים לפחות");
  if (password !== confirm) errors.push("אימות סיסמה לא תואם");
  if (role !== "user" && role !== "owner") errors.push("תפקיד לא תקף");

  const emailExists = email ? await findUserByEmail(email) : null;
  const userExists  = username ? await findUserByUsername(username) : null;
  if (emailExists) errors.push("דואר אלקטרוני כבר קיים");
  if (userExists)  errors.push("שם המשתמש כבר קיים");

  if (errors.length) {
    await render(ctx, "signup", {
      error: errors.join(" · "),
      form: { firstName, lastName, username, age: ageStr, businessType, email, role },
      title: "הרשמה",
    });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({
    id: crypto.randomUUID(),
    email,
    username,
    firstName,
    lastName,
    age,
    businessType,
    passwordHash,
    role,
    provider: "local",
  });

  const token = await createVerifyToken(user.id, user.email);
  await sendVerifyEmail(user.email, token);

  await (ctx.state as any).session.set("userId", user.id);
  ctx.response.redirect("/");
});

// ----- Email Verify -----
authRouter.get("/verify", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  const v = await useVerifyToken(token);
  if (!v) { ctx.response.status = Status.BadRequest; ctx.response.body = "Invalid/expired token"; return; }
  await setEmailVerified(v.userId);
  await render(ctx, "verify_done", { title: "האימות בוצע בהצלחה" });
});

// ----- Forgot / Reset password -----
authRouter.get("/forgot", async (ctx) => {
  await render(ctx, "forgot", { title: "שחזור סיסמה" });
});

authRouter.post("/forgot", async (ctx) => {
  const form = await ctx.request.body.formData();
  const email = (form.get("email")?.toString() ?? "").trim();
  const user = email ? await findUserByEmail(email) : null;

  if (user) {
    const token = await createResetToken(user.id);
    await sendPasswordResetEmail(user.email, token);
  }
  await render(ctx, "verify_notice", { title: "נשלחה הודעת שחזור", message: "אם החשבון קיים – נשלח מייל שחזור." });
});

authRouter.get("/reset", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token") ?? "";
  await render(ctx, "reset", { title: "איפוס סיסמה", token });
});

authRouter.post("/reset", async (ctx) => {
  const form = await ctx.request.body.formData();
  const token = (form.get("token")?.toString() ?? "").trim();
  const password = form.get("password")?.toString() ?? "";
  const confirm  = form.get("confirm")?.toString() ?? "";

  if (!password || password.length < 6 || password !== confirm) {
    await render(ctx, "reset", { title: "איפוס סיסמה", token, error: "סיסמה לא תקפה או אימות לא תואם" });
    return;
  }

  const info = await useResetToken(token);
  if (!info) {
    await render(ctx, "reset", { title: "איפוס סיסמה", error: "קישור לא תקף/פג תוקף" });
    return;
  }
  const hash = await hashPassword(password);
  await updateUserPassword(info.userId, hash);
  await render(ctx, "verify_done", { title: "הסיסמה אופסה בהצלחה" });
});

// ----- Logout -----
authRouter.post("/logout", async (ctx) => {
  await (ctx.state as any).session.set("userId", null);
  ctx.response.redirect("/");
});
