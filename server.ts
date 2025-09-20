// server.ts
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
const NODE_ENV = Deno.env.get("NODE_ENV") ?? "production";

// helper: יצירת מזהה קצר לבקשה
function rid() {
  return crypto.randomUUID().split("-")[0];
}

/** ---- Error handler גלובלי ----
 * לוכד חריגות שלא טופלו ומדפיס ללוג. */
const errorHandler = async (ctx: Context, next: () => Promise<unknown>) => {
  try {
    await next();
  } catch (err) {
    // לוג קריטי
    console.error("[ERR] UNCAUGHT ERROR:", {
      url: ctx.request.url.href,
      method: ctx.request.method,
      stack: err?.stack ?? String(err),
    });
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error";
  }
};

/** ---- Logger ----
 * מדפיס לכל בקשה: זמן תגובה, סטטוס, שיטה, נתיב, מזהה בקשה, ו-userId אם קיים. */
const requestLogger = async (ctx: Context, next: () => Promise<unknown>) => {
  const id = rid();
  const start = performance.now();
  // לוג כניסה
  console.log(`[REQ ${id}] ${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
  const ms = (performance.now() - start).toFixed(1);
  const userId = (ctx.state as any)?.user?.id ? ` u=${(ctx.state as any).user.id}` : "";
  console.log(
    `[RES ${id}] ${ctx.response.status ?? "-"} ${ctx.request.method} ${ctx.request.url.pathname} ${ms}ms${userId}`,
  );
};

/** ---- Static middleware ----
 * מגיש קבצים מ-public תחת /static */
const staticMiddleware = async (ctx: Context, next: () => Promise<unknown>) => {
  const p = ctx.request.url.pathname;
  if (p.startsWith("/static/")) {
    const filePath = p.replace("/static", "");
    // לוג דיבאג לקבצים סטטיים
    console.debug(`[DBG] static -> ${filePath}`);
    await send(ctx, filePath, { root: `${Deno.cwd()}/public` });
    return;
  }
  await next();
};

/** ---- Home route handler ----
 * טוען מסעדות מ-KV ומרנדר index. מדפיס ללוג כמה נמצאו. */
async function handleHome(ctx: Context) {
  console.debug("[DBG] / -> start list restaurants");
  const restaurants: any[] = [];
  try {
    for await (const entry of kv.list({ prefix: ["restaurant"] })) {
      restaurants.push(entry.value);
    }
    console.debug(`[DBG] / -> restaurants found: ${restaurants.length}`);
  } catch (e) {
    console.error("[ERR] KV list restaurants failed:", e?.stack ?? e);
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error (kv)";
    return;
  }

  try {
    await render(ctx, "index", { restaurants });
    console.debug("[DBG] / -> render index ok");
  } catch (e) {
    // (render כבר מדווח שגיאה ב-lib/view.ts, זה גיבוי)
    console.error("[ERR] render index failed:", e?.stack ?? e);
  }
}

/** ---- App bootstrap ---- */
const app = new Application();

// הדפסה עם עליית השרת
console.log(`[BOOT] starting server on :${PORT} (env=${NODE_ENV})`);

// סדר מידלוורים חשוב:
app.use(errorHandler);
app.use(requestLogger);
app.use(staticMiddleware);
app.use(oakCors());

// סשן + הצמדה של user ל-ctx.state.user
await initSession(app);

// רואטר ראשי
const rootRouter = new Router();
rootRouter.get("/", handleHome);

// חיבור רואטרים
app.use(rootRouter.routes());
app.use(rootRouter.allowedMethods());

app.use(authRouter.routes());
app.use(authRouter.allowedMethods());

app.use(restaurantsRouter.routes());
app.use(restaurantsRouter.allowedMethods());

app.use(ownerRouter.routes());
app.use(ownerRouter.allowedMethods());

// לוג סופי לפני האזנה
console.log("[BOOT] routers mounted. listening...");

await app.listen({ port: PORT });
