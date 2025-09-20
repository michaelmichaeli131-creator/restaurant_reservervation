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

const app = new Application();

// Static files (serve /public under /static/)
app.use(async (ctx, next) => {
  const p = ctx.request.url.pathname;
  if (p.startsWith("/static/")) {
    await send(ctx, p.replace("/static", ""), { root: `${Deno.cwd()}/public` });
    return;
  }
  await next();
});

// CORS
app.use(oakCors());

// Session & user attach
await initSession(app);

// Home
const rootRouter = new Router();
rootRouter.get("/", async (ctx) => {
  const restaurants: any[] = [];
  for await (const entry of kv.list({ prefix: ["restaurant"] })) {
    restaurants.push(entry.value);
  }
  await render(ctx, "index", { restaurants });
});

// Routes
app.use(rootRouter.routes());
app.use(rootRouter.allowedMethods());
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());
app.use(restaurantsRouter.routes());
app.use(restaurantsRouter.allowedMethods());
app.use(ownerRouter.routes());
app.use(ownerRouter.allowedMethods());

console.log(`Server running on http://localhost:${PORT}`);
await app.listen({ port: PORT });
