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
  await render(ctx, "login", { oauthEnabled: OAUTH_ENABLED });
});

authRouter.get("/signup", async (ctx) => {
  await render(ctx, "signup");
});

authRouter.post("/signup", async (ctx) => {
  const body = await ctx.request.body({ type: "form" }).value;
  const email = body.get("email")?.toString().trim().toLowerCase();
  const pw = body.get("password")?.toString() ?? "";
  const role = (body.get("role")?.toString() as "user" | "owner") ?? "user";

  if (!email || !pw) { ctx.response.status = 400; ctx.response.body = "Missing fields"; return; }
  const existing = await findUserByEmail(email);
  if (existing) { ctx.response.status = 409; ctx.response.body = "Email already used"; return; }

  const passwordHash = await hashPassword(pw);
  const id = crypto.randomUUID();
  const user = await createUser({ id, email, passwordHash, role, provider: "local" });

  await ctx.state.session.set("userId", user.id);
  ctx.response.redirect("/");
});

authRouter.post("/login", async (ctx) => {
  const body = await ctx.request.body({ type: "form" }).value;
  const email = body.get("email")?.toString().trim().toLowerCase();
  const pw = body.get("password")?.toString() ?? "";
  const user = email ? await findUserByEmail(email) : null;

  if (!user || !user.passwordHash) { ctx.response.status = 401; ctx.response.body = "Invalid credentials"; return; }
  const ok = await verifyPassword(pw, user.passwordHash);
  if (!ok) { ctx.response.status = 401; ctx.response.body = "Invalid credentials"; return; }

  await ctx.state.session.set("userId", user.id);
  ctx.response.redirect("/");
});

authRouter.post("/logout", async (ctx) => {
  await ctx.state.session.set("userId", null);
  ctx.response.redirect("/");
});

if (OAUTH_ENABLED) {
  const { createGoogleOAuthConfig, createHelpers } = await import("@deno/kv-oauth");

  const google = createGoogleOAuthConfig({
    redirectUri: OAUTH_CALLBACK_URL!,
    scope: ["openid", "email", "profile"],
  });
  const { signIn, handleCallback, signOut } = createHelpers(google);

  authRouter.get("/oauth/google", signIn);
  authRouter.get("/oauth/callback", async (ctx) => {
    const { response, session, tokens, state } = await handleCallback(ctx.request);
    const email = (state as any)?.token?.email ?? (tokens as any)?.idToken?.email;
    if (!email) return response;

    const existing = await findUserByEmail(email.toLowerCase());
    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const id = crypto.randomUUID();
      const user = await createUser({ id, email: email.toLowerCase(), role: "user", provider: "google" });
      userId = user.id;
    }
    await session.set("userId", userId);
    return Response.redirect(new URL("/", ctx.request.url).toString(), 302);
  });
  authRouter.get("/oauth/signout", signOut);
}
