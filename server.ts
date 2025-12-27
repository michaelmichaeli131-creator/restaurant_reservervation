// src/server.ts
// GeoTable – Oak server (extended, cleaned & ordered)
// -------------------------------------------------------------
// כולל:
// - Error handler גלובלי (עם סטאק ללוג)
// - Request ID + Logger מפורט (שיטה, נתיב, סטטוס, משך, משתמש מחובר)
// - כותרות אבטחה (CSP בסיסי, HSTS ב-HTTPS, X-Frame-Options, X-Content-Type-Options וכו')
// - כפיית HTTPS בפרודקשן (במיוחד עבור cookies מאובטחים)
// - Session middleware (cookie) + טעינת משתמש ל-ctx.state.user
// - Static files /public/*
// - Root router: דף בית (תוצאות גם כשיש q, לא רק כשsearch=1), /__health, /__echo, /__mailtest, /__env
// - חיבור כל הראוטרים + owner_calendar + floor + shifts
// - טיפול 404/405/OPTIONS, וכן graceful shutdown
// -------------------------------------------------------------

import {
  Application,
  Router,
  isHttpError,
  Status,
} from "jsr:@oak/oak";
import { send } from "jsr:@oak/oak/send";

import { render } from "./lib/view.ts";
import sessionMiddleware from "./lib/session.ts";

import { authRouter } from "./routes/auth.ts";
import { restaurantsRouter } from "./routes/restaurants/index.ts";
import { ownerRouter } from "./routes/owner.ts";
import { adminRouter } from "./routes/admin.ts";
import rootRouter from "./routes/root.ts";
import ownerCapacityRouter from "./routes/owner_capacity.ts";
import { ownerStaffRouter } from "./routes/owner_staff.ts";

import {
  listRestaurants,
  listRestaurantsByCategory,
  getUserById,
  type KitchenCategory,
} from "./database.ts";
import { sendVerifyEmail } from "./lib/mail_wrappers.ts";
import ownerManageRouter from "./routes/owner_manage.ts";
import { ownerHoursRouter } from "./routes/owner_hours.ts";
import ownerPhotosRouter from "./routes/owner_photos.ts";
import { requestLogger } from "./lib/log_mw.ts";
import { diagRouter } from "./routes/diag.ts";
import openingRouter from "./routes/opening.ts";
import { posRouter } from "./routes/pos.ts";
import { hostRouter } from "./routes/host.ts";
import { staffContextMiddleware } from "./middleware/staff_context.ts";
import ownerBillsRouter from "./routes/owner_bills.ts";
import inventoryRouter from "./routes/inventory.ts";
import { reservationPortal } from "./routes/reservation_portal.ts";
import { staffTimeRouter } from "./routes/staff_time.ts";
import { ownerTimeRouter } from "./routes/owner_time.ts";
import { timeClockRouter } from "./routes/timeclock.ts";
import { ownerPayrollRouter } from "./routes/owner_payroll.ts";


// ✅ i18n: טעינה בטוחה (תומך גם default וגם named export)
import * as i18nModule from "./middleware/i18n.ts";

import langRouter from "./routes/lang.ts";
import reviewsRouter from "./routes/reviews.ts";
import reviewPortalRouter from "./routes/review_portal.ts";

// ✅ חדש: ראוטר ניהול תפוסה יומי (Calendar/Timeline)
import { ownerCalendarRouter } from "./routes/owner_calendar.ts";

// ✅ Floor plan management
import { ownerFloorRouter } from "./routes/owner_floor.ts";

// ✅ Shift management
import { ownerShiftsRouter } from "./routes/owner_shifts.ts";

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
  // @ts-ignore oak adds .secure in some runtimes
  if ((ctx.request as any).secure) return true;
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
      console.error(
        `[ERR ${reqId}] ${err.status} ${err.message}\n${(err as any).stack ?? ""}`,
      );
      ctx.response.status = err.status;
      ctx.response.body = (err as any).expose
        ? (err as any).message
        : "Internal Server Error";
    } else {
      console.error(`[ERR ${reqId}] UNCAUGHT:`, (err as any)?.stack ?? err);
      ctx.response.status = 500;
      ctx.response.body = "Internal Server Error";
    }
  }
});

// --- Security headers (CSP כולל blob: לתמונות preview) ---
app.use(async (ctx, next) => {
  ctx.response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';",
  );
  ctx.response.headers.set("X-Frame-Options", "DENY");
  ctx.response.headers.set("X-Content-Type-Options", "nosniff");
  ctx.response.headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin",
  );
  ctx.response.headers.set(
    "Permissions-Policy",
    "geolocation=(), microphone=()",
  );
  if (isHttps(ctx)) {
    ctx.response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
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

// --- Logger (פשוט) ---
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
      else (ctx.state as any).user = null;
    } else {
      (ctx.state as any).user = null;
    }
  } catch (e) {
    console.warn("[user-loader] failed:", e);
    (ctx.state as any).user = null;
  }
  await next();
});

// --- Load staff context (for role="staff") ---
app.use(staffContextMiddleware());

// --- 🔎 Request logger המפורט שלך — ממוקם מוקדם כדי לעטוף הכל ---
app.use(requestLogger());

/* --- Static files (/public/* -> <CWD>/public/*) --- */
app.use(async (ctx, next) => {
  const p = ctx.request.url.pathname;
  if (p.startsWith("/public/")) {
    const rel = p.slice("/public/".length);
    await send(ctx, rel, {
      root: `${Deno.cwd()}/public`,
    });
    return;
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
    await (ctx as any).send({
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
    ctx.response.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, max-age=0",
    );
    ctx.response.headers.set("Pragma", "no-cache");
    ctx.response.headers.set("Expires", "0");
  }
});

// -------------------- i18n FIRST (חשוב!) --------------------
const i18nMw =
  (i18nModule as any).i18n ??
  (i18nModule as any).default;

if (typeof i18nMw !== "function") {
  throw new Error(
    "i18n middleware not found. Expected export const i18n or export default function in ./middleware/i18n.ts",
  );
}

// ✅ i18n וה־/lang חייבים לבוא לפני כל ראוטר שמרנדר HTML
app.use(i18nMw);
app.use(langRouter.routes());
app.use(langRouter.allowedMethods());

// -------------------- ROOT ROUTER (inline) --------------------
const root = new Router();

// דף הבית – מציג תוצאות גם כשיש q, לא רק כשsearch=1
root.get("/", async (ctx) => {
  const url = ctx.request.url;
  const q = url.searchParams.get("q")?.toString() ?? "";
  const search = url.searchParams.get("search")?.toString() ?? "";
  const category = url.searchParams.get("category")?.toString() ?? "";

  let restaurants: any[] = [];

  if (category && category.trim()) {
    // Filter by category
    restaurants = await listRestaurantsByCategory(
      category as KitchenCategory,
      true,
    );
  } else {
    // Text search
    const shouldSearch = search === "1" || q.trim().length > 0;
    restaurants = shouldSearch ? await listRestaurants(q, true) : [];
  }

  await render(ctx, "index", {
    restaurants,
    q,
    search: (search === "1" || q.trim().length > 0) ? "1" : "",
    category,
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
  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
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
  ctx.response.headers.set(
    "Content-Type",
    "application/json; charset=utf-8",
  );
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

// -------------------- AUTH GATE (חדש) --------------------
app.use(async (ctx, next) => {
  const path = ctx.request.url.pathname;

  const needsAuth =
    path.startsWith("/owner") ||
    path.startsWith("/dashboard") ||
    path.startsWith("/manage") ||
    path.startsWith("/opening");

  const user = (ctx.state as any).user;

  // 🔎 לוג מפורט ל-Auth Gate
  console.log("[AUTH_GATE] check", {
    path,
    needsAuth,
    hasUser: Boolean(user),
    userId: user?.id,
    userEmail: user?.email,
    role: user?.role,
  });

  if (!needsAuth) {
    console.log("[AUTH_GATE] path does not need auth, continue", { path });
    return await next();
  }

  if (!user) {
    const redirect = "/auth/login?redirect=" +
      encodeURIComponent(path);
    console.log("[AUTH_GATE] no user, redirect to login", {
      path,
      redirect,
    });
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", redirect);
    return;
  }

  if (!user.emailVerified) {
    console.warn("[AUTH_GATE] blocked – email not verified", {
      userId: user.id,
      email: user.email,
      path,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "נדרש אימות דוא״ל לפני גישה לאזור זה.";
    return;
  }

  if (user.isActive === false) {
    console.warn("[AUTH_GATE] blocked – user inactive", {
      userId: user.id,
      email: user.email,
      path,
    });
    ctx.response.status = Status.Forbidden;
    ctx.response.body = "החשבון מבוטל. פנה/י לתמיכה.";
    return;
  }

  console.log("[AUTH_GATE] access granted", {
    path,
    userId: user.id,
    role: user.role,
  });

  await next();
});

// -------------------- FEATURE ROUTERS (ordered) --------------------

// לוג קצר לכל בקשה (debug)
app.use(async (ctx, next) => {
  console.log(
    `[DEBUG] incoming: ${ctx.request.method} ${ctx.request.url.pathname}`,
  );
  await next();
});

// אימות/משתמשים
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());

// Staff management (owner)
app.use(ownerStaffRouter.routes());
app.use(ownerStaffRouter.allowedMethods());

// פורטל הזמנות (מייל)
app.use(reservationPortal.routes());
app.use(reservationPortal.allowedMethods());

// אדמין
app.use(adminRouter.routes());
app.use(adminRouter.allowedMethods());

// ראוטרים לבעלים - הספציפיים ביותר קודם
app.use(ownerCalendarRouter.routes());
app.use(ownerCalendarRouter.allowedMethods());

app.use(ownerHoursRouter.routes());
app.use(ownerHoursRouter.allowedMethods());

app.use(ownerCapacityRouter.routes());
app.use(ownerCapacityRouter.allowedMethods());

app.use(ownerManageRouter.routes());
app.use(ownerManageRouter.allowedMethods());

// ✅ קודם ראוטרים ספציפיים
app.use(ownerPhotosRouter.routes());
app.use(ownerPhotosRouter.allowedMethods());

app.use(ownerShiftsRouter.routes());
app.use(ownerShiftsRouter.allowedMethods());

// ✅ ואז ownerRouter הכללי
app.use(ownerRouter.routes());
app.use(ownerRouter.allowedMethods());

// Floor plan management
app.use(ownerFloorRouter.routes());
app.use(ownerFloorRouter.allowedMethods());

// debug/diag
app.use(diagRouter.routes());
app.use(diagRouter.allowedMethods());

// ראוטרים ציבוריים של מסעדות
app.use(restaurantsRouter.routes());
app.use(restaurantsRouter.allowedMethods());

// POS (כולל WS + מסכים)
app.use(posRouter.routes());
app.use(posRouter.allowedMethods());

// Host (מארחת)
app.use(hostRouter.routes());
app.use(hostRouter.allowedMethods());

// Reviews API
app.use(reviewsRouter.routes());
app.use(reviewsRouter.allowedMethods());

// Review Portal (token-based review submission)
app.use(reviewPortalRouter.routes());
app.use(reviewPortalRouter.allowedMethods());

// אחרי app.use(rootRouter.routes()) וכו׳
app.use(ownerBillsRouter.routes());
app.use(ownerBillsRouter.allowedMethods());

// hours
app.use(openingRouter.routes());
app.use(openingRouter.allowedMethods());

app.use(inventoryRouter.routes());
app.use(inventoryRouter.allowedMethods());

app.use(staffTimeRouter.routes());
app.use(staffTimeRouter.allowedMethods());

app.use(ownerTimeRouter.routes());
app.use(ownerTimeRouter.allowedMethods());

app.use(ownerStaffRouter.routes());
app.use(ownerStaffRouter.allowedMethods());

app.use(ownerPayrollRouter.routes());
app.use(ownerPayrollRouter.allowedMethods());

// ⬅️ TimeClock (staff + owner/manager)
app.use(timeClockRouter.routes());
app.use(timeClockRouter.allowedMethods());

// --- 404 (כללי) ---
app.use((ctx) => {
  if (ctx.response.body == null) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Not Found";
  }
});

// -------------------- GRACEFUL SHUTDOWN --------------------
const controller = new AbortController();
const signals = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"] as const
  : ["SIGINT", "SIGTERM"] as const;

for (const s of signals) {
  Deno.addSignalListener(s, () => {
    console.log(`\n[SHUTDOWN] Received ${s}, closing...`);
    controller.abort();
  });
}

// -------------------- START --------------------
console.log(
  `[BOOT] GeoTable up on :${PORT} (env=${NODE_ENV}) BASE_URL=${
    BASE_URL || "(not set)"
  } BUILD_TAG=${BUILD_TAG}`,
);
await app.listen({ port: PORT, signal: controller.signal });
console.log("[BOOT] server stopped");
