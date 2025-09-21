import { Application, Router, Context } from "@oak/oak";
import { send } from "@oak/oak/send";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { authRouter } from "./routes/auth.ts";
import { restaurantsRouter } from "./routes/restaurants.ts";
import { ownerRouter } from "./routes/owner.ts";
import { initSession } from "./lib/session.ts";
import { kv } from "./database.ts";
import { render } from "./lib/view.ts";

const PORT = Number(Deno.env.get("APP_PORT") ?? 8000);

function rid() { return crypto.randomUUID().slice(0, 8); }

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
  console.log(`[REQ ${id}] ${ctx.request.method} ${ctx.request.url.pathname}`);
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

const app = new Application();
app.use(errorHandler);
app.use(logger);
app.use(staticMw);
app.use(oakCors());

await initSession(app);

// Home
const root = new Router();
root.get("/", async (ctx) => {
  const restaurants: any[] = [];
  for await (const entry of kv.list({ prefix: ["restaurant"] })) {
    restaurants.push(entry.value);
  }
  await render(ctx, "index", { restaurants });
});

app.use(root.routes());
app.use(root.allowedMethods());

// Routers
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());

app.use(restaurantsRouter.routes());
app.use(restaurantsRouter.allowedMethods());

app.use(ownerRouter.routes());
app.use(ownerRouter.allowedMethods());

console.log(`[BOOT] listening on :${PORT}`);
await app.listen({ port: PORT });
