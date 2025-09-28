// server.ts
import { Application, Router, type Context } from "jsr:@oak/oak";
import { send } from "jsr:@oak/oak/send";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

import { authRouter } from "./routes/auth.ts";
import { restaurantsRouter } from "./routes/restaurants.ts";
import { ownerRouter } from "./routes/owner.ts";

import { initSession } from "./lib/session.ts";
import { listRestaurants, findUserByEmail } from "./database.ts";
import { render } from "./lib/view.ts";

const PORT = Number(Deno.env.get("APP_PORT") ?? 8000);
const DEBUG = (Deno.env.get("DEBUG") ?? "1") !== "0";

function rid() {
  return crypto.randomUUID().slice(0, 8);
}

// ---------- create app ----------
const app = new Application();

// ---------- middlewares ----------
const errorHandler = async (ctx: Context, next: () => Promise<unknown>) => {
  try {
    await next();
  } catch (err) {
    console.error("[ERR] UNCAUGHT:", err?.stack ?? err);
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error";
  }
};

const logger = async (ctx: Context, next: () => Promise<unknown>) => {
  const id = rid();
  const t0 = performance.now();
  console.log(
    `[REQ ${id}] ${ctx.request.method} ${ctx.request.url.pathname}${ctx.request.url.search}`,
  );
  await next();
  const ms = (performance.now() - t0).toFixed(1);
  console.log(
    `[RES ${id}] ${ctx.response.status ?? "-"} ${ctx.request.method} ${ctx.request.url.pathname} ${ms}ms`,
  );
};

const staticMw = async (ctx: Context, next: () => Promise<unknown>) => {
  const p = ctx.request.url.pathname;
  if (p.startsWith("/static/")) {
    await send(ctx, p.replace("/static", ""), { root: `${Deno.cwd()}/public` });
    return;
  }
  await next();
};

app.use(errorHandler);
app.use(logger);
app.use(staticMw);
app.use(oakCors());

// ---------- sessions ----------
await initSession(app);

// ---------- DEBUG ----------
if (DEBUG) {
  const dbg = new Router();

  // בריאות
  dbg.get("/__health", (ctx) => {
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.type = "text";
    ctx.response.body = "OK " + new Date().toISOString();
  });

  // עיון בקבצים שרצים בדפלוי (רשימת Allow מוגבלת)
  dbg.get("/__file", async (ctx) => {
    ctx.response.headers.set("Cache-Control", "no-store");
    const name = ctx.request.url.searchParams.get("name") || "";
    const allow: Record<string, string> = {
      "routes/auth.ts": `${Deno.cwd()}/routes/auth.ts`,
      "routes/restaurants.ts": `${Deno.cwd()}/routes/restaurants.ts`,
      "routes/owner.ts": `${Deno.cwd()}/routes/owner.ts`,
      "lib/auth.ts": `${Deno.cwd()}/lib/auth.ts`,
      "server.ts": `${Deno.cwd()}/server.ts`,
    };
    const path = allow[name];
    if (!path) {
      ctx.response.status = 400;
      ctx.response.body = "bad or disallowed name";
      return;
    }
    try {
      const txt = await Deno.readTextFile(path);
      ctx.response.type = "text";
      ctx.response.body = txt;
    } catch (e) {
      ctx.response.status = 404;
      ctx.response.body = `not found: ${path} (${String(e?.message ?? e)})`;
    }
  });

  // דיאגנוסטיקה לחשבונות (עוזר מול "Invalid credentials")
  dbg.get("/__auth-check", async (ctx) => {
    const email = ctx.request.url.searchParams.get("email")?.toLowerCase().trim();
    if (!email) {
      ctx.response.status = 400;
      ctx.response.body = "email=?";
      return;
    }
    const u = await findUserByEmail(email);
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.type = "json";
    ctx.response.body = JSON.stringify({
      found: !!u,
      id: u?.id ?? null,
      role: u?.role ?? null,
      hashPrefix:
        typeof u?.passwordHash === "string"
          ? u.passwordHash.split("$")[0]
          : null,
      provider: u?.provider ?? null,
    });
  });

  app.use(dbg.routes());
  app.use(dbg.allowedMethods());
}

// ---------- public home ----------
const root = new Router();

root.get("/", async (ctx) => {
  const q = ctx.request.url.searchParams.get("q")?.toString() ?? "";
  const restaurants = await listRestaurants(q);
  await render(ctx, "index", {
    restaurants,
    q,
    page: "home",
    title: "GeoTable — חיפוש מסעדה",
  });
});

app.use(root.routes());
app.use(root.allowedMethods());

// ---------- app routers ----------
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());

app.use(restaurantsRouter.routes());
app.use(restaurantsRouter.allowedMethods());

app.use(ownerRouter.routes());
app.use(ownerRouter.allowedMethods());

// ---------- start ----------
console.log(`[BOOT] listening on :${PORT}`);
await app.listen({ port: PORT });
