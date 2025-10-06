// src/server.ts
// GeoTable – Oak server (extended, cleaned & ordered)
// -------------------------------------------------------------
// כולל:
// - Error handler גלובלי (עם סטאק ללוג)
// - Request ID + Logger מפורט (שיטה, נתיב, סטטוס, משך, משתמש מחובר)
// - כותרות אבטחה (CSP בסיסי, HSTS ב-HTTPS, X-Frame-Options, X-Content-Type-Options וכו')
// - כפיית HTTPS בפרודקשן (במיוחד עבור cookies מאובטחים)
// - Session middleware (cookie) + טעינת משתמש ל-ctx.state.user
// - Static files תחת /public אל /static
// - Root router: דף בית (תוצאות גם כשיש q, לא רק כשsearch=1), /__health, /__echo, /__mailtest, /__env
// - חיבור כל הראוטרים: auth, restaurants, owner, admin, owner_capacity, owner_manage, owner_hours
// - טיפול 404/405/OPTIONS, וכן graceful shutdown
// -------------------------------------------------------------

import {
  Application,
  Router,
  isHttpError,
  Status,
} from "jsr:@oak/oak";

import { render } from "./lib/view.ts";
import sessionMiddleware from "./lib/session.ts";

import { authRouter } from "./routes/auth.ts";
import { restaurantsRouter } from "./routes/restaurants.ts";
import { ownerRouter } from "./routes/owner.ts";
import { adminRouter } from "./routes/admin.ts";
import rootRouter from "./routes/root.ts";
import ownerCapacityRouter from "./routes/owner_capacity.ts";
import { listRestaurants, getUserById } from "./database.ts";
import { sendVerifyEmail } from "./lib/mail.ts";
import ownerManageRouter from "./routes/owner_manage.ts";
import { ownerHoursRouter } from "./routes/owner_hours.ts";

// -------------------- ENV --------------------
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";
const BASE_URL = Deno.env.get("BASE_URL") ?? ""; // לדוגמת קישורי אימות
const NODE_ENV = Deno.env.get("NODE_ENV") ?? "production"; // "development" | "production"
const TRUST_PROXY = true; // ב-Deno Deploy מאחורי פרוקסי

// תג בנייה ללוג/דיבוג (עוזר לוודא שהגרסה החדשה עלתה)
const BUILD_TAG = new Date().toISOString();

// -------------------- UTIL --------------------
function genReqId(): string {
  return crypto.randomUUID().slice(0, 8);
}
function nowIso() {
  return new Date().toISOString();
}
function getClientIp(ctx: any): string | undefined {
  if (TRUST_PROXY) {
    const fwd = ctx.request.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]?.trim();
  }
  return (ctx.request as any).ip;
}
function isHttps(ctx: any): boolean {
  if (ctx.request.secure) return true;
  if (TRUST_PROXY) {
    const proto = ctx.request.headers.get("x-forwarded-proto");
    if (proto && proto.toLowerCase() === "https") return true;
  }
  try {
    const url = ctx.request.url;
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

// -------------------- APP --------------------
const app = new Application();

// --- Request ID ---
app.use(async (ctx, next) => {
  (ctx.state as any).reqId = genReqId();
  await next();
});

// --- Global error handler ---
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const reqId = (ctx.state as any).reqId;
    if (isHttpError(err)) {
      console.error(`[ERR ${reqId}] ${err.status} ${err.message}\n${err.stack ?? ""}`);
      ctx.response.status = err.status;
      ctx.response.body = err.expose ? err.message : "Internal Server Error";
    } else {
      console.error(`[ERR ${reqId}] UNCAUGHT:`, err?.stack ?? err);
      ctx.response.status = 500;
      ctx.response.body = "Internal Server Error";
    }
  }
});

// --- Security headers ---
app.use(async (ctx, next) => {
  ctx.response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';",
  );
  ctx.response.headers.set("X-Frame-Options", "DENY");
  ctx.response.headers.set("X-Content-Type-Options", "nosniff");
  ctx.response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  ctx.response.headers.set("Permissions-Policy", "geolocation=(), microphone=()");
  if (isHttps(ctx)) {
    ctx.response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  await next();
});

// --- Force HTTPS in production ---
app.use(async (ctx, next) => {
  if (NODE_ENV !== "development" && !isHttps(ctx)) {
    const url = ctx.request.url;
    const httpsUrl = `https://${url.host}${url.pathname}${url.search}`;
    ctx.response.status = Status.PermanentRedirect;
    ctx.response.headers.set("Location", httpsUrl);
    return;
  }
  await next();
});

// --- Logger ---
app.use(async (ctx, next) => {
  const t0 = performance.now();
  const reqId = (ctx.state as any).reqId;
  const ip = getClientIp(ctx) ?? "-";
  await next();
  const user = (ctx.state as any).user;
  const userTag = user ? `${user.email}(${user.id})` : "-";
  const dt = performance.now() - t0;
  console.log(
    `[RES ${reqId}] ${ctx.response.status} ${ctx.request.method} ${ctx.request.url.pathname}` +
      ` ${dt.toFixed(1)}ms ip=${ip} user=${userTag}`,
  );
});

// --- Session middleware ---
app.use(sessionMiddleware);

// --- Load user from session ---
app.use(async (ctx, next) => {
  try {
    const session = (ctx.state as any).session;
    const uid = session ? await session.get("userId") : null;
    if (uid) {
      const user = await getUserById(uid);
      if (user) (ctx.state as any).user = user;
    }
  } catch (e) {
    console.warn("[user-loader] failed:", e);
  }
  await next();
});

// --- Static files (/static/* -> public/*) ---
app.use(async (ctx, next) => {
  const p = ctx.request.url.pathname;
  if (!p.startsWith("/static/")) return await next();
  const filePath = p.slice("/static".length) || "/";
  try {
    // @ts-ignore oak ctx.send
    await ctx.send({
      root: "public",
      path: filePath,
      index: "index.html",
    });
  } catch {
    await next();
  }
});

// --- No-cache לאיזור האדמין + X-Build-Tag לכל תגובה ---
app.use(async (ctx, next) => {
  await next();
  ctx.response.headers.set("X-Build-Tag", BUILD_TAG);
  if (ctx.request.url.pathname.startsWith("/admin")) {
    ctx.response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    ctx.response.headers.set("Pragma", "no-cache");
    ctx.response.headers.set("Expires", "0");
  }
});

// -------------------- ROOT ROUTER (inline) --------------------
const root = new Router();

// דף הבית – מציג תוצאות גם כשיש q, לא רק כשsearch=1
root.get("/", async (ctx) => {
  const url = ctx.request.url;
  const q = url.searchParams.get("q")?.toString() ?? "";
  const search = url.searchParams.get("search")?.toString() ?? "";
  const shouldSearch = search === "1" || q.trim().length > 0;
  const restaurants = shouldSearch ? await listRestaurants(q, true) : [];
  await render(ctx, "index", {
    restaurants,
    q,
    search: shouldSearch ? "1" : "",
    page: "home",
    title: "GeoTable — חיפוש מסעדה",
  });
});

// Health
root.get("/__health", (ctx) => {
  ctx.response.status = 200;
  ctx.response.body = "OK " + nowIso();
});

// Echo
root.get("/__echo", (ctx) => {
  const info = {
    method: ctx.request.method,
    url: ctx.request.url.href,
    path: ctx.request.url.pathname,
    query: Object.fromEntries(ctx.request.url.searchParams),
    headers: Object.fromEntries(ctx.request.headers),
    now: nowIso(),
  };
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify(info, null, 2);
});

// Mail test (מאובטח ב-ADMIN_SECRET)
root.get("/__mailtest", async (ctx) => {
  const key = ctx.request.url.searchParams.get("key") ?? "";
  const to = ctx.request.url.searchParams.get("to") ?? "";
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "Unauthorized";
    return;
  }
  if (!to) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "missing ?to=";
    return;
  }
  const fakeToken = crypto.randomUUID().replace(/-/g, "");
  await sendVerifyEmail(to, fakeToken);
  ctx.response.body = "sent (or dry-run logged)";
});

// Env info (מאובטח)
root.get("/__env", (ctx) => {
  const key = ctx.request.url.searchParams.get("key") ?? "";
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = "Unauthorized";
    return;
  }
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({
    time: nowIso(),
    port: PORT,
    baseUrl: BASE_URL || "(not set)",
    nodeEnv: NODE_ENV,
    adminSecretSet: Boolean(ADMIN_SECRET),
  }, null, 2);
});

app.use(root.routes());
app.use(root.allowedMethods());

// -------------------- FEATURE ROUTERS (ordered, no duplicates) --------------------
// אימות/משתמשים
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());

// ראוטרים ציבוריים של מסעדות
app.use(restaurantsRouter.routes());
app.use(restaurantsRouter.allowedMethods());

// ראוטרים לבעלים
app.use(ownerRouter.routes());
app.use(ownerRouter.allowedMethods());

// יכולות בעלים נוספות (capacity/config)
app.use(ownerCapacityRouter.routes());
app.use(ownerCapacityRouter.allowedMethods());

// מסכי ניהול כלליים לבעלים
app.use(ownerManageRouter.routes());
app.use(ownerManageRouter.allowedMethods());

// מסך שעות פתיחה לבעלים (הלב של הבאג שתוקן)
app.use(ownerHoursRouter.routes());
app.use(ownerHoursRouter.allowedMethods());

// ראוטר שורש נוסף מהפרויקט (עמודים נוספים)
app.use(rootRouter.routes());
app.use(rootRouter.allowedMethods());

// --- OPTIONS (כללי) ---
app.use(async (ctx, next) => {
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = Status.NoContent;
    return;
  }
  await next();
});

// --- 404 (כללי) ---
app.use((ctx) => {
  if (ctx.response.body == null) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Not Found";
  }
});

// -------------------- GRACEFUL SHUTDOWN --------------------
const controller = new AbortController();
for (const s of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(s, () => {
    console.log(`\n[SHUTDOWN] Received ${s}, closing...`);
    controller.abort();
  });
}

// -------------------- START --------------------
console.log(
  `[BOOT] GeoTable up on :${PORT} (env=${NODE_ENV}) BASE_URL=${BASE_URL || "(not set)"} BUILD_TAG=${BUILD_TAG}`,
);
await app.listen({ port: PORT, signal: controller.signal });
console.log("[BOOT] server stopped");
