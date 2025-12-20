// src/lib/view.ts
// Eta renderer חכם: מאתר ספריית תבניות באופן חסין-פריסה, תומך ב-ENV override,
// ומספק fallback מפורט (HTML/JSON) במקרה כשל.
// שדרוג: טעינת user אוטומטית מה־session אם לא קיים ב-ctx.state.user
//        כך שהתבניות (לרבות ה-layout) יוכלו להציג "פתח/י מסעדה" כשמחוברים.
// NEW:   הזרקת i18n לכל רינדור: lang/dir/t מתוך ctx.state (מ-middleware), עם ברירות מחדל.
// NEW2:  תמיכה במילוני עמודים לפי it.page → /i18n/pages/<page>.<lang>.json, עם קדימות מעל המילון הכללי.
// NEW3:  הזרקת staff-context לתבניות: ctx.state.staff / staffRestaurantId / staffMemberships
//        כדי ש-FE יוכל להציג יכולות לפי הרשאות עובד (staff_db).

import { Eta } from "npm:eta@3.5.0";
import type { Context } from "jsr:@oak/oak";
import { getUserById } from "../database.ts";

// --------- איתור ספריית התבניות ---------
const ENV_DIR =
  Deno.env.get("TEMPLATES_DIR") ??
  Deno.env.get("VIEWS_DIR") ??
  "";

function candidatePaths(): string[] {
  const p0 = ENV_DIR || "";
  const p1 = "/templates";
  const p2 = "/src/templates";
  let p3 = "", p4 = "";
  try {
    p3 = new URL("../../templates", import.meta.url).pathname;
  } catch {}
  try {
    p4 = new URL("../templates", import.meta.url).pathname;
  } catch {}
  const p5 = "./templates";
  const p6 = "templates";
  return Array.from(new Set([p0, p1, p2, p3, p4, p5, p6].filter(Boolean)));
}

function dirJoin(a: string, b: string) {
  return (a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")).replace(/\/+/g, "/");
}

const PROBES = [
  "_layout.eta",
  "index.eta",
  "restaurant.eta",
  "auth/login.eta",
  "auth/register.eta",
];

function dirLooksLikeViews(dir: string): boolean {
  // deno-lint-ignore no-explicit-any
  const statSync = (Deno as any).statSync?.bind(Deno);
  if (!statSync) return false;
  for (const rel of PROBES) {
    try {
      const full = dirJoin(dir, rel);
      statSync(full);
      return true;
    } catch {}
  }
  return false;
}

const CANDIDATES = candidatePaths();

const PICKED_VIEWS_DIR = (() => {
  for (const p of CANDIDATES) {
    if (dirLooksLikeViews(p)) return p;
  }
  return ENV_DIR || "/templates";
})();

// --------- Eta instance ---------
const eta = new Eta({
  views: PICKED_VIEWS_DIR,
  cache: true,
  async: true,
  useWith: true,
  autoEscape: true,
});

// --------- Helpers ---------
function wantsJSON(ctx: Context) {
  const acc = ctx.request.headers.get("accept")?.toLowerCase() ?? "";
  return acc.includes("application/json") || acc.includes("json");
}

function escapeHtml(s: unknown) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fallbackHtml(
  title: string,
  info: Record<string, unknown>,
  lang = "he",
  dir: "rtl" | "ltr" = lang === "he" ? "rtl" : "ltr",
) {
  const safeTitle = title || "GeoTable";
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${escapeHtml(dir)}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(safeTitle)}</title>
  <link rel="stylesheet" href="/static/styles.css"/>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:900px;margin:32px auto;padding:0 16px}
    .card{border:1px solid #eee;border-radius:12px;padding:16px}
    pre{background:#f6f6f8;border:1px solid #eee;border-radius:8px;padding:12px;overflow:auto}
    .muted{color:#777}
    code{background:#f6f6f8;border:1px solid #eee;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h1 style="margin-top:0">${escapeHtml(safeTitle)}</h1>
  <div class="card">
    <p class="muted">תבנית לא נמצאה או נכשלה ברינדור. מוצג fallback.</p>
    <p class="muted">chosen views: <code>${escapeHtml(PICKED_VIEWS_DIR)}</code></p>
    <p class="muted">candidates: <code>${escapeHtml(CANDIDATES.join(", "))}</code></p>
    <pre>${escapeHtml(JSON.stringify(info, null, 2))}</pre>
  </div>
</body>
</html>`;
}

async function ensureStateUser(ctx: Context): Promise<any | null> {
  // deno-lint-ignore no-explicit-any
  const stateAny = ctx.state as any;
  if (stateAny?.user) return stateAny.user;
  try {
    const session = stateAny?.session;
    const userId = session && (await session.get?.("userId"));
    if (userId) {
      const user = await getUserById(String(userId));
      if (user) {
        stateAny.user = user;
        return user;
      }
    }
  } catch {}
  return null;
}

// --- i18n Page-dict helpers ---
type Dict = Record<string, unknown>;

function getPath(obj: any, path: string): unknown {
  if (!obj) return undefined;
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function interpolate(s: string, vars?: Record<string, unknown>) {
  return !vars ? s : s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

function pageDictFile(page: string, lang: string): string[] {
  // ננסה כמה וריאציות יחסיות לקובץ הזה ואל ה־CWD
  const arr: string[] = [];
  try {
    arr.push(new URL(`../i18n/pages/${page}.${lang}.json`, import.meta.url).pathname);
  } catch {}
  try {
    arr.push(new URL(`../../i18n/pages/${page}.${lang}.json`, import.meta.url).pathname);
  } catch {}
  arr.push(`./i18n/pages/${page}.${lang}.json`);
  arr.push(`i18n/pages/${page}.${lang}.json`);
  return Array.from(new Set(arr));
}

async function tryLoadJson(paths: string[]): Promise<Dict | null> {
  for (const p of paths) {
    try {
      const txt = await Deno.readTextFile(p);
      const obj = JSON.parse(txt) as Dict;
      return obj;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * בונה פונקציית t שמעניקה קדימות למילון-עמוד (אם קיים),
 * ואז נופלת ל-t הבסיסית שמגיע מה־middleware.
 */
function makePageAwareT(
  baseT: (k: string, v?: Record<string, unknown>) => string,
  pageDict: Dict | null,
) {
  return (key: string, vars?: Record<string, unknown>) => {
    if (pageDict) {
      const hit = getPath(pageDict, key);
      if (typeof hit === "string") return interpolate(hit, vars);
    }
    return baseT(key, vars);
  };
}

// --------- Public API ---------
export async function render(
  ctx: Context,
  template: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const user = await ensureStateUser(ctx);

  // deno-lint-ignore no-explicit-any
  const stateAny = ctx.state as any;

  const lang = stateAny?.lang ?? "he";
  const dir: "rtl" | "ltr" = stateAny?.dir ?? (lang === "he" ? "rtl" : "ltr");
  const baseT: (key: string, vars?: Record<string, unknown>) => string =
    stateAny?.t ?? ((k: string) => `(${k})`);

  // ---- NEW3: staff context (מגיע מ-middleware של staff_db) ----
  // חשוב: אל תשנה את המבנים האלה אם הם כבר בשימוש אצלך.
  // אם אין middleware שמגדיר אותם, הם פשוט יהיו null/[].
  const staff = stateAny?.staff ?? null;
  const staffRestaurantId = stateAny?.staffRestaurantId ?? null;
  const staffMemberships = stateAny?.staffMemberships ?? [];

  // נסה לטעון מילון-עמוד (אם ניתן להסיק page מהדאטה)
  // מוסכמה: אם data.page === "home" נטען /i18n/pages/home.<lang>.json
  // אם לא הועבר page, ננסה לגזור מהשם "index" -> "home"
  const pageNs =
    (typeof data.page === "string" && data.page) ||
    (template === "index" ? "home" : "");

  let pageDict: Dict | null = null;
  if (pageNs) {
    pageDict = await tryLoadJson(pageDictFile(pageNs, lang));
  }

  // פונקציית תרגום שנותנת קדימות למילון העמוד
  const t = makePageAwareT(baseT, pageDict);

  // payload שמגיע לכל תבנית + layout
  const payload = {
    ...data,
    user,
    // i18n
    lang,
    dir,
    t,
    // staff context
    staff,
    staffRestaurantId,
    staffMemberships,
  };

  if (wantsJSON(ctx)) {
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify(payload, null, 2);
    return;
  }

  try {
    const html = await eta.renderAsync(template, payload);
    if (typeof html === "string") {
      ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
      ctx.response.body = html;
      return;
    }
    console.warn(`[view] empty render for "${template}". views="${PICKED_VIEWS_DIR}"`);
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(
      String((data as any)?.title ?? template),
      {
        template,
        views: PICKED_VIEWS_DIR,
        candidates: CANDIDATES,
        data,
      },
      lang,
      dir,
    );
  } catch (err) {
    const reqId = (ctx.state as any)?.reqId ?? "-";
    console.warn(
      `[view ${reqId}] render failed for "${template}" (views="${PICKED_VIEWS_DIR}") → fallback:`,
      err,
    );
    const info = {
      message: "תבנית לא נמצאה או נכשלה ברינדור. מוצג fallback.",
      error: String((err as Error)?.message ?? err),
      template,
      views: PICKED_VIEWS_DIR,
      candidates: CANDIDATES,
      data,
    };
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = fallbackHtml(String((data as any)?.title ?? template), info, lang, dir);
  }
}
