// server.ts
import { Application, Router, Context } from "@oak/oak";
import { send } from "@oak/oak/send";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

import { authRouter } from "./routes/auth.ts";
import { restaurantsRouter } from "./routes/restaurants.ts";
import { ownerRouter } from "./routes/owner.ts";
import { initSession } from "./lib/session.ts";
import { listRestaurants } from "./database.ts";
import { render } from "./lib/view.ts";

const PORT = Number(Deno.env.get("APP_PORT") ?? 8000);
const DEBUG = (Deno.env.get("DEBUG") ?? "1") !== "0";

function rid() { return crypto.randomUUID().slice(0, 8); }

// ---------- create app FIRST ----------
const app = new Application();

// ---------- middlewares ----------
const errorHandler = async (ctx: Context, next: () => Promise<unknown>) => {
  try { await next(); }
  catch (err) {
    console.error("[ERR] UNCAUGHT:", err?.stack ?? err);
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error";
  }
};

const logger = async (ctx: Context, next: () => Promise<unknown>) => {
  const id = rid();
  const t0 = performance.now();
  console.log(`[REQ ${id}] ${ctx.request.method} ${ctx.request.url.pathname}${ctx.request.url.search}`);
  await next();
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`[RES ${id}] ${ctx.response.status ?? "-"} ${ctx.request.method} ${ctx.request.url.pathname} ${ms}ms`);
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

// sessions
await initSession(app);

// ---------- DEBUG routes (add AFTER app exists) ----------
if (DEBUG) {
  const dbg = new Router();

  dbg.get("/__health", (ctx) => {
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.type = "text";
    ctx.response.body = "OK " + new Date().toISOString();
  });

  dbg.get("/__echo", (ctx) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of ctx.request.headers) headers[k] = v;
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.type = "json";
    ctx.response.body = {
      method: ctx.request.method,
      url: ctx.request.url.toString(),
      path: ctx.request.url.pathname,
      query: Object.fromEntries(ctx.request.url.searchParams.entries()),
      headers,
      now: new Date().toISOString(),
    };
  });

  dbg.get("/__plain", (ctx) => {
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.type = "text";
    ctx.response.body = "PLAIN PAGE " + new Date().toISOString();
  });

  // עיון בקבצי תבניות (גודל/רשימה)
  dbg.get("/__templates", async (ctx) => {
    const dir = `${Deno.cwd()}/templates`;
    const items: Array<{ name: string; size: number | null }> = [];
    try {
      for await (const ent of Deno.readDir(dir)) {
        if (!ent.isFile || !ent.name.endsWith(".eta")) continue;
        try {
          const st = await Deno.stat(`${dir}/${ent.name}`);
          items.push({ name: ent.name, size: st.size });
        } catch { items.push({ name: ent.name, size: null }); }
      }
    } catch (e) {
      ctx.response.status = 500;
      ctx.response.body = { error: "readDir failed", message: String(e?.message ?? e) };
      return;
    }
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.type = "json";
    ctx.response.body = { dir, items };
  });

  // קריאת קבצים מהדיפלוי (מוגבל לרשימה בטוחה)
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
    if (!path) { ctx.response.status = 400; ctx.response.body = "bad or disallowed name"; return; }
    try {
      const txt = await Deno.readTextFile(path);
      ctx.response.type = "text";
      ctx.response.body = txt;
    } catch (e) {
      ctx.response.status = 404;
      ctx.response.body = `not found: ${path} (${String(e?.message ?? e)})`;
    }
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
