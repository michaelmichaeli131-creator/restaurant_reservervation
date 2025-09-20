import { Router } from "@oak/oak";
import { kv, createUser, findUserByEmail } from "../database.ts";
import { renderFile } from "@eta/eta";
import { hashPassword, verifyPassword } from "../lib/auth.ts";
import { createGoogleOAuthConfig, createHelpers } from "@deno/kv-oauth";

export const authRouter = new Router();

async function render(ctx: any, tpl: string, data: Record<string, unknown> = {}) {
  const html = await renderFile(`${Deno.cwd()}/templates/${tpl}.eta`, { ...data, user: ctx.state.user ?? null });
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html;
}

authRouter.get("/login", async (ctx) => await render(ctx, "login"));
authRouter.get("/signup", async (ctx) => await render(ctx, "signup"));

authRouter.post("/signup", async (ctx) => {
  const body = await ctx.request.body({ type: "form" }).value;
  const email = body.get("email")?.toString().trim().toLowerCase();
  const pw = body.get("password")?.toString() ?? "";
  const role = (body.get("role")?.toString() as "user"|"owner") ?? "user";

  if (!email || !pw) { ctx.response.status = 400; ctx.response.body = "Missing fields"; return; }
  const existing = await findUserByEmail(email);
  if (existing) { ctx.response.status = 409; ctx.response.body = "Email already used"; return; }

  const passwordHash = await hashPassword(pw);
  const id = crypto.randomUUID();
  const user = await createUser({ id, email, passwordHash, role, provider: "local" });

  await (ctx.state as any).session.set("userId", user.id);
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

  await (ctx.state as any).session.set("userId", user.id);
  ctx.response.redirect("/");
});

authRouter.post("/logout", async (ctx) => {
  await (ctx.state as any).session.set("userId", null);
  ctx.response.redirect("/");
});

// OAuth (Google)
const google = createGoogleOAuthConfig({
  redirectUri: Deno.env.get("OAUTH_CALLBACK_URL")!,
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
